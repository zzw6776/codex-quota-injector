#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, mkdir, readFile, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import {
  canonicalDeepSeekModelId,
  DEEPSEEK_CANONICAL_MODEL_ID,
  DEEPSEEK_FLASH_MODEL_IDS,
  DEEPSEEK_ROUTABLE_MODEL_IDS,
  isDeepSeekRoutableModel,
} from "./deepseek-model-profile.mjs";
import {
  createHostHealthTracker,
  isMcpStatusListMethod,
  watchHostToolReloadRequests,
} from "./host-health.mjs";
import { RELAY_PROTOCOL_VERSION, RELAY_STATE_VERSION } from "./relay-contract.mjs";
import { startModelCompatibilityProxy } from "./chat-compat-proxy.mjs";
import { ModelRouterManager } from "./model-router.mjs";
import { MODEL_CAPABILITY_PROBE_VERSION } from "./model-capability-probe.mjs";

const OPENAI_PROVIDER = "openai";
const CUSTOM_PROVIDER_PREFIX = "custom_";
const THREAD_METHODS = new Set(["thread/start", "thread/resume", "thread/fork"]);
const THREAD_SETTINGS_METHOD = "thread/settings/update";
const MODEL_LIST_METHOD = "model/list";
const OBSERVED_THREAD_METHODS = new Set([
  ...THREAD_METHODS,
  "thread/read",
  "thread/list",
  THREAD_SETTINGS_METHOD,
]);
const TURN_INPUT_METHODS = new Set(["turn/start", "turn/steer"]);
const ALLOWED_CUSTOM_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);
const CUSTOM_REASONING_DESCRIPTIONS = {
  none: "No additional reasoning",
  low: "Fast responses with lighter reasoning",
  medium: "Balanced reasoning for everyday tasks",
  high: "Deeper reasoning for complex problems",
  xhigh: "Extra-high reasoning depth for harder problems",
  max: "Maximum reasoning depth for the hardest problems",
};
const PENDING_REQUEST_TTL_MS = 2 * 60 * 1000;
const TURN_MODEL_TTL_MS = 15 * 60 * 1000;
const THREAD_CONTEXT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RELAY_CLEANUP_INTERVAL_MS = 60 * 1000;
const RELAY_OWNERSHIP_POLL_MS = 1_000;
const RELAY_STATE_LOCK_RETRY_MS = 25;
const RELAY_STATE_LOCK_TIMEOUT_MS = 5_000;
const RELAY_STATE_LOCK_STALE_MS = 10_000;
const HOST_TOOL_RELOAD_TIMEOUT_MS = 15_000;
const MCP_CONFIG_RELOAD_METHOD = "config/mcpServer/reload";
const MCP_STATUS_LIST_METHOD = "mcpServerStatus/list";
const SIDECAR_MODE_ENV = "CODEX_QUOTA_APP_SERVER_SIDECAR";
const SIDECAR_UPSTREAM_STDIN_FD_ENV = "CODEX_QUOTA_UPSTREAM_STDIN_FD";
const SIDECAR_UPSTREAM_STDOUT_FD_ENV = "CODEX_QUOTA_UPSTREAM_STDOUT_FD";
const PRIMARY_APP_SERVER_ENV = "CODEX_QUOTA_PRIMARY_APP_SERVER";
const execFileAsync = promisify(execFile);

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

function openSidecarUpstream() {
  if (process.env[SIDECAR_MODE_ENV] !== "1") return null;
  if (process.platform !== "darwin") {
    throw new Error("app-server 中继 sidecar 仅支持 macOS");
  }
  const stdinFd = inheritedDescriptor(SIDECAR_UPSTREAM_STDIN_FD_ENV);
  const stdoutFd = inheritedDescriptor(SIDECAR_UPSTREAM_STDOUT_FD_ENV);
  if (stdinFd === stdoutFd) throw new Error("app-server 中继 sidecar 管道描述符重复");
  const stdin = createWriteStream(null, { fd: stdinFd, autoClose: true });
  const stdout = createReadStream(null, { fd: stdoutFd, autoClose: true });
  return {
    stdin,
    stdout,
    close() {
      stdin.destroy();
      stdout.destroy();
    },
  };
}

function inheritedDescriptor(name) {
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value < 3) {
    throw new Error(`app-server 中继 sidecar 缺少有效的 ${name}`);
  }
  return value;
}

