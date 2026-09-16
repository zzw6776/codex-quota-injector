import { isSea } from "node:sea";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, win32 } from "node:path";
import packageJson from "../package.json" with { type: "json" };

import {
  codexRunsInWindowsSubsystemForLinux,
  defaultAccountDataDir,
  resolveCodexCliExecutable,
} from "./platform.mjs";
import { resolveMacOSCodexShim } from "./macos-shim.mjs";
import { RELAY_PROTOCOL_VERSION } from "./relay-contract.mjs";
import { fetchOfficialModelCatalog } from "./official-model-catalog.mjs";

const BRIDGE_GENERATION = `usage-events-v${RELAY_PROTOCOL_VERSION}`;
const RELAY_CONFIG_VERSION = 3;
const MACOS_SHIM_CONFIG_VERSION = 6;
const PRIMARY_APP_SERVER_ENV = "CODEX_QUOTA_PRIMARY_APP_SERVER";

export async function refreshCodexModelCatalog({
  contextManager,
  accountManager = null,
  executable = null,
}) {
  let account = null;
  try {
    const upstreamExecutable = executable ?? await resolveCodexCliExecutable();
    account = await accountManager?.getCurrentModelCatalogAccount();
    contextManager.selectModelCatalogAccount(account);
    await contextManager.refresh({ sync: false });
    const refresh = await fetchOfficialModelCatalog({ executable: upstreamExecutable, account });
    const changed = refresh.catalog
      ? (await contextManager.useOfficialCatalog(refresh.catalog, {
          source: refresh.source === "bundled" ? "official-bundled" : "official-online",
          persist: refresh.source === "online",
        })).changed
      : false;
    return {
      officialCatalogChanged: changed,
      officialCatalogChecked: refresh.source === "online",
      officialCatalogSource: refresh.source,
      officialCatalogError: null,
      officialAuthMode: account?.authMode ?? null,
    };
  } catch (error) {
    console.warn(`[models] 官方模型目录刷新失败，继续使用上次可用目录：${error.message}`);
    // Preserve an API-key account's last usable bundled catalog when fetching
    // fails, rather than replacing it with another account's OAuth cache.
    await contextManager.refresh({ sync: false });
    return {
      officialCatalogChanged: false,
      officialCatalogChecked: false,
      officialCatalogSource: null,
      officialCatalogError: error.message,
      officialAuthMode: account?.authMode ?? null,
    };
  }
}

