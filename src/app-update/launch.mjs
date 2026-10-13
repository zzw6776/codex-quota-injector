import { spawn } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, open, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { isSea } from "node:sea";
import { randomUUID } from "node:crypto";
import { cleanUpdateEnvironment } from "./native-install.mjs";
import { WINDOWS_UPDATE_WINDOW } from "./windows-window.mjs";
import { resolveDevUpdateWindow } from "./window-executable.mjs";

export async function activeUpdate(registryPath) {
  try {
    const descriptor = JSON.parse(await readFile(registryPath, "utf8"));
    process.kill(descriptor.pid, 0);
    if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/[a-f0-9]{48}\/$/.test(descriptor.url) || Number(new URL(descriptor.url).port) > 65535) return null;
    const state = await fetch(`${descriptor.url}state`, { signal: AbortSignal.timeout(1500) }).then(response => response.json());
    return state.id === descriptor.id ? { ...descriptor, windowReady: state.windowReady !== false,
      windowError: state.windowError ?? null, status: state.status, version: state.version,
      assetId: state.assetId, ownerPid: state.ownerPid, currentVersion: state.currentVersion,
      releaseNotes: state.releaseNotes ?? "" } : null;
  } catch { return null; }
}

export async function waitForUpdateWindow({ registryPath, id, logPath, childState = () => null },
  { readActive = activeUpdate, timeoutMs = 30_000, now = Date.now,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const deadline = now() + timeoutMs;
  while (true) {
    const exit = childState();
    if (exit) throw new Error(`更新状态窗口进程已退出（${exit}），日志：${logPath}`);
    const descriptor = await readActive(registryPath);
    if (descriptor?.id === id && descriptor.windowError) {
      throw new Error(`${descriptor.windowError}，日志：${logPath}`);
    }
    if (descriptor?.id === id && descriptor.windowReady) return descriptor;
    if (now() >= deadline) throw new Error(`更新状态窗口启动超时，日志：${logPath}`);
    await sleep(100);
  }
}

export function canReuseUpdateWindow(window, asset, owner) {
  if (!window) return false;
  if (!["confirm", "success", "failed", "cancelled"].includes(window.status)) return true;
  return window.status === "confirm" && window.version === asset.version && window.assetId === asset.assetId &&
    window.ownerPid === owner.pid && window.currentVersion === owner.version &&
    (window.releaseNotes ?? "") === (asset.releaseNotes ?? "");
}

export async function launchUpdateWindow(asset, { dataDir, owner, threadId, launchOptions, cdpPort = 9229 } = {}) {
  const registryPath = join(dataDir, "update-window.json");
  const existing = await activeUpdate(registryPath);
  if (canReuseUpdateWindow(existing, asset, owner)) {
    const response = await fetch(`${existing.url}show`, { method: "POST", signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error(`无法打开更新状态窗口，日志：${existing.logPath ?? join(dataDir, "updates")}`);
    return waitForUpdateWindow({ registryPath, id: existing.id, logPath: existing.logPath ?? join(dataDir, "updates") });
  }
  if (existing?.status === "confirm") {
    const response = await fetch(`${existing.url}close`, { method: "POST", signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error("更新已经开始，请先终止当前更新，再打开最新版本");
    const deadline = Date.now() + 5000;
    while ((await activeUpdate(registryPath))?.id === existing.id) {
      if (Date.now() >= deadline) throw new Error("旧确认窗口尚未关闭，请稍后重新打开更新入口");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  const updateRoot = join(dataDir, "updates");
  await mkdir(updateRoot, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(updateRoot, "update-"));
  const formal = isSea();
  let executable = process.execPath;
  let args = [];
  if (formal) {
    executable = join(directory, process.platform === "win32" ? "update-worker.exe" : "update-worker");
    await copyFile(process.execPath, executable);
  } else args = [resolve(import.meta.dirname, "..", "launcher.mjs")];
  const installedApp = process.platform === "darwin"
    ? formal ? dirname(dirname(dirname(process.execPath))) : "/Applications/Codex Quota Injector.app"
    : formal ? dirname(process.execPath) : join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Programs", "Codex Quota Injector");
  let windowExecutable, windowScript;
  if (process.platform === "darwin") {
    windowExecutable = join(directory, "Update Window");
    if (formal) await copyFile(join(dirname(process.execPath), "Codex Quota Injector Update Window"), windowExecutable);
    else await copyFile(await resolveDevUpdateWindow(), windowExecutable);
  } else {
    windowExecutable = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    windowScript = join(directory, "update-window.ps1");
    await writeFile(windowScript, `\uFEFF${WINDOWS_UPDATE_WINDOW}`, { mode: 0o600 });
  }
  const wslNative = launchOptions?.relay?.wslNative === true;
  let wslRelay = null;
  if (wslNative) {
    const source = launchOptions?.env?.CODEX_CLI_PATH;
    if (!source) throw new Error("未能定位当前 WSL 中继，无法核验任务历史");
    wslRelay = join(directory, "update-history-relay");
    await copyFile(source, wslRelay);
  }
  await access(windowExecutable);
  const control = { id: randomUUID(), directory, registryPath, asset, owner, dataDir, installedApp,
    threadId: threadId ?? null, cdpPort, wslNative, wslRelay, windowExecutable, windowScript,
    codexHome: process.env.CODEX_HOME ?? join(homedir(), ".codex"),
    sqliteHome: process.env.CODEX_SQLITE_HOME ?? process.env.CODEX_HOME ?? join(homedir(), ".codex") };
  const path = join(directory, "control.json");
  await writeFile(path, JSON.stringify(control), { mode: 0o600 });
  const logPath = join(directory, "updater.log");
  const log = await open(logPath, "a", 0o600);
  let child, exit = null;
  try {
    child = spawn(executable, args, { detached: true, stdio: ["ignore", log.fd, log.fd], windowsHide: true,
      env: { ...cleanUpdateEnvironment(), CODEX_QUOTA_ROLE: "app-updater", CODEX_QUOTA_UPDATE_CONTROL: path } });
    child.once("exit", (code, signal) => { exit = signal ? `信号 ${signal}` : `退出码 ${code}`; });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  } finally { await log.close(); }
  child.unref();
  return waitForUpdateWindow({ registryPath, id: control.id, logPath, childState: () => exit });
}