function rewriteClientLine(line, state) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return line;
  }
  if (!message || typeof message !== "object") return line;

  state.hostHealth?.observeClientMessage(message);

  const method = message.method;
  const params = message.params && typeof message.params === "object"
    ? { ...message.params }
    : {};
  if (isMcpStatusListMethod(method)) {
    if (message.id != null) rememberPendingRequest(state, message.id, { method, threadId: params.threadId ?? null });
    return line;
  }
  if (method === MODEL_LIST_METHOD) {
    if (message.id != null) {
      rememberPendingRequest(state, message.id, {
        method,
        cursor: params.cursor ?? null,
      });
    }
    return line;
  }
  if (!OBSERVED_THREAD_METHODS.has(method) && !TURN_INPUT_METHODS.has(method)) return line;
  const requestRevision = nextModelRevision(state);

  if (method === THREAD_SETTINGS_METHOD) {
    const configuredModel = readModelSetting(
      params.threadSettings ?? params.thread_settings ?? params,
    );
    const previousContext = params.threadId
      ? cloneThreadContext(getThreadContext(state.threadContexts, params.threadId))
      : null;
    if (params.threadId && configuredModel.present) {
      updateThreadContext(state.threadContexts, params.threadId, {
        model: configuredModel.model,
        modelPresent: true,
        source: "thread-settings",
        revision: requestRevision,
      });
    }
    if (message.id != null) {
      rememberPendingRequest(state, message.id, {
        method,
        provider: null,
        threadId: params.threadId ?? null,
        model: configuredModel.present ? configuredModel.model : null,
        modelSource: "thread-settings",
        modelRevision: requestRevision,
        previousContext,
      });
    }
    return JSON.stringify({ ...message, params });
  }

  if (!THREAD_METHODS.has(method) && !TURN_INPUT_METHODS.has(method)) {
    if (message.id != null) {
      rememberPendingRequest(state, message.id, {
        method,
        provider: null,
        threadId: params.threadId ?? null,
        model: null,
        modelSource: "thread",
        modelRevision: requestRevision,
      });
    }
    return line;
  }
  const threadContext = getThreadContext(state.threadContexts, params.threadId);
  const previousContext = params.threadId ? cloneThreadContext(threadContext) : null;
  const requestModel = readModelSetting(params);
  let requestedModel = requestModel.present ? requestModel.model : threadContext?.model ?? null;
  let provider = providerForModel(requestedModel, state) ??
    threadContext?.provider ?? null;
  let routedCustomPlatform = customPlatformForProvider(provider, state);
  let routedDeepSeekModel = deepSeekRouteModel(requestedModel, routedCustomPlatform);
  if (routedDeepSeekModel) requestedModel = routedDeepSeekModel;

  if (THREAD_METHODS.has(method)) {
    const customPlatform = routedCustomPlatform;
    if (isCustomProvider(provider) && !customPlatform?.enabled) {
      return jsonRpcError(message.id, "该额外模型平台尚未启用或 API Key 为空");
    }
    if (provider) params.modelProvider = provider;
    if (routedDeepSeekModel) {
      params.model = routedDeepSeekModel;
    } else if (!normalizedModel(params.model) && requestedModel) {
      params.model = requestedModel;
    }
    if (customPlatform?.enabled) {
      params.config = customThreadConfig(params.config, state.customModels.get(requestedModel));
    }
  }

  if (TURN_INPUT_METHODS.has(method)) {
    const knownProvider = threadContext?.provider ?? null;
    provider ??= knownProvider;
    routedCustomPlatform = customPlatformForProvider(provider, state);
    routedDeepSeekModel = deepSeekRouteModel(requestedModel, routedCustomPlatform);
    if (routedDeepSeekModel) requestedModel = routedDeepSeekModel;
    if (method === "turn/start" && knownProvider && provider && knownProvider !== provider) {
      return jsonRpcError(message.id, "同一任务不能切换模型供应商；请新建任务后再选择目标模型");
    }
    if (routedDeepSeekModel) {
      params.model = routedDeepSeekModel;
    } else if (!normalizedModel(params.model) && requestedModel) {
      params.model = requestedModel;
    }
    const customPlatform = routedCustomPlatform;
    if (isCustomProvider(provider)) {
      if (!customPlatform?.enabled) {
        return jsonRpcError(message.id, "该额外模型平台尚未启用或 API Key 为空");
      }
      const selectedModel = state.customModels.get(requestedModel ?? threadContext?.model);
      if (containsImageInput(params.input) && !selectedModel?.supportsImage) {
        return jsonRpcError(message.id, "该模型的自动检测结果不支持图片输入");
      }
      if (method === "turn/start") {
        if (selectedModel?.reasoningEfforts.length) {
          if (params.effort != null && !selectedModel.reasoningEfforts.includes(params.effort)) {
            return jsonRpcError(
              message.id,
              `${selectedModel.displayName} 的推理深度仅支持 ${selectedModel.reasoningEfforts.join("、")}`,
            );
          }
          params.effort ??= selectedModel.defaultReasoningEffort;
        } else {
          delete params.effort;
        }
        delete params.summary;
        delete params.serviceTier;
      }
    }
    if (method === "turn/start" && params.threadId) {
      if (requestModel.present) {
        updateThreadContext(state.threadContexts, params.threadId, {
          model: requestedModel,
          modelPresent: true,
          source: "turn-request",
          revision: requestRevision,
        });
      }
      state.emitUsageEvent({
        type: "thread-active",
        threadId: params.threadId,
        model: requestedModel,
        modelSource: requestModel.present ? "turn-request" : threadContext?.source ?? "thread",
      });
    }
  }

  if (method === "thread/resume" && params.threadId) {
    if (requestModel.present) {
      updateThreadContext(state.threadContexts, params.threadId, {
        model: requestedModel,
        modelPresent: true,
        source: "thread-request",
        revision: requestRevision,
      });
    }
    state.emitUsageEvent({
      type: "thread-active",
      threadId: params.threadId,
      model: requestedModel,
      modelSource: requestModel.present ? "thread-request" : threadContext?.source ?? "thread",
    });
  }

  if (message.id != null && (THREAD_METHODS.has(method) || method === "turn/start")) {
    rememberPendingRequest(state, message.id, {
      method,
      provider,
      threadId: params.threadId,
      model: requestedModel,
      modelSource: requestModel.present
        ? "turn-request"
        : threadContext?.source ?? "thread",
      modelRevision: requestRevision,
      previousContext: requestModel.present ? previousContext : null,
    });
  }
  return JSON.stringify({ ...message, params });
}