export async function prepareCodexLaunch({
  extraModelManager,
  contextManager,
  accountManager = null,
  modelRouterManager = null,
}) {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    return {
      env: {},
      relay: null,
      injectionMode: null,
      officialCatalogChanged: false,
      staticModelCatalog: false,
    };
  }
  const defaultInjectionMode = await resolveDefaultInjectionMode();
  const statePath = join(defaultAccountDataDir(), "app-server-relay-state.json");
  const healthPath = join(defaultAccountDataDir(), "app-server-health.json");
  const tokenUsageEventPath = join(defaultAccountDataDir(), "token-usage-events.jsonl");
  const relayConfigPath = join(defaultAccountDataDir(), "app-server-relay-config.json");
  const reusableRouterIdentity = process.platform === "darwin"
    ? await readReusableRouterIdentity(relayConfigPath)
    : null;
  let runtime;
  let upstreamExecutable;
  let relayExecutable;
  let staticModelCatalog = false;
  let officialCatalog;
  let router = null;
  try {
    upstreamExecutable = await resolveCodexCliExecutable();
    officialCatalog = await refreshCodexModelCatalog({
      contextManager,
      accountManager,
      executable: upstreamExecutable,
    });
    const contextState = contextManager.getViewModel();
    const extraModels = extraModelManager.getViewModel();
    staticModelCatalog = requiresStaticModelCatalog({
      contextState,
      extraModels,
    });
    if (contextState.status === "external" && staticModelCatalog) {
      await modelRouterManager?.disable();
      const message = "检测到用户管理的模型目录，已保留其配置并停用本工具模型中继";
      extraModelManager.setError(message);
      return {
        env: {},
        relay: {
          statePath,
          healthPath,
          expectAbsent: true,
          hostToolsRequired: false,
          wslNative: defaultInjectionMode === "wsl",
        },
        injectionMode: defaultInjectionMode,
        preparationError: message,
        ...officialCatalog,
        staticModelCatalog: false,
      };
    }
    const catalog = contextManager.getEffectiveCatalog();
    runtime = await extraModelManager.writeRuntimeCatalog(catalog);
    const routingExtraModels = withoutCatalogConflicts(extraModels, runtime.catalogConflicts);
    const customRoutingRequired = requiresCustomRouting({
      extraModels: routingExtraModels,
    });
    const bridgeMode = selectBridgeMode({
      platform: process.platform,
      staticModelCatalog,
      customRoutingRequired,
    });
    if (bridgeMode === "direct") {
      await modelRouterManager?.disable();
      return {
        env: {},
        relay: {
          statePath,
          healthPath,
          expectAbsent: true,
          hostToolsRequired: false,
          wslNative: defaultInjectionMode === "wsl",
        },
        injectionMode: defaultInjectionMode,
        ...officialCatalog,
        staticModelCatalog: false,
      };
    }
    if (bridgeMode === "macos-shim" || bridgeMode === "macos-router") {
      relayExecutable = await resolveMacOSCodexShim();
      await access(relayExecutable, fsConstants.X_OK);
      if (bridgeMode === "macos-router") {
        if (!modelRouterManager) throw new Error("macOS 自定义模型路由器未初始化");
        router = await modelRouterManager.configure({
          extraModels: routingExtraModels,
          officialAuthMode: officialCatalog.officialAuthMode,
          usageEventPath: tokenUsageEventPath,
          reusableIdentity: reusableRouterIdentity,
        });
        if (!router) throw new Error("macOS 自定义模型路由器没有可用目标");
      } else {
        await modelRouterManager?.disable();
      }
    } else {
      relayExecutable = await resolveRelayExecutable();
      await access(relayExecutable, fsConstants.F_OK);
    }
  } catch (error) {
    await modelRouterManager?.disable().catch(() => undefined);
    extraModelManager.setError(`模型中继准备失败，Codex 将按官方模式启动：${error.message}`);
    return {
      env: {},
      relay: {
        statePath,
        healthPath,
        expectAbsent: true,
        hostToolsRequired: false,
        wslNative: defaultInjectionMode === "wsl",
      },
      injectionMode: defaultInjectionMode,
      preparationError: error.message,
      officialCatalogChanged: false,
      staticModelCatalog: false,
    };
  }
  const catalogGeneration = staticModelCatalog
    ? runtime.generation
    : `official-online:${extraModelManager.settings.generation}`;
  const relayGeneration = `${catalogGeneration}:${BRIDGE_GENERATION}`;
  try {
    const config = process.platform === "darwin"
      ? {
          version: MACOS_SHIM_CONFIG_VERSION,
          upstreamExecutable,
          relayExecutable: process.execPath,
          relayArguments: isSea() ? [] : [resolve(import.meta.dirname, "launcher.mjs")],
          extraModelSettingsPath: runtime.settingsPath,
          modelCatalogPath: staticModelCatalog ? runtime.path : null,
          relayStatePath: statePath,
          hostHealthPath: healthPath,
          hostToolsRequired: true,
          runtimeTarget: "macos-native",
          tokenUsageEventsPath: tokenUsageEventPath,
          generation: `${relayGeneration}:${router?.instanceId ?? "direct"}`,
          router: router
            ? {
                providerId: router.providerId,
                baseUrl: router.baseUrl,
                tokenEnv: router.tokenEnv,
                tokenHeader: router.tokenHeader,
                legacyProviderIds: router.legacyProviderIds,
              }
            : null,
        }
      : {
          version: RELAY_CONFIG_VERSION,
          upstreamExecutable,
          officialAuthMode: officialCatalog.officialAuthMode,
          observeModelTraffic: true,
          extraModelSettingsPath: runtime.settingsPath,
          modelCatalogPath: staticModelCatalog ? runtime.path : null,
          relayStatePath: statePath,
          hostHealthPath: healthPath,
          hostToolsRequired: true,
          runtimeTarget: resolveInjectionMode(relayExecutable) === "wsl"
            ? "wsl-native"
            : "windows-native",
          tokenUsageEventsPath: tokenUsageEventPath,
          generation: relayGeneration,
        };
    await writeRelayConfig(relayConfigPath, config);
  } catch (error) {
    await modelRouterManager?.disable().catch(() => undefined);
    extraModelManager.setError(`模型中继配置写入失败，Codex 将按官方模式启动：${error.message}`);
    return {
      env: {},
      relay: {
        statePath,
        healthPath,
        expectAbsent: true,
        hostToolsRequired: false,
        wslNative: defaultInjectionMode === "wsl",
      },
      injectionMode: defaultInjectionMode,
      preparationError: error.message,
      officialCatalogChanged: false,
      staticModelCatalog: false,
    };
  }
  const effectiveGeneration = process.platform === "darwin"
    ? `${relayGeneration}:${router?.instanceId ?? "direct"}`
    : relayGeneration;
  return {
    env: {
      ...relayLaunchEnvironment(relayExecutable),
      CODEX_APP_SERVER_FORCE_CLI: "1",
      [PRIMARY_APP_SERVER_ENV]: "1",
      CODEX_QUOTA_RELAY_CONFIG: relayConfigPath,
      CODEX_QUOTA_UPSTREAM_CODEX_CLI: upstreamExecutable,
      ...(router ? { [router.tokenEnv]: router.token } : {}),
    },
    relay: {
      statePath,
      healthPath,
      configPath: relayConfigPath,
      generation: effectiveGeneration,
      hostToolsRequired: true,
      wslNative: isWslNativeRelay(relayExecutable),
    },
    injectionMode: resolveInjectionMode(relayExecutable),
    ...officialCatalog,
    staticModelCatalog,
  };
}

