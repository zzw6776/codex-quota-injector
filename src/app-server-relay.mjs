#!/usr/bin/env node

import { spawn } from "node:child_process";
import { DEEPSEEK_CANONICAL_MODEL_ID, DEEPSEEK_FLASH_MODEL_IDS, DEEPSEEK_ROUTABLE_MODEL_IDS } from "./deepseek-model-profile.mjs";
import { createHostHealthTracker, watchHostToolReloadRequests } from "./host-health.mjs";
import { startModelCompatibilityProxy } from "./chat-compat-proxy.mjs";
import { ModelRouterManager } from "./model-router.mjs";
import { OPENAI_PROVIDER, RELAY_CLEANUP_INTERVAL_MS, RELAY_OWNERSHIP_POLL_MS, readJson } from "./app-server-relay/contract.mjs";
import { openSidecarUpstream, pipeLines, pipeRaw, runPassthrough, clearRelayEnvironment, forwardSignals, forwardSidecarSignals, exitLikeChild, fail } from "./app-server-relay/transport.mjs";
import { rewriteClientLine } from "./app-server-relay/client-messages.mjs";
import { rewriteServerLine } from "./app-server-relay/server-messages.mjs";
import { requestCodexAppToolsReload } from "./app-server-relay/host-tools.mjs";
import { readOfficialModelSlugs } from "./app-server-relay/model-catalog.mjs";
import { pruneRelayState } from "./app-server-relay/thread-context.mjs";
import { createUsageEventWriter } from "./app-server-relay/usage.mjs";
import { readCustomPlatforms, customProviderEnvKey, customProviderConfig, routerProviderConfig, normalizeRouterConfiguration } from "./app-server-relay/configuration.mjs";
import { resolveRelayPath, resolveNativeWslRelayConfigPath, resolveNativeWindowsRelayConfigPath, resolveNativeWslCodexCli, appendNativeWslDiagnostic } from "./app-server-relay/native-paths.mjs";
import { claimRelayState, currentRelayProcessIdentity, shouldPublishHostState, removeRelayState } from "./app-server-relay/ownership.mjs";