function rewriteServerLine(line, state) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return line;
  }
  state.hostHealth?.observeServerMessage(message);
  learnThreadContexts(message?.params, state, {
    source: "thread-discovery",
    revision: 0,
  });
  captureUsageNotification(message, state);
  // Server-initiated approvals/tools have their own ID space. Only responses
  // can complete a client request; preserve numeric versus string IDs as well.
  if (message?.id == null || typeof message.method === "string" ||
    (!Object.hasOwn(message, "result") && !Object.hasOwn(message, "error"))) return line;
  const pending = state.pendingRequests.get(message.id);
  if (!pending) return line;
  state.pendingRequests.delete(message.id);
  if (pending.internalHostToolReload) {
    handleHostToolReloadResponse(message, pending, state);
    return "";
  }
  if (isMcpStatusListMethod(pending.method)) {
    state.hostHealth?.observeStatusList(message.result, message.error, pending);
    return line;
  }
  if (message.error) {
    restoreThreadContext(
      state.threadContexts,
      pending.threadId,
      pending.previousContext,
      pending.modelRevision,
    );
    return line;
  }
  if (pending.method === MODEL_LIST_METHOD) {
    return rewriteModelListResponse(line, message, state, pending);
  }
  const result = message?.result;
  const thread = result?.thread ?? result;
  const threadId = thread?.id ?? pending.threadId;
  const reportedProvider = normalizedModel(result?.modelProvider) ??
    normalizedModel(thread?.modelProvider);
  // thread/start, thread/resume and thread/fork return the selected model at
  // the response envelope level, while the nested Thread object does not.
  const responseModel = normalizedModel(result?.model) ?? normalizedModel(thread?.model);
  const responseProvider = providerForModel(responseModel, state) ?? reportedProvider;
  const responseConflictsWithRequest = Boolean(
    pending.provider && responseProvider && pending.provider !== responseProvider,
  );
  const model = pending.model &&
    (isExtensionProvider(pending.provider) || responseConflictsWithRequest)
    ? pending.model
    : responseModel ?? pending.model;
  // Some app-server paths report their configured default provider (`openai`)
  // even when the selected catalog model belongs to an explicitly injected
  // provider. The catalog mapping is unambiguous after conflict filtering and
  // must win, otherwise a fork is falsely rejected as a provider switch.
  const provider = responseConflictsWithRequest
    ? pending.provider
    : providerForModel(model, state) ?? reportedProvider ?? pending.provider;
  if (threadId && (provider || model)) {
    updateThreadContext(state.threadContexts, threadId, {
      model,
      modelPresent: Boolean(model),
      provider,
      providerPresent: Boolean(provider),
      source: "thread-response",
      revision: pending.modelRevision ?? 0,
    });
  }
  learnThreadContexts(message?.result, state, {
    source: "thread-response",
    revision: pending.modelRevision ?? 0,
  });
  const resolvedTurnModel = model;
  if (pending.method === "turn/start" && result?.turn?.id && resolvedTurnModel) {
    rememberTurnModel(state, result.turn.id, {
      model: resolvedTurnModel,
      source: responseModel ? "turn-response" : pending.modelSource ?? "thread",
    });
  }
  if (threadId && THREAD_METHODS.has(pending.method)) {
    state.emitUsageEvent({
      type: "thread-active",
      threadId,
      model,
      modelSource: "thread-response",
    });
  }
  return line;
}

function requestCodexAppToolsReload(state) {
  if (state.hostToolReloadInFlight) return;
  state.hostToolReloadInFlight = true;
  state.hostHealth?.observeReloadStarted();
  sendHostToolReloadRequest(state, MCP_CONFIG_RELOAD_METHOD, "reload");
}

function sendHostToolReloadRequest(state, method, phase) {
  const id = `codex-quota-host-tools-${phase}-${randomUUID()}`;
  rememberPendingRequest(state, id, {
    method,
    internalHostToolReload: true,
    phase,
  });
  try {
    // The official schema models config/mcpServer/reload as a unit request,
    // while mcpServerStatus/list requires an object even when all fields use
    // defaults. Keep both requests schema-exact for stricter app-server builds.
    state.sendUpstream(method === MCP_CONFIG_RELOAD_METHOD
      ? { id, method }
      : { id, method, params: {} });
  } catch (error) {
    state.pendingRequests.delete(id);
    state.hostHealth?.observeReloadFailed(error);
    finishHostToolReload(state);
    return;
  }
  clearTimeout(state.hostToolReloadTimer);
  state.hostToolReloadTimer = setTimeout(() => {
    const pending = state.pendingRequests.get(id);
    if (pending) pending.expired = true;
    state.hostHealth?.observeReloadFailed(new Error("官方 app-server 重载任务工具超时"));
    finishHostToolReload(state);
  }, HOST_TOOL_RELOAD_TIMEOUT_MS);
  state.hostToolReloadTimer.unref?.();
}

function handleHostToolReloadResponse(message, pending, state) {
  if (pending.expired) return;
  clearTimeout(state.hostToolReloadTimer);
  state.hostToolReloadTimer = null;
  if (message.error) {
    state.hostHealth?.observeReloadFailed(message.error);
    finishHostToolReload(state);
    return;
  }
  if (pending.phase === "reload") {
    sendHostToolReloadRequest(state, MCP_STATUS_LIST_METHOD, "verify");
    return;
  }
  state.hostHealth?.observeStatusList(message.result, message.error);
  finishHostToolReload(state);
}

function finishHostToolReload(state) {
  clearTimeout(state.hostToolReloadTimer);
  state.hostToolReloadTimer = null;
  state.hostToolReloadInFlight = false;
}

function rewriteModelListResponse(line, message, state, pending) {
  const models = message?.result?.data;
  if (!Array.isArray(models)) {
    reportModelListStatus(state, "invalid", "model/list 返回格式无法识别，未修改响应");
    return line;
  }

  if (pending.cursor != null && String(pending.cursor).trim()) return line;
  const customModelIds = new Set(state.customModels.keys());
  const existingCustomModels = new Map();
  const baseModels = [];
  for (const model of models) {
    const modelId = normalizedModel(model?.id) ?? normalizedModel(model?.model);
    if (customModelIds.has(modelId)) existingCustomModels.set(modelId, model);
    else if (isDeepSeekRoutableModel(modelId)) continue;
    else baseModels.push(model);
  }
  let additions = 0;
  const orderedCustomModels = [];
  for (const platform of state.customPlatforms.values()) {
    if (!platform.enabled) continue;
    for (const model of platform.models) {
      const existing = existingCustomModels.get(model.id);
      const declared = createCustomAppServerModel(platform, model);
      orderedCustomModels.push(existing ? { ...existing, ...declared } : declared);
      if (!existing) additions += 1;
    }
  }
  const orderedModels = [...baseModels, ...orderedCustomModels];
  const orderChanged = orderedModels.length !== models.length ||
    orderedModels.some((model, index) => model !== models[index]);
  if (additions === 0 && !orderChanged) {
    reportModelListStatus(state, "present", "已启用的扩展模型均存在，且位于官方模型之后");
    return line;
  }
  reportModelListStatus(
    state,
    additions > 0 ? "injected" : "sorted",
    additions > 0
      ? `model/list 缺少 ${additions} 个扩展模型，已补齐并置于官方模型之后`
      : "已将自定义模型移动到官方模型之后",
  );
  return JSON.stringify({
    ...message,
    result: {
      ...message.result,
      data: orderedModels,
    },
  });
}

