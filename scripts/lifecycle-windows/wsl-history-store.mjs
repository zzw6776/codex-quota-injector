import { join } from "node:path";
import { inspectThreadHistoryStore, resetThreadHistoryProjection } from "../../src/lifecycle-history-store.mjs";
import { WINDOWS_NATIVE, WSL_NATIVE } from "../test-runtime-targets.mjs";
import { execFileAsync } from "./io.mjs";

async function runWindowsHistoryStoreRequest(control, runtimeTarget, request) {
  if (runtimeTarget === WINDOWS_NATIVE) {
    const native = { ...request, sqliteHome: control.codexHome };
    return request.operation === "reset"
      ? resetThreadHistoryProjection(native)
      : inspectThreadHistoryStore(native);
  }
  if (runtimeTarget !== WSL_NATIVE) throw new Error(`未知 Codex 历史运行环境：${runtimeTarget}`);
  const [scriptPath, sqliteHome, rolloutPath, backupDirectory] = await Promise.all([
    windowsPathToWsl(join(control.root, "scripts", "lifecycle-history-store.mjs")),
    defaultWslSqliteHome(),
    request.rolloutPath ? windowsPathToWsl(request.rolloutPath) : null,
    request.backupDirectory ? windowsPathToWsl(request.backupDirectory) : null,
  ]);
  const wslRequest = {
    ...request,
    sqliteHome,
    ...(rolloutPath ? { rolloutPath } : {}),
    ...(backupDirectory ? { backupDirectory } : {}),
  };
  const encoded = Buffer.from(JSON.stringify(wslRequest)).toString("base64url");
  const { stdout } = await execFileAsync("wsl.exe", [
    "-e", "node", scriptPath, `--request=${encoded}`,
  ], { windowsHide: true, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 120_000 });
  return JSON.parse(String(stdout).trim());
}

async function windowsPathToWsl(path) {
  const { stdout } = await execFileAsync("wsl.exe", ["-e", "wslpath", "-u", path], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 10_000,
  });
  const converted = String(stdout).trim();
  if (!converted.startsWith("/")) throw new Error(`Windows 路径无法转换到 WSL：${path}`);
  return converted;
}

async function defaultWslSqliteHome() {
  const { stdout } = await execFileAsync("wsl.exe", [
    "-e", "sh", "-lc", 'printf "%s" "${CODEX_SQLITE_HOME:-$HOME/.codex/sqlite}"',
  ], { windowsHide: true, encoding: "utf8", timeout: 10_000 });
  const path = String(stdout).trim();
  if (!path.startsWith("/")) throw new Error("无法确定 WSL Codex SQLite 目录");
  return path;
}

async function defaultWslCodexDirectories() {
  const { stdout } = await execFileAsync("wsl.exe", [
    "-e", "sh", "-lc",
    'printf "%s\\n%s\\n" "${CODEX_HOME:-$HOME/.codex}" "${CODEX_SQLITE_HOME:-$HOME/.codex/sqlite}"',
  ], { windowsHide: true, encoding: "utf8", timeout: 10_000 });
  const [codexHome, sqliteHome] = String(stdout).trim().split(/\r?\n/);
  if (!codexHome?.startsWith("/") || !sqliteHome?.startsWith("/")) {
    throw new Error("无法确定 WSL Codex 数据目录");
  }
  return { codexHome, sqliteHome };
}

export { runWindowsHistoryStoreRequest, windowsPathToWsl, defaultWslCodexDirectories };
