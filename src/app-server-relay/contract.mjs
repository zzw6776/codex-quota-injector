import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";

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

async function readJson(path) {
  if (!path) return null;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export { OPENAI_PROVIDER, RELAY_CLEANUP_INTERVAL_MS, RELAY_OWNERSHIP_POLL_MS, readJson, SIDECAR_MODE_ENV, SIDECAR_UPSTREAM_STDIN_FD_ENV, SIDECAR_UPSTREAM_STDOUT_FD_ENV, THREAD_METHODS, THREAD_SETTINGS_METHOD, MODEL_LIST_METHOD, OBSERVED_THREAD_METHODS, TURN_INPUT_METHODS, MCP_CONFIG_RELOAD_METHOD, HOST_TOOL_RELOAD_TIMEOUT_MS, MCP_STATUS_LIST_METHOD, CUSTOM_REASONING_DESCRIPTIONS, PENDING_REQUEST_TTL_MS, TURN_MODEL_TTL_MS, THREAD_CONTEXT_TTL_MS, CUSTOM_PROVIDER_PREFIX, ALLOWED_CUSTOM_EFFORTS, execFileAsync, PRIMARY_APP_SERVER_ENV, RELAY_STATE_LOCK_RETRY_MS, RELAY_STATE_LOCK_TIMEOUT_MS, RELAY_STATE_LOCK_STALE_MS };