function createCustomAppServerModel(platform, model) {
  return {
    id: model.id,
    model: model.id,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: model.displayName,
    description: `${platform.name} · Responses API`,
    hidden: false,
    supportedReasoningEfforts: model.reasoningEfforts.map((reasoningEffort) => ({
      reasoningEffort,
      description: CUSTOM_REASONING_DESCRIPTIONS[reasoningEffort],
    })),
    defaultReasoningEffort: model.defaultReasoningEffort || "low",
    inputModalities: model.supportsImage ? ["text", "image"] : ["text"],
    supportsPersonality: true,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: false,
  };
}

function reportModelListStatus(state, status, message) {
  if (state.modelListStatus === status) return;
  state.modelListStatus = status;
  console.error(`[codex-quota-relay] ${message}`);
}

function learnThreadContexts(value, state, { source, revision }) {
  if (!value || typeof value !== "object") return;
  const candidates = [
    value,
    value.thread,
    ...(Array.isArray(value.data) ? value.data : []),
  ].filter(Boolean);
  if (value.thread?.id && value.model) {
    candidates.push({ id: value.thread.id, model: value.model });
  }
  if (value.threadId && (value.model || value.modelProvider)) {
    candidates.push({
      id: value.threadId,
      model: value.model,
      modelProvider: value.modelProvider,
    });
  }
  for (const thread of candidates) {
    const configuredModel = readModelSetting(thread?.threadSettings ?? thread?.thread_settings);
    const model = normalizedModel(thread?.model) ?? configuredModel.model;
    const reportedProvider = normalizedModel(thread?.modelProvider);
    const threadId = thread?.id ?? thread?.threadId;
    const provider = providerForModel(model, state) ?? reportedProvider;
    if (threadId && (model || provider)) {
      updateThreadContext(state.threadContexts, threadId, {
        model,
        modelPresent: Boolean(model),
        provider,
        providerPresent: Boolean(provider),
        source,
        revision,
      });
    }
  }
}

function captureUsageNotification(message, state) {
  const method = message?.method;
  const params = message?.params;
  if (!params || typeof params !== "object") return;
  const configuredModel = readModelSetting(params.threadSettings ?? params);
  if (method === "thread/settings/updated" && params.threadId && configuredModel.present) {
    updateThreadContext(state.threadContexts, params.threadId, {
      model: configuredModel.model,
      modelPresent: true,
      source: "thread-settings",
      revision: nextModelRevision(state),
    });
    return;
  }
  if (method === "turn/started" && params.threadId && params.turn?.id) {
    const turnId = String(params.turn.id);
    const resolved = resolveTurnModel(state, params.threadId, turnId, params);
    const model = resolved.model;
    const source = resolved.explicit ? "turn-started" : resolved.source;
    if (model) rememberTurnModel(state, turnId, { model, source });
    state.emitUsageEvent({
      type: "turn-started",
      threadId: params.threadId,
      turnId,
      model,
      modelSource: source,
    });
    return;
  }
  if (method === "model/rerouted" && params.threadId) {
    const model = normalizedModel(params.toModel);
    const turnId = params.turnId ?? params.turn?.id;
    if (model && turnId) {
      rememberTurnModel(state, turnId, { model, source: "rerouted" });
    }
    return;
  }
  if (method === "thread/tokenUsage/updated" && params.threadId && params.turnId) {
    const resolved = resolveTurnModel(state, params.threadId, params.turnId, params);
    state.emitUsageEvent({
      type: "usage",
      threadId: params.threadId,
      turnId: params.turnId,
      model: resolved.model,
      modelSource: resolved.explicit ? "usage" : resolved.source,
      tokenUsage: params.tokenUsage,
    });
    return;
  }
  if (method === "turn/completed" && params.threadId && params.turn?.id) {
    const turnId = String(params.turn.id);
    const resolved = resolveTurnModel(state, params.threadId, turnId, params);
    state.emitUsageEvent({
      type: "turn-completed",
      threadId: params.threadId,
      turnId,
      model: resolved.model,
      modelSource: resolved.explicit ? "completed" : resolved.source,
      status: params.turn.status ?? null,
    });
    state.turnModels.delete(turnId);
    return;
  }
  if (method === "turn/aborted" && params.threadId) {
    const turnId = params.turnId ?? params.turn?.id;
    if (!turnId) return;
    const resolved = resolveTurnModel(state, params.threadId, turnId, params);
    state.emitUsageEvent({
      type: "turn-completed",
      threadId: params.threadId,
      turnId: String(turnId),
      model: resolved.model,
      modelSource: resolved.explicit ? "completed" : resolved.source,
      status: params.reason === "interrupted" ? "interrupted" : "failed",
    });
    state.turnModels.delete(String(turnId));
  }
}

function readModelSetting(value) {
  if (!value || typeof value !== "object") return { present: false, model: null };
  const directModel = normalizedModel(value.model);
  if (directModel) return { present: true, model: directModel };
  const nestedSettings = value.threadSettings ?? value.thread_settings;
  if (nestedSettings && nestedSettings !== value) {
    const nestedModel = readModelSetting(nestedSettings);
    if (nestedModel.present) return nestedModel;
  }
  const collaborationSettings = value.collaborationMode?.settings;
  const collaborationModel = normalizedModel(collaborationSettings?.model);
  if (collaborationModel) return { present: true, model: collaborationModel };
  // A null/empty model is a placeholder meaning that the caller did not
  // override the thread model. It must not erase an already known context.
  return { present: false, model: null };
}

function getThreadContext(threadContexts, threadId) {
  if (!threadId) return null;
  const context = threadContexts.get(String(threadId)) ?? null;
  if (context) context.lastSeenAt = Date.now();
  return context;
}

function cloneThreadContext(context) {
  return context ? { ...context } : null;
}

function restoreThreadContext(threadContexts, threadId, previousContext, revision) {
  if (!threadId) return;
  const key = String(threadId);
  const current = getThreadContext(threadContexts, key);
  if (!current || current.revision !== revision) return;
  if (previousContext) threadContexts.set(key, { ...previousContext, lastSeenAt: Date.now() });
  else threadContexts.delete(key);
}