export function selectBridgeMode({ platform, staticModelCatalog, customRoutingRequired }) {
  if (platform !== "darwin" && platform !== "win32") return "unsupported";
  if (platform === "win32") return "windows-relay";
  if (!staticModelCatalog) return "direct";
  if (platform === "darwin") {
    return customRoutingRequired ? "macos-router" : "macos-shim";
  }
  return "windows-relay";
}

function requiresCustomRouting({ extraModels }) {
  return extraModels?.platforms?.some((platform) =>
      platform?.enabled && platform?.apiKey && platform?.models?.length > 0
    ) === true;
}

function withoutCatalogConflicts(extraModels, conflicts) {
  const conflictingModelIds = new Set(
    (Array.isArray(conflicts) ? conflicts : []).map((item) => item?.modelId).filter(Boolean),
  );
  if (conflictingModelIds.size === 0) return extraModels;
  return {
    ...extraModels,
    platforms: (extraModels?.platforms ?? []).map((platform) => ({
      ...platform,
      models: (platform?.models ?? []).filter((model) => !conflictingModelIds.has(model?.id)),
    })),
  };
}

function requiresStaticModelCatalog({ contextState, extraModels }) {
  // An external root-level model_catalog_json remains the user's responsibility:
  // the upstream process already receives it from config.toml. Only inject our
  // composed static catalog when one of this tool's model features actually needs it.
  return Number(contextState?.overriddenCount) > 0 ||
    extraModels?.platforms?.some((platform) =>
      platform?.enabled && platform?.apiKey && platform?.models?.length > 0
    ) === true;
}

function resolveInjectionMode(relayExecutable = process.env.CODEX_QUOTA_RELAY_EXECUTABLE) {
  if (process.platform !== "win32") return null;
  return isWslNativeRelay(relayExecutable) ? "wsl" : "windows";
}

