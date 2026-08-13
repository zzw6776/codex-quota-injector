import { isSea } from "node:sea";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { defaultAccountDataDir, resolveCodexCliExecutable } from "./platform.mjs";
import { RELAY_PROTOCOL_VERSION } from "./relay-contract.mjs";

const BRIDGE_GENERATION = `usage-events-v${RELAY_PROTOCOL_VERSION}`;

export async function prepareCodexLaunch({ deepSeekManager, contextManager }) {
  if (process.platform !== "darwin") return { env: {}, relay: null };
  const statePath = join(defaultAccountDataDir(), "app-server-relay-state.json");
  const tokenUsageEventPath = join(defaultAccountDataDir(), "token-usage-events.jsonl");
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
    relayExecutable = process.env.CODEX_QUOTA_RELAY_EXECUTABLE
      ? resolve(process.env.CODEX_QUOTA_RELAY_EXECUTABLE)
      : isSea()
        ? process.execPath
        : resolve(import.meta.dirname, "launcher.mjs");
    await access(relayExecutable, fsConstants.X_OK);
  } catch (error) {
    deepSeekManager.setError(`模型中继准备失败，Codex 将按官方模式启动：${error.message}`);
    return { env: {}, relay: { statePath, expectAbsent: true } };
  }
  const relayGeneration = `${runtime.generation}:${BRIDGE_GENERATION}`;
  return {
    env: {
      CODEX_CLI_PATH: relayExecutable,
      CODEX_APP_SERVER_FORCE_CLI: "1",
      CODEX_QUOTA_ROLE: "app-server-relay",
      CODEX_QUOTA_UPSTREAM_CODEX_CLI: upstreamExecutable,
      CODEX_QUOTA_PROVIDER_SETTINGS: deepSeekManager.settingsPath,
      CODEX_QUOTA_MODEL_CATALOG: runtime.path,
      CODEX_QUOTA_RELAY_STATE: statePath,
      CODEX_QUOTA_TOKEN_USAGE_EVENTS: tokenUsageEventPath,
      CODEX_QUOTA_BRIDGE_GENERATION: relayGeneration,
    },
    relay: { statePath, generation: relayGeneration },
  };
}