function updateThreadContext(
  threadContexts,
  threadId,
  {
    model,
    modelPresent = false,
    provider,
    providerPresent = false,
    source = "thread",
    revision = 0,
  } = {},
) {
  if (!threadId || (!modelPresent && !providerPresent)) return false;
  const key = String(threadId);
  const current = getThreadContext(threadContexts, key);
  const nextRevision = Number.isInteger(revision) ? revision : 0;
  if (current && nextRevision < current.revision) return false;
  if (current && source === "thread-response" &&
    current.source === "thread-response" && nextRevision === current.revision &&
    ((modelPresent && current.model) || (providerPresent && current.provider))) {
    return false;
  }
  // Discovery from thread/read or thread/list is only a bootstrap fallback.
  // It may fill a missing field, but it must never replace a value learned
  // from an ordered request/response.
  if (source === "thread-discovery" && current &&
    ((modelPresent && current.model) || (providerPresent && current.provider))) {
    return false;
  }
  const next = {
    model: current?.model ?? null,
    provider: current?.provider ?? null,
    source,
    revision: Math.max(nextRevision, current?.revision ?? 0),
    lastSeenAt: Date.now(),
  };
  if (modelPresent) next.model = normalizedModel(model);
  if (providerPresent) next.provider = normalizedModel(provider);
  threadContexts.set(key, next);
  return true;
}

function resolveTurnModel(state, threadId, turnId, value) {
  const tracked = turnId ? state.turnModels.get(String(turnId)) : null;
  if (tracked) tracked.lastSeenAt = Date.now();
  const threadContext = getThreadContext(state.threadContexts, threadId);
  const setting = readModelSetting(value);
  // Usage notifications may carry a null placeholder when the model is not
  // included. Treat that as absent so the per-turn/ thread fallback survives.
  const explicit = setting.present && setting.model
    ? setting
    : { present: false, model: null };
  return {
    model: explicit.present
      ? explicit.model
      : tracked?.model ?? threadContext?.model ?? null,
    explicit: explicit.present,
    source: explicit.present
      ? "event"
      : tracked?.source ?? threadContext?.source ?? "thread",
  };
}

function rememberPendingRequest(state, requestId, value) {
  state.pendingRequests.set(requestId, {
    ...value,
    createdAt: Date.now(),
  });
}

function rememberTurnModel(state, turnId, value) {
  state.turnModels.set(String(turnId), {
    ...value,
    lastSeenAt: Date.now(),
  });
}

function pruneRelayState(state) {
  const now = Date.now();
  for (const [requestId, request] of state.pendingRequests) {
    if (now - Number(request.createdAt || 0) > PENDING_REQUEST_TTL_MS) {
      state.pendingRequests.delete(requestId);
    }
  }
  for (const [threadId, context] of state.threadContexts) {
    if (now - Number(context.lastSeenAt || 0) > THREAD_CONTEXT_TTL_MS) {
      state.threadContexts.delete(threadId);
    }
  }
  for (const [turnId, model] of state.turnModels) {
    if (now - Number(model.lastSeenAt || 0) > TURN_MODEL_TTL_MS) {
      state.turnModels.delete(turnId);
    }
  }
}

function nextModelRevision(state) {
  state.modelRevision += 1;
  return state.modelRevision;
}

function normalizedModel(value) {
  const model = String(value ?? "").trim();
  return model || null;
}

function providerForModel(model, state) {
  if (typeof model === "string" && state.customModelProviders.has(model)) {
    return state.customModelProviders.get(model);
  }
  if (typeof model === "string" && state.officialModels.has(model)) return OPENAI_PROVIDER;
  return null;
}

function deepSeekRouteModel(model, customPlatform) {
  if (customPlatform?.preset !== "deepseek") return null;
  return canonicalDeepSeekModelId(normalizedModel(model) ?? DEEPSEEK_CANONICAL_MODEL_ID);
}

function customThreadConfig(config, model) {
  const next = { ...(config && typeof config === "object" ? config : {}) };
  next.disable_response_storage = true;
  if (model?.reasoningEfforts.length) {
    if (!model.reasoningEfforts.includes(next.model_reasoning_effort)) {
      next.model_reasoning_effort = model.defaultReasoningEffort;
    }
  } else {
    delete next.model_reasoning_effort;
  }
  delete next.model_reasoning_summary;
  delete next.service_tier;
  return next;
}

function isCustomProvider(provider) {
  return typeof provider === "string" && provider.startsWith(CUSTOM_PROVIDER_PREFIX);
}

function isExtensionProvider(provider) {
  return isCustomProvider(provider);
}

function customPlatformForProvider(provider, state) {
  return isCustomProvider(provider) ? state.customPlatforms.get(provider) ?? null : null;
}

function readCustomPlatforms(settings) {
  const platforms = new Map();
  for (const value of Array.isArray(settings?.platforms) ? settings.platforms : []) {
    const id = String(value?.id ?? "").trim();
    if (!id) continue;
    const providerId = customProviderId(id);
    const models = Array.isArray(value?.models)
      ? value.models.filter((model) => model?.selected !== false).map((model) => {
          const compatibility = model?.compatibility && typeof model.compatibility === "object"
            ? model.compatibility
            : null;
          const currentCompatibility = compatibility?.status === "verified" &&
            compatibility?.probeVersion === MODEL_CAPABILITY_PROBE_VERSION;
          const protocol = ["responses", "chat"].includes(compatibility?.protocol)
            ? compatibility.protocol
            : model?.chatCompatibility ? "chat" : "responses";
          return {
            id: String(model?.id ?? "").trim(),
            displayName: String(model?.displayName ?? model?.id ?? "").trim(),
            supportsImage: currentCompatibility
              ? compatibility?.supportsImage === true
              : !compatibility && Boolean(model?.supportsImage),
            chatCompatibility: protocol === "chat",
            routes: {
              default: protocol,
              imageInput: currentCompatibility &&
                ["responses", "chat"].includes(compatibility?.routes?.imageInput)
                ? compatibility.routes.imageInput
                : protocol,
            },
            historyMode: protocol === "chat"
              ? "chat"
              : compatibility?.historyMode === "reasoning-text-only"
                ? "reasoning-text-only"
                : "responses-full",
            capabilities: currentCompatibility
              ? normalizeRelayCapabilities(compatibility.capabilities)
              : null,
            reasoningEfforts: Array.isArray(model?.reasoningEfforts)
              ? [...new Set(model.reasoningEfforts
                  .map((effort) => String(effort ?? "").trim())
                  .filter((effort) => ALLOWED_CUSTOM_EFFORTS.has(effort)))]
              : [],
            defaultReasoningEffort: String(model?.defaultReasoningEffort ?? "").trim(),
          };
        }).filter((model) => model.id)
      : [];
    for (const model of models) {
      if (!model.reasoningEfforts.includes(model.defaultReasoningEffort)) {
        model.defaultReasoningEffort = model.reasoningEfforts[0] ?? "";
      }
    }
    platforms.set(providerId, {
      id,
      providerId,
      preset: value?.preset === "deepseek" ? "deepseek" : null,
      name: String(value?.name ?? providerId).trim() || providerId,
      baseUrl: String(value?.baseUrl ?? "").trim(),
      apiKey: String(value?.apiKey ?? "").trim(),
      enabled: Boolean(value?.enabled && value?.apiKey && value?.baseUrl && models.length),
      models,
    });
  }
  return platforms;
}