export async function runAppServerRelay() {
  const wslNative = process.env.CODEX_QUOTA_WSL_NATIVE === "1";
  const windowsNative = process.env.CODEX_QUOTA_WINDOWS_NATIVE === "1";
  const configuredRelayPath = String(process.env.CODEX_QUOTA_RELAY_CONFIG ?? "").trim();
  const relayConfigPath = await resolveRelayPath(
    configuredRelayPath || (wslNative
      ? await resolveNativeWslRelayConfigPath()
      : windowsNative
        ? resolveNativeWindowsRelayConfigPath()
        : ""),
  );
  const relayConfig = await readJson(relayConfigPath);
  const nativeWslUpstream = wslNative
    ? String(process.env.CODEX_QUOTA_WSL_UPSTREAM_CODEX_CLI ?? "").trim() ||
      await resolveNativeWslCodexCli()
    : "";
  const upstreamExecutable = await resolveRelayPath(
    nativeWslUpstream || relayConfig?.upstreamExecutable ||
      process.env.CODEX_QUOTA_UPSTREAM_CODEX_CLI || "",
  );
  if (!upstreamExecutable || upstreamExecutable === process.execPath) {
    throw new Error("模型中继配置缺少有效的官方 Codex CLI 路径，或路径指向了中继自身");
  }
  if (wslNative) {
    await appendNativeWslDiagnostic(
      `Starting native SEA relay; executable=${process.execPath}; upstream=${upstreamExecutable}`,
    ).catch((error) => {
      console.error(`[codex-quota-relay] WSL 诊断日志写入失败: ${error.message}`);
    });
  }

  const originalArgs = process.argv.slice(2);
  const appServerIndex = originalArgs.indexOf("app-server");
  if (appServerIndex < 0) {
    await runPassthrough(upstreamExecutable, originalArgs);
    return;
  }
  const publishHostState = shouldPublishHostState(originalArgs, process.env);

  let router = normalizeRouterConfiguration(relayConfig?.router);
  const extraModelSettingsPath = await resolveRelayPath(
    relayConfig?.extraModelSettingsPath ?? process.env.CODEX_QUOTA_EXTRA_MODEL_SETTINGS,
  );
  const extraModelSettings = await readJson(extraModelSettingsPath).catch((error) => {
    console.error(`额外模型本地配置读取失败，已按未配置处理: ${error.message}`);
    return null;
  });
  const customPlatforms = readCustomPlatforms(extraModelSettings);
  const customModelProviders = new Map();
  const customModels = new Map();
  for (const platform of customPlatforms.values()) {
    for (const model of platform.models) {
      customModelProviders.set(model.id, platform.providerId);
      customModels.set(model.id, { ...model, platformName: platform.name });
      if (platform.preset === "deepseek" && model.id === DEEPSEEK_CANONICAL_MODEL_ID) {
        for (const modelId of DEEPSEEK_FLASH_MODEL_IDS) {
          customModelProviders.set(modelId, platform.providerId);
        }
      }
    }
  }
  const tokenUsageEventsPath = await resolveRelayPath(
    relayConfig?.tokenUsageEventsPath ?? process.env.CODEX_QUOTA_TOKEN_USAGE_EVENTS ?? "",
  );
  let localModelRouter = null;
  let localRouterToken = null;
  if (!router && relayConfig?.observeModelTraffic === true) {
    localModelRouter = new ModelRouterManager({
      officialApiBaseUrl: relayConfig?.officialApiBaseUrl || undefined,
      officialCodexBaseUrl: relayConfig?.officialCodexBaseUrl || undefined,
      log: (message) => console.error(message),
    });
    const configured = await localModelRouter.configure({
      extraModels: extraModelSettings,
      officialAuthMode: relayConfig?.officialAuthMode,
      observeOfficial: true,
      usageEventPath: tokenUsageEventsPath,
    });
    if (!configured) throw new Error("本地模型流量观察 Router 未能启动");
    localRouterToken = configured.token;
    router = normalizeRouterConfiguration(configured);
  }
  const catalogPath = await resolveRelayPath(
    relayConfig?.modelCatalogPath ?? process.env.CODEX_QUOTA_MODEL_CATALOG ?? "",
  );
  const officialModels = await readOfficialModelSlugs(catalogPath);
  for (const modelId of DEEPSEEK_ROUTABLE_MODEL_IDS) officialModels.delete(modelId);
  for (const modelId of customModelProviders.keys()) officialModels.delete(modelId);
  // macOS already owns the network-facing compatibility proxy inside the
  // ModelRouter. Starting a second proxy here would bypass its route binding,
  // usage observation and credential boundary.
  const modelCompatibilityProxy = router
    ? null
    : await startModelCompatibilityProxy(customPlatforms);

  const args = [...originalArgs];
  const appServerConfigArgs = [];
  if (router) {
    appServerConfigArgs.push(
      "-c",
      `model_provider=${JSON.stringify(OPENAI_PROVIDER)}`,
      "-c",
      `openai_base_url=${JSON.stringify(router.baseUrl)}`,
      "-c",
      routerProviderConfig(router.providerId, "Codex Quota Router", router),
    );
    const configuredProviderIds = new Set([router.providerId]);
    for (const platform of customPlatforms.values()) {
      if (!platform.enabled) continue;
      appServerConfigArgs.push(
        "-c",
        routerProviderConfig(platform.providerId, platform.name, router),
      );
      configuredProviderIds.add(platform.providerId);
    }
    for (const providerId of router.legacyProviderIds) {
      if (configuredProviderIds.has(providerId)) continue;
      appServerConfigArgs.push(
        "-c",
        routerProviderConfig(providerId, "Codex Quota Router", router),
      );
    }
  } else {
    for (const platform of customPlatforms.values()) {
      if (!platform.enabled) continue;
      appServerConfigArgs.push(
        "-c",
        customProviderConfig(platform, modelCompatibilityProxy?.baseUrlFor(platform)),
      );
    }
  }
  if (catalogPath) {
    appServerConfigArgs.push("-c", `model_catalog_json=${JSON.stringify(catalogPath)}`);
  }
  // Codex 0.150 separates root-level and app-server-level -c values when both
  // sides of the subcommand contain overrides. Keep all relay overrides in the
  // app-server argument scope so later desktop-provided -c values do not hide them.
  args.splice(appServerIndex + 1, 0, ...appServerConfigArgs);

  const env = { ...process.env, CODEX_CLI_PATH: upstreamExecutable };
  delete env.DEEPSEEK_API_KEY;
  for (const key of Object.keys(env)) {
    if (key.startsWith("CODEX_QUOTA_MODEL_") && key.endsWith("_API_KEY")) delete env[key];
  }
  for (const platform of customPlatforms.values()) {
    const envKey = customProviderEnvKey(platform.id);
    if (platform.enabled && !router) env[envKey] = platform.apiKey;
    else delete env[envKey];
  }
  clearRelayEnvironment(env);
  if (localRouterToken && router) env[router.tokenEnv] = localRouterToken;
  delete env.CODEX_APP_SERVER_FORCE_CLI;
  delete env.CODEX_APP_SERVER_WS_URL;
  env.CODEX_CLI_PATH = upstreamExecutable;

  const sidecar = openSidecarUpstream();
  const child = sidecar ? null : spawn(upstreamExecutable, args, {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: process.platform === "win32",
  });
  const upstreamInput = sidecar?.stdin ?? child.stdin;
  const upstreamOutput = sidecar?.stdout ?? child.stdout;
  const statePath = publishHostState
    ? await resolveRelayPath(
        relayConfig?.relayStatePath ?? process.env.CODEX_QUOTA_RELAY_STATE ?? "",
      )
    : "";
  const healthPath = publishHostState
    ? await resolveRelayPath(relayConfig?.hostHealthPath ?? "")
    : "";
  const processIdentity = await currentRelayProcessIdentity(wslNative);
  const usageEventWriter = createUsageEventWriter(
    publishHostState ? tokenUsageEventsPath : "",
  );
  let ownsRuntimeState = false;
  try {
    ownsRuntimeState = await claimRelayState(
      statePath,
      relayConfig?.generation ?? process.env.CODEX_QUOTA_BRIDGE_GENERATION ?? null,
      processIdentity,
    );
  } catch (error) {
    child?.kill();
    sidecar?.close();
    await modelCompatibilityProxy?.close();
    await localModelRouter?.close();
    throw error;
  }
  const hostHealth = publishHostState
    ? await createHostHealthTracker({
        path: healthPath,
        generation: relayConfig?.generation ??
          process.env.CODEX_QUOTA_BRIDGE_GENERATION ?? null,
        runtimeTarget: relayConfig?.runtimeTarget ?? (wslNative
          ? "wsl-native"
          : windowsNative
            ? "windows-native"
            : process.platform === "darwin"
              ? "macos-native"
              : null),
        processIdentity,
        claim: ownsRuntimeState,
      })
    : null;
  let relayCleanupTimer = null;
  let relayOwnershipTimer = null;
  let relayOwnershipCheck = Promise.resolve();
  let hostToolReloadWatcher = null;
  let relayState = null;
  let cleanedUp = false;
  const cleanup = async (detail = null) => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (relayCleanupTimer) clearInterval(relayCleanupTimer);
    relayCleanupTimer = null;
    if (relayOwnershipTimer) clearInterval(relayOwnershipTimer);
    relayOwnershipTimer = null;
    await relayOwnershipCheck.catch(() => undefined);
    hostToolReloadWatcher?.close();
    hostToolReloadWatcher = null;
    if (relayState?.hostToolReloadTimer) clearTimeout(relayState.hostToolReloadTimer);
    await Promise.all([
      removeRelayState(statePath, processIdentity),
      // Relay 状态一旦删除，读取端会立即把宿主能力判为断开。这里不再
      // 追加一次健康文件写入，避免 macOS sidecar 在官方进程退出后与
      // 临时 HOME/正式卸载目录回收竞争；已持久化的具体启动根因仍保留。
      hostHealth?.close({ disconnected: false }),
      usageEventWriter.close(),
      modelCompatibilityProxy?.close(),
      localModelRouter?.close(),
    ]);
  };
  if (child) {
    forwardSignals(child);
    child.once("error", (error) => {
      void (async () => {
        if (wslNative) {
          await appendNativeWslDiagnostic(`Upstream process error: ${error.message}`)
            .catch(() => undefined);
        }
        await cleanup(error.message);
        fail(error);
      })();
    });
    child.once("exit", (code, signal) => {
      void (async () => {
        if (wslNative) {
          await appendNativeWslDiagnostic(
            `Upstream process exited; code=${code ?? "null"}; signal=${signal ?? "null"}`,
          ).catch(() => undefined);
        }
        await cleanup(`官方 app-server 已退出（code=${code ?? "null"}, signal=${signal ?? "null"}）`);
        exitLikeChild(code, signal);
      })();
    });
  } else {
    forwardSidecarSignals(cleanup);
    upstreamOutput.once("end", () => {
      void cleanup("官方 app-server 输出已关闭").then(() => {
        if (process.stdout.writableFinished) process.exit(0);
        else process.stdout.once("finish", () => process.exit(0));
      });
    });
  }
  process.once("exit", () => void cleanup());

  const pendingRequests = new Map();
  const threadContexts = new Map();
  const turnModels = new Map();
  relayState = {
    officialModels,
    customPlatforms,
    customModelProviders,
    customModels,
    pendingRequests,
    threadContexts,
    turnModels,
    modelRevision: 0,
    modelListStatus: null,
    emitUsageEvent: usageEventWriter.write,
    hostHealth,
    sendUpstream(message) {
      upstreamInput.write(`${JSON.stringify(message)}\n`);
    },
    hostToolReloadInFlight: false,
    hostToolReloadTimer: null,
  };
  hostToolReloadWatcher = watchHostToolReloadRequests({
    healthPath,
    generation: relayConfig?.generation ??
      process.env.CODEX_QUOTA_BRIDGE_GENERATION ?? null,
  }, {
    onRequest: () => requestCodexAppToolsReload(relayState),
    onError: (error) => {
      console.error(`[host-health] 重载请求监听失败：${error.message}`);
    },
  });
  relayCleanupTimer = setInterval(() => pruneRelayState(relayState), RELAY_CLEANUP_INTERVAL_MS);
  relayCleanupTimer.unref?.();
  if (!sidecar && statePath) {
    relayOwnershipTimer = setInterval(() => {
      relayOwnershipCheck = relayOwnershipCheck.then(async () => {
        if (cleanedUp) return;
        const claimed = await claimRelayState(
          statePath,
          relayConfig?.generation ?? process.env.CODEX_QUOTA_BRIDGE_GENERATION ?? null,
          processIdentity,
        );
        if (claimed && !ownsRuntimeState) await hostHealth.claim();
        ownsRuntimeState = claimed;
      }).catch((error) => {
        console.error(`模型中继状态所有权检查失败: ${error.message}`);
      });
    }, RELAY_OWNERSHIP_POLL_MS);
    relayOwnershipTimer.unref?.();
  }
  pipeLines(process.stdin, upstreamInput, (line) => rewriteClientLine(line, relayState));
  pipeLines(upstreamOutput, process.stdout, (line) => rewriteServerLine(line, relayState));
  if (child) pipeRaw(child.stderr, process.stderr);
}

export { shouldPublishHostState } from "./app-server-relay/ownership.mjs";
