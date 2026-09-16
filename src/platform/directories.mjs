import { homedir } from "node:os";
import { join } from "node:path";
import { WINDOWS_CODEX_APP_CACHE_DIR, WINDOWS_CODEX_CACHE_DIR } from "./contract.mjs";

function defaultAccountDataDir() {
  if (process.env.CODEX_QUOTA_DATA_DIR) return process.env.CODEX_QUOTA_DATA_DIR;
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Codex Quota Injector");
  }
  if (process.platform === "win32") {
    return join(
      process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
      "Codex Quota Injector",
    );
  }
  return join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "codex-quota-injector",
  );
}

function defaultLogDir() {
  if (process.env.CODEX_QUOTA_LOG_DIR) return process.env.CODEX_QUOTA_LOG_DIR;
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Logs", "Codex Quota Injector");
  }
  if (process.platform === "win32") {
    return join(
      process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
      "Codex Quota Injector",
      "Logs",
    );
  }
  return join(
    process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
    "codex-quota-injector",
  );
}

function windowsCodexAppCacheRoot() {
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  return join(localAppData, "Codex Quota Injector", WINDOWS_CODEX_APP_CACHE_DIR);
}

function windowsCodexUpstreamRoot() {
  const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  return join(appData, "Codex Quota Injector", WINDOWS_CODEX_CACHE_DIR);
}

export { defaultAccountDataDir, defaultLogDir, windowsCodexAppCacheRoot, windowsCodexUpstreamRoot };