function normalizeRelayCapabilities(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    ...value,
    transport: value.transport && typeof value.transport === "object"
      ? { ...value.transport }
      : null,
    hostedTools: value.hostedTools && typeof value.hostedTools === "object"
      ? { ...value.hostedTools }
      : {},
    nativeCustomTools: Array.isArray(value.nativeCustomTools)
      ? [...value.nativeCustomTools]
      : [],
  };
}

function customProviderId(id) {
  return `${CUSTOM_PROVIDER_PREFIX}${String(id).replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}`;
}

function customProviderEnvKey(id) {
  return `CODEX_QUOTA_MODEL_${String(id).replace(/[^a-zA-Z0-9]/g, "").toUpperCase()}_API_KEY`;
}

function customProviderConfig(platform, baseUrl = platform.baseUrl) {
  return `model_providers.${platform.providerId}={` +
    `name=${JSON.stringify(platform.name)},` +
    `base_url=${JSON.stringify(baseUrl)},` +
    `env_key=${JSON.stringify(customProviderEnvKey(platform.id))},` +
    `wire_api="responses"}`;
}

function routerProviderConfig(providerId, name, router) {
  return `model_providers.${providerId}={` +
    `name=${JSON.stringify(name)},` +
    `base_url=${JSON.stringify(router.baseUrl)},` +
    `requires_openai_auth=true,` +
    `wire_api="responses",` +
    `supports_websockets=false,` +
    `env_http_headers={` +
      `${JSON.stringify(router.tokenHeader)}=${JSON.stringify(router.tokenEnv)}` +
    `}}`;
}

function normalizeRouterConfiguration(value) {
  if (value == null) return null;
  const providerId = String(value.providerId ?? "").trim();
  const baseUrl = String(value.baseUrl ?? "").trim();
  const tokenEnv = String(value.tokenEnv ?? "").trim();
  const tokenHeader = String(value.tokenHeader ?? "").trim().toLowerCase();
  const legacyProviderIds = [...new Set(
    (Array.isArray(value.legacyProviderIds) ? value.legacyProviderIds : [])
      .map((provider) => String(provider ?? "").trim())
      .filter(Boolean),
  )];
  const providerIds = [providerId, ...legacyProviderIds];
  if (!providerIds.every((provider) => /^[A-Za-z0-9_-]+$/.test(provider))) {
    throw new Error("模型 Router 配置中的供应商 ID 不安全");
  }
  if (!/^[A-Z][A-Z0-9_]*$/.test(tokenEnv)) {
    throw new Error("模型 Router 配置中的 Token 环境变量名不安全");
  }
  if (!/^[a-z0-9-]+$/.test(tokenHeader)) {
    throw new Error("模型 Router 配置中的 Token 请求头名称不安全");
  }
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("模型 Router 配置中的地址无效");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("模型 Router 配置中的地址协议或凭据无效");
  }
  return {
    providerId,
    baseUrl: parsed.toString(),
    tokenEnv,
    tokenHeader,
    legacyProviderIds,
  };
}

function containsImageInput(value) {
  if (Array.isArray(value)) return value.some(containsImageInput);
  if (!value || typeof value !== "object") return false;
  if (["image", "localImage", "input_image", "image_url"].includes(value.type)) return true;
  return Object.values(value).some(containsImageInput);
}

function jsonRpcError(id, message) {
  if (id == null) return "";
  return {
    directOutput: JSON.stringify({
      id,
      error: { code: -32602, message },
    }),
  };
}

function pipeLines(input, output, transform) {
  input.setEncoding("utf8");
  let pending = "";
  input.on("data", (chunk) => {
    pending += chunk;
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const line = pending.slice(0, newline).replace(/\r$/, "");
      pending = pending.slice(newline + 1);
      const transformed = transform(line);
      if (transformed && typeof transformed === "object" && "directOutput" in transformed) {
        writeWithBackpressure(process.stdout, `${transformed.directOutput}\n`, input);
      } else if (transformed !== "") {
        writeWithBackpressure(output, `${transformed}\n`, input);
      }
    }
  });
  input.once("end", () => {
    if (pending) {
      const transformed = transform(pending.replace(/\r$/, ""));
      if (transformed && typeof transformed === "object" && "directOutput" in transformed) {
        writeWithBackpressure(process.stdout, transformed.directOutput, input);
      } else if (transformed !== "") {
        output.write(transformed);
      }
    }
    output.end();
  });
  input.once("error", (error) => {
    if (error.code !== "EPIPE") fail(error);
  });
  output.once("error", (error) => {
    if (error.code !== "EPIPE") fail(error);
  });
}

function pipeRaw(input, output) {
  input.on("data", (chunk) => writeWithBackpressure(output, chunk, input));
}