async function resolveDefaultInjectionMode() {
  if (process.platform !== "win32") return null;
  if (process.env.CODEX_QUOTA_RELAY_EXECUTABLE) {
    return resolveInjectionMode(process.env.CODEX_QUOTA_RELAY_EXECUTABLE);
  }
  return await codexRunsInWindowsSubsystemForLinux() ? "wsl" : "windows";
}

function isWslNativeRelay(relayExecutable, platform = process.platform) {
  return platform === "win32" &&
    /^codex-quota-relay-wsl-\d+\.\d+\.\d+$/i.test(win32.basename(String(relayExecutable ?? "")));
}

async function resolveRelayExecutable() {
  if (process.env.CODEX_QUOTA_RELAY_EXECUTABLE) {
    return resolve(process.env.CODEX_QUOTA_RELAY_EXECUTABLE);
  }
  if (isSea()) {
    if (process.platform === "win32" &&
      await codexRunsInWindowsSubsystemForLinux()) {
      const bundledWslRelay = resolve(
        dirname(process.execPath),
        "relay",
        `codex-quota-relay-wsl-${packageJson.version}`,
      );
      // ELF 与 SEA fuse 已在构建及打包阶段校验；运行时只检查安装文件是否存在。
      return bundledWslRelay;
    }
    if (process.platform === "win32") {
      return resolve(
        dirname(process.execPath),
        "relay",
        `codex-quota-relay-windows-${packageJson.version}.exe`,
      );
    }
    return process.execPath;
  }
  if (process.platform === "win32") {
    const developmentRelay = resolve(
      import.meta.dirname,
      "..",
      "build",
      `codex-quota-relay-windows-${packageJson.version}.exe`,
    );
    try {
      await access(developmentRelay, fsConstants.F_OK);
      return developmentRelay;
    } catch {
      throw new Error("Windows 开发版 relay 不存在，请运行 npm run build:relay:windows");
    }
  }
  return resolve(import.meta.dirname, "launcher.mjs");
}

export function relayLaunchEnvironment(relayExecutable, {
  platform = process.platform,
  environment = process.env,
} = {}) {
  if (platform !== "win32") return { CODEX_CLI_PATH: relayExecutable };
  return {
    // The desktop app translates an absolute path to its WSL equivalent.
    // A basename would require a Windows PATH entry that WSL does not inherit.
    CODEX_CLI_PATH: relayExecutable,
    // WSL only imports variables declared in WSLENV. The primary marker must
    // reach the desktop Relay so it can publish state; keep other declarations
    // and replace any old marker flags with Windows-to-WSL forwarding.
    ...(isWslNativeRelay(relayExecutable, platform) ? {
      WSLENV: [...String(environment.WSLENV ?? "").split(":").filter(entry =>
        entry && entry.split("/", 1)[0].trim().toUpperCase() !== PRIMARY_APP_SERVER_ENV,
      ), `${PRIMARY_APP_SERVER_ENV}/u`].join(":"),
    } : {}),
  };
}

async function writeRelayConfig(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function readReusableRouterIdentity(path) {
  try {
    return reusableRouterIdentityFromRelayConfig(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export function reusableRouterIdentityFromRelayConfig(value) {
  if (value?.version !== MACOS_SHIM_CONFIG_VERSION || !value.router ||
    value.router.tokenEnv !== "CODEX_QUOTA_ROUTER_TOKEN" ||
    value.router.tokenHeader !== "x-codex-quota-router-token") return null;
  let url;
  try {
    url = new URL(value.router.baseUrl);
  } catch {
    return null;
  }
  const pathParts = url.pathname.split("/").filter(Boolean);
  const port = Number(url.port);
  const token = pathParts[0] ?? "";
  const instanceId = String(value.generation ?? "").split(":").at(-1) ?? "";
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" ||
    url.username || url.password || url.search || url.hash ||
    pathParts.length !== 2 || pathParts[1] !== "v1" ||
    !Number.isInteger(port) || port <= 0 || port > 65_535 ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(token) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(instanceId)) return null;
  return { port, token, instanceId };
}
