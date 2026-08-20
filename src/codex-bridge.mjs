import { isSea } from "node:sea";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, join, resolve } from "node:path";

import { defaultAccountDataDir, resolveCodexCliExecutable } from "./platform.mjs";
import { RELAY_PROTOCOL_VERSION } from "./relay-contract.mjs";

const BRIDGE_GENERATION = `usage-events-v${RELAY_PROTOCOL_VERSION}`;
const RELAY_CONFIG_VERSION = 1;

export async function prepareCodexLaunch({ deepSeekManager, contextManager }) {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    return { env: {}, relay: null };
  }
  const statePath = join(defaultAccountDataDir(), "app-server-relay-state.json");
  const tokenUsageEventPath = join(defaultAccountDataDir(), "token-usage-events.jsonl");
  const relayConfigPath = join(defaultAccountDataDir(), "app-server-relay-config.json");
  const contextState = contextManager.getViewModel();
  if (contextState.status === "external" &&
    basename(contextState.currentCatalogPath ?? "") !== "codex-deepseek-poc.json") {
    deepSeekManager.setError("检测到其他工具管理的模型目录，已保留其配置并停用 DeepSeek 中继");
    return { env: {}, relay: { statePath, expectAbsent: true } };
  }
  let runtime;
  let upstreamExecutable;
  let relayExecutable;
  try {
    const catalog = contextManager.getEffectiveCatalog();
    runtime = await deepSeekManager.writeRuntimeCatalog(catalog);
    upstreamExecutable = await resolveCodexCliExecutable();
    relayExecutable = await resolveRelayExecutable();
    await access(relayExecutable, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
  } catch (error) {
    deepSeekManager.setError(`模型中继准备失败，Codex 将按官方模式启动：${error.message}`);
    return { env: {}, relay: { statePath, expectAbsent: true } };
  }
  const relayGeneration = `${runtime.generation}:${BRIDGE_GENERATION}`;
  try {
    await writeRelayConfig(relayConfigPath, {
      version: RELAY_CONFIG_VERSION,
      upstreamExecutable,
      providerSettingsPath: deepSeekManager.settingsPath,
      modelCatalogPath: runtime.path,
      relayStatePath: statePath,
      tokenUsageEventsPath: tokenUsageEventPath,
      generation: relayGeneration,
    });
  } catch (error) {
    deepSeekManager.setError(`模型中继配置写入失败，Codex 将按官方模式启动：${error.message}`);
    return { env: {}, relay: { statePath, expectAbsent: true } };
  }
  return {
    env: {
      ...relayLaunchEnvironment(relayExecutable),
      CODEX_APP_SERVER_FORCE_CLI: "1",
      CODEX_QUOTA_RELAY_CONFIG: relayConfigPath,
      CODEX_QUOTA_UPSTREAM_CODEX_CLI: upstreamExecutable,
    },
    relay: { statePath, configPath: relayConfigPath, generation: relayGeneration },
  };
}

async function resolveRelayExecutable() {
  if (process.env.CODEX_QUOTA_RELAY_EXECUTABLE) {
    return resolve(process.env.CODEX_QUOTA_RELAY_EXECUTABLE);
  }
  if (isSea()) return process.execPath;
  if (process.platform === "win32") {
    const developmentRelay = resolve(import.meta.dirname, "..", "build", "codex-quota-relay.exe");
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
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const pathValue = [dirname(relayExecutable), process.env[pathKey]]
    .filter(Boolean)
    .join(delimiter);
  return {
    CODEX_CLI_PATH: basename(relayExecutable),
    [pathKey]: pathValue,
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