function writeWithBackpressure(output, chunk, input) {
  if (output.write(chunk)) return;
  input.pause();
  output.once("drain", () => input.resume());
}

async function runPassthrough(upstreamExecutable, args) {
  const env = { ...process.env, CODEX_CLI_PATH: upstreamExecutable };
  clearRelayEnvironment(env);
  delete env.CODEX_APP_SERVER_FORCE_CLI;
  delete env.CODEX_APP_SERVER_WS_URL;
  env.CODEX_CLI_PATH = upstreamExecutable;
  const child = spawn(upstreamExecutable, args, {
    env,
    stdio: "inherit",
    windowsHide: process.platform === "win32",
  });
  const stopForwardingSignals = forwardSignals(child);
  child.once("error", fail);
  child.once("exit", (code, signal) => {
    // Restore the default signal action before reproducing the child's exit.
    stopForwardingSignals();
    exitLikeChild(code, signal);
  });
}

async function readOfficialModelSlugs(path) {
  const catalog = await readJson(path);
  return new Set(Array.isArray(catalog?.models)
    ? catalog.models.map((model) => model?.slug).filter(Boolean)
    : []);
}

async function readJson(path) {
  if (!path) return null;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function resolveRelayPath(value) {
  const path = String(value ?? "").trim();
  if (!path || process.env.CODEX_QUOTA_WSL_NATIVE !== "1" || !isWindowsPath(path)) {
    return path;
  }
  try {
    const { stdout } = await execFileAsync("wslpath", ["-u", path]);
    const converted = stdout.trim();
    if (converted) return converted;
  } catch (error) {
    throw new Error(`无法转换 Windows 中继路径 ${path}: ${error.message}`);
  }
  throw new Error(`无法转换 Windows 中继路径: ${path}`);
}

async function resolveNativeWslRelayConfigPath() {
  const appDataRoot = await resolveWindowsDirectoryInWsl("APPDATA");
  return join(appDataRoot, "Codex Quota Injector", "app-server-relay-config.json");
}

function resolveNativeWindowsRelayConfigPath() {
  const appDataRoot = String(process.env.APPDATA ?? "").trim() ||
    join(homedir(), "AppData", "Roaming");
  return join(appDataRoot, "Codex Quota Injector", "app-server-relay-config.json");
}

async function resolveNativeWslCodexCli() {
  try {
    const { stdout } = await execFileAsync("sh", ["-c", "command -v codex"]);
    const executable = stdout.trim();
    if (executable) return executable;
  } catch {
    // Report a stable relay-specific error below.
  }
  throw new Error("WSL PATH 中未找到 Codex Desktop 提供的原生 codex 可执行文件");
}

async function readWindowsEnvironmentVariable(name) {
  try {
    const { stdout } = await execFileAsync("cmd.exe", ["/d", "/c", `echo %${name}%`]);
    const value = stdout.replaceAll("\r", "").trim();
    if (value && value !== `%${name}%`) return value;
  } catch (error) {
    throw new Error(`无法从 WSL 读取 Windows ${name}: ${error.message}`);
  }
  throw new Error(`Windows ${name} 为空，无法定位模型中继配置`);
}

async function resolveWindowsDirectoryInWsl(name) {
  const forwarded = String(process.env[name] ?? "").trim();
  if (forwarded) return resolveRelayPath(forwarded);
  return resolveRelayPath(await readWindowsEnvironmentVariable(name));
}

async function appendNativeWslDiagnostic(message) {
  const localAppDataRoot = await resolveWindowsDirectoryInWsl("LOCALAPPDATA");
  const logRoot = join(localAppDataRoot, "Codex Quota Injector", "Logs");
  await mkdir(logRoot, { recursive: true, mode: 0o700 });
  await appendFile(
    join(logRoot, "wsl-relay-stderr.log"),
    `${new Date().toISOString()} [wsl-relay] ${message}\n`,
    "utf8",
  );
}

function isWindowsPath(path) {
  return /^(?:[a-z]:[\\/]|\\\\\?\\[a-z]:[\\/])/i.test(path);
}

async function claimRelayState(path, generation, processIdentity = null) {
  if (!path) return false;
  const resolvedGeneration = generation ??
    process.env.CODEX_QUOTA_BRIDGE_GENERATION ??
    `usage-events-v${RELAY_PROTOCOL_VERSION}`;
  const identity = processIdentity ?? await currentRelayProcessIdentity(
    process.env.CODEX_QUOTA_WSL_NATIVE === "1",
  );
  return withRelayStateLock(path, async () => {
    const current = await readJson(path);
    if (current?.generation === resolvedGeneration &&
      current?.pid !== identity.pid && await relayStateProcessIsAlive(current)) {
      return false;
    }
    const now = Date.now();
    const state = {
      version: RELAY_STATE_VERSION,
      pid: identity.pid,
      generation: resolvedGeneration,
      processStartedAt: identity.processStartedAt,
      ...(identity.bootId ? { bootId: identity.bootId } : {}),
      ...(identity.processStartTicks != null
        ? { processStartTicks: identity.processStartTicks }
        : {}),
      startedAt: current?.pid === identity.pid && Number.isFinite(Number(current.startedAt))
        ? Number(current.startedAt)
        : now,
      updatedAt: now,
    };
    await writeJsonAtomically(path, state, identity.pid);
    return true;
  });
}

async function currentRelayProcessIdentity(wslNative) {
  const processStartedAt = Math.max(
    0,
    Math.floor(Date.now() - process.uptime() * 1000),
  );
  const wslProcessIdentity = wslNative ? await readCurrentLinuxProcessIdentity() : null;
  return {
    pid: process.pid,
    processStartedAt,
    ...(wslProcessIdentity ?? {}),
  };
}

async function readCurrentLinuxProcessIdentity() {
  const [bootIdText, statText] = await Promise.all([
    readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    readFile(`/proc/${process.pid}/stat`, "utf8"),
  ]);
  const bootId = String(bootIdText).trim();
  const processStartTicks = parseLinuxProcessStartTicks(statText);
  if (!bootId || !Number.isSafeInteger(processStartTicks) || processStartTicks < 0) {
    throw new Error("无法读取 WSL 中继的稳定进程身份");
  }
  return { bootId, processStartTicks };
}

function parseLinuxProcessStartTicks(statText) {
  const text = String(statText ?? "").trim();
  const commandEnd = text.lastIndexOf(")");
  if (commandEnd < 0) return null;
  // `/proc/<pid>/stat` 在 comm 字段后从第 3 字段 state 继续；starttime
  // 是第 22 字段，因此对应剩余字段中的索引 19。
  const fields = text.slice(commandEnd + 1).trim().split(/\s+/);
  const startTicks = Number(fields[19]);
  return Number.isSafeInteger(startTicks) && startTicks >= 0 ? startTicks : null;
}

function clearRelayEnvironment(env) {
  for (const key of [
    PRIMARY_APP_SERVER_ENV,
    "CODEX_QUOTA_RELAY_CONFIG",
    "CODEX_QUOTA_ROLE",
    "CODEX_QUOTA_UPSTREAM_CODEX_CLI",
    "CODEX_QUOTA_EXTRA_MODEL_SETTINGS",
    "CODEX_QUOTA_MODEL_CATALOG",
    "CODEX_QUOTA_RELAY_STATE",
    "CODEX_QUOTA_TOKEN_USAGE_EVENTS",
    "CODEX_QUOTA_BRIDGE_GENERATION",
    "CODEX_QUOTA_WSL_NATIVE",
    "CODEX_QUOTA_WSL_UPSTREAM_CODEX_CLI",
    "CODEX_QUOTA_WINDOWS_NATIVE",
    SIDECAR_MODE_ENV,
    SIDECAR_UPSTREAM_STDIN_FD_ENV,
    SIDECAR_UPSTREAM_STDOUT_FD_ENV,
  ]) {
    delete env[key];
  }
}

export function shouldPublishHostState(_args, environment = process.env) {
  // Only the desktop launch bridge owns these process-global files. Auxiliary
  // app-servers are not guaranteed to retain their parent's --listen argument;
  // inferring ownership from argv lets a short-lived task replace the desktop
  // Relay PID and leave host health permanently stale after it exits.
  return String(environment?.[PRIMARY_APP_SERVER_ENV] ?? "").trim() === "1";
}

async function removeRelayState(path, processIdentity = null) {
  if (!path) return;
  try {
    const identity = processIdentity ?? { pid: process.pid };
    await withRelayStateLock(path, async () => {
      const state = await readJson(path);
      if (state?.pid === identity.pid) await unlink(path).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    });
  } catch (error) {
    if (error.code !== "ENOENT") console.error(`清理模型中继状态失败: ${error.message}`);
  }
}

async function relayStateProcessIsAlive(state) {
  const pid = Number(state?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === "linux" && state?.bootId &&
    Number.isSafeInteger(Number(state?.processStartTicks))) {
    try {
      const [bootIdText, statText] = await Promise.all([
        readFile("/proc/sys/kernel/random/boot_id", "utf8"),
        readFile(`/proc/${pid}/stat`, "utf8"),
      ]);
      return String(bootIdText).trim() === String(state.bootId) &&
        parseLinuxProcessStartTicks(statText) === Number(state.processStartTicks);
    } catch {
      return false;
    }
  }
  return true;
}

async function withRelayStateLock(path, action) {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + RELAY_STATE_LOCK_TIMEOUT_MS;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      try {
        await writeFile(join(lockPath, "created-at"), String(Date.now()), { flag: "wx" });
      } catch (error) {
        await removeRelayStateLock(lockPath);
        throw error;
      }
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const lockAge = await readLockAge(lockPath);
      if (lockAge != null && lockAge >= RELAY_STATE_LOCK_STALE_MS) {
        await removeRelayStateLock(lockPath);
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`等待状态锁超时: ${lockPath}`);
      await new Promise((resolve) => setTimeout(resolve, RELAY_STATE_LOCK_RETRY_MS));
    }
  }
  try {
    return await action();
  } finally {
    await removeRelayStateLock(lockPath);
  }
}

