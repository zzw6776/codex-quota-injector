import { isSea } from "node:sea";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import packageJson from "../package.json" with { type: "json" };

import {
  codexRunsInWindowsSubsystemForLinux,
  defaultAccountDataDir,
  resolveCodexCliExecutable,
} from "./platform.mjs";
import { RELAY_PROTOCOL_VERSION } from "./relay-contract.mjs";
import { fetchOfficialModelCatalog } from "./official-model-catalog.mjs";

const BRIDGE_GENERATION = `usage-events-v${RELAY_PROTOCOL_VERSION}`;
const RELAY_CONFIG_VERSION = 1;

export async function refreshCodexModelCatalog({
  contextManager,
  accountManager = null,
  executable = null,
}) {
  try {
    const upstreamExecutable = executable ?? await resolveCodexCliExecutable();
    const account = await accountManager?.getCurrentModelCatalogAccount();
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
    };
  }
}

export async function prepareCodexLaunch({
  deepSeekManager,
  extraModelManager,
  contextManager,
  accountManager = null,
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
  const defaultInjectionMode = resolveInjectionMode();
  const statePath = join(defaultAccountDataDir(), "app-server-relay-state.json");
  const tokenUsageEventPath = join(defaultAccountDataDir(), "token-usage-events.jsonl");
  const relayConfigPath = join(defaultAccountDataDir(), "app-server-relay-config.json");
  let runtime;
  let upstreamExecutable;
  let relayExecutable;
  let staticModelCatalog = false;
  let officialCatalog;
  try {
    upstreamExecutable = await resolveCodexCliExecutable();
    officialCatalog = await refreshCodexModelCatalog({
      contextManager,
      accountManager,
      executable: upstreamExecutable,
    });
    const contextState = contextManager.getViewModel();
    staticModelCatalog = requiresStaticModelCatalog({
      contextState,
      deepSeek: deepSeekManager.getViewModel(),
      extraModels: extraModelManager.getViewModel(),
    });
    if (contextState.status === "external" && staticModelCatalog) {
      const message = "检测到用户管理的模型目录，已保留其配置并停用本工具模型中继";
      deepSeekManager.setError(message);
      extraModelManager.setError(message);
      return {
        env: {},
        relay: {
          statePath,
          expectAbsent: true,
          wslNative: defaultInjectionMode === "wsl",
        },
        injectionMode: defaultInjectionMode,
        preparationError: message,
        ...officialCatalog,
        staticModelCatalog: false,
      };
    }
    const catalog = contextManager.getEffectiveCatalog();
    const deepSeekRuntime = await deepSeekManager.writeRuntimeCatalog(catalog);
    runtime = await extraModelManager.writeRuntimeCatalog(deepSeekRuntime.catalog);
    relayExecutable = await resolveRelayExecutable();
    await access(relayExecutable, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
  } catch (error) {
    deepSeekManager.setError(`模型中继准备失败，Codex 将按官方模式启动：${error.message}`);
    extraModelManager.setError(`模型中继准备失败，Codex 将按官方模式启动：${error.message}`);
    return {
      env: {},
      relay: {
        statePath,
        expectAbsent: true,
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
    : `official-online:${deepSeekManager.settings.generation}:${extraModelManager.settings.generation}`;
  const relayGeneration = `${catalogGeneration}:${BRIDGE_GENERATION}`;
  try {
    await writeRelayConfig(relayConfigPath, {
      version: RELAY_CONFIG_VERSION,
      upstreamExecutable,
      providerSettingsPath: deepSeekManager.settingsPath,
      extraModelSettingsPath: runtime.settingsPath,
      modelCatalogPath: staticModelCatalog ? runtime.path : null,
      relayStatePath: statePath,
      tokenUsageEventsPath: tokenUsageEventPath,
      generation: relayGeneration,
    });
  } catch (error) {
    deepSeekManager.setError(`模型中继配置写入失败，Codex 将按官方模式启动：${error.message}`);
    extraModelManager.setError(`模型中继配置写入失败，Codex 将按官方模式启动：${error.message}`);
    return {
      env: {},
      relay: {
        statePath,
        expectAbsent: true,
        wslNative: defaultInjectionMode === "wsl",
      },
      injectionMode: defaultInjectionMode,
      preparationError: error.message,
      officialCatalogChanged: false,
      staticModelCatalog: false,
    };
  }
  return {
    env: {
      ...relayLaunchEnvironment(relayExecutable),
      CODEX_APP_SERVER_FORCE_CLI: "1",
      CODEX_QUOTA_RELAY_CONFIG: relayConfigPath,
      CODEX_QUOTA_UPSTREAM_CODEX_CLI: upstreamExecutable,
    },
    relay: {
      statePath,
      configPath: relayConfigPath,
      generation: relayGeneration,
      wslNative: isWslNativeRelay(relayExecutable),
    },
    injectionMode: resolveInjectionMode(relayExecutable),
    ...officialCatalog,
    staticModelCatalog,
  };
}

function requiresStaticModelCatalog({ contextState, deepSeek, extraModels }) {
  // An external root-level model_catalog_json remains the user's responsibility:
  // the upstream process already receives it from config.toml. Only inject our
  // composed static catalog when one of this tool's model features actually needs it.
  return Number(contextState?.overriddenCount) > 0 ||
    Boolean(deepSeek?.enabled && deepSeek?.configured) ||
    extraModels?.platforms?.some((platform) =>
      platform?.enabled && platform?.apiKey && platform?.models?.length > 0
    ) === true;
}

function resolveInjectionMode(relayExecutable = process.env.CODEX_QUOTA_RELAY_EXECUTABLE) {
  if (process.platform !== "win32") return null;
  return isWslNativeRelay(relayExecutable) ? "wsl" : "windows";
}

function isWslNativeRelay(relayExecutable) {
  return process.platform === "win32" &&
    /^codex-quota-relay-wsl-\d+\.\d+\.\d+$/i.test(basename(String(relayExecutable ?? "")));
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

function relayLaunchEnvironment(relayExecutable) {
  if (process.platform !== "win32") return { CODEX_CLI_PATH: relayExecutable };
  return {
    // The desktop app translates an absolute path to its WSL equivalent.
    // A basename would require a Windows PATH entry that WSL does not inherit.
    CODEX_CLI_PATH: relayExecutable,
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