async function readLockAge(path) {
  try {
    const value = Number(await readFile(join(path, "created-at"), "utf8"));
    return Number.isFinite(value) ? Date.now() - value : null;
  } catch {
    const details = await stat(path).catch(() => null);
    return details ? Date.now() - details.mtimeMs : null;
  }
}

async function removeRelayStateLock(path) {
  await unlink(join(path, "created-at")).catch(() => undefined);
  await rmdir(path).catch(() => undefined);
}

async function writeJsonAtomically(path, value, pid) {
  const temporaryPath = `${path}.${pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function forwardSignals(child) {
  const handlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      if (!child.killed) child.kill(signal);
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}

function forwardSidecarSignals(cleanup) {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      void cleanup().then(
        () => process.kill(process.pid, signal),
        (error) => fail(error),
      );
    });
  }
}

function exitLikeChild(code, signal) {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
}

function fail(error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function createUsageEventWriter(path) {
  const sessionId = randomUUID();
  let sequence = 0;
  let buffer = [];
  let flushTimer = null;
  let closed = false;
  let tail = Promise.resolve();
  const directoryReady = path
    ? mkdir(dirname(path), { recursive: true, mode: 0o700 })
    : Promise.resolve();
  const flush = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!path || buffer.length === 0) return tail;
    const batch = buffer;
    buffer = [];
    const content = `${batch.map((payload) => JSON.stringify(payload)).join("\n")}\n`;
    tail = tail
      .then(async () => {
        await directoryReady;
        await appendFile(path, content, { encoding: "utf8", mode: 0o600 });
      })
      .catch((error) => {
        console.error(`记录 Token 用量事件失败: ${error.message}`);
      });
    return tail;
  };
  const write = (event) => {
    if (closed || !path || !event?.type) return;
    const payload = {
      ...event,
      eventId: `${sessionId}:${++sequence}`,
      recordedAt: Date.now(),
    };
    buffer.push(payload);
    if (buffer.length >= 32) {
      void flush();
    } else if (!flushTimer) {
      flushTimer = setTimeout(() => void flush(), 25);
    }
  };
  return {
    write,
    close: async () => {
      closed = true;
      await flush();
      await tail;
    },
  };
}
