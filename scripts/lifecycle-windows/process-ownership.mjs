import { findInjectorListenerPids } from "../../src/lifecycle-host.mjs";
import { join, resolve } from "node:path";
import process from "node:process";
import { execFileAsync, delay } from "./io.mjs";

async function stopWindowsInjectorOwners() {
  const pids = await findInjectorListenerPids();
  for (const pid of pids) {
    const processInfo = await readWindowsProcessInfo(pid);
    const identity = `${processInfo.name} ${processInfo.executablePath} ${processInfo.commandLine}`
      .toLowerCase();
    if (!identity.includes("codex quota injector") &&
      !identity.includes("codex-quota-injector") &&
      !/[\\/]src[\\/]launcher\.mjs/.test(identity)) {
      throw new Error(`49229 端口 PID ${pid} 不是可确认的注入器，拒绝终止`);
    }
    await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T"], {
      windowsHide: true,
    }).catch(() => undefined);
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await findInjectorListenerPids()).length === 0) return;
    await delay(100);
  }
  for (const pid of await findInjectorListenerPids()) {
    await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
    }).catch(() => undefined);
  }
  const forceDeadline = Date.now() + 2_000;
  while (Date.now() < forceDeadline) {
    if ((await findInjectorListenerPids()).length === 0) return;
    await delay(100);
  }
  throw new Error("Windows 注入器单实例监听未在超时内退出");
}

async function waitForWindowsInjectorOwnersExit(expectedPids, {
  findPids = findInjectorListenerPids,
  timeoutMs = 5_000,
  pollIntervalMs = 100,
  wait = delay,
} = {}) {
  const expected = [...new Set((expectedPids ?? [])
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (expected.length === 0) throw new Error("Codex 关闭前没有可跟踪的注入器 PID");
  const expectedSet = new Set(expected);
  const deadline = Date.now() + timeoutMs;
  let remaining = expected;
  while (Date.now() < deadline) {
    remaining = (await findPids()).filter((pid) => expectedSet.has(pid));
    if (remaining.length === 0) {
      return { status: "exited", previousInjectorPids: expected };
    }
    await wait(pollIntervalMs);
  }
  throw new Error(`Codex 已关闭，但旧注入器仍占用单实例监听：PID ${remaining.join(", ")}`);
}

async function windowsInjectorOwnedByInstalledApp(pids, installDir) {
  if (!Array.isArray(pids) || pids.length !== 1) return false;
  const expected = resolve(join(installDir, "Codex Quota Injector.exe")).toLowerCase();
  const actual = resolve((await readWindowsProcessInfo(pids[0])).executablePath || ".")
    .toLowerCase();
  return actual === expected;
}

async function windowsInjectorOwnedBySource(pids, root) {
  if (!Array.isArray(pids) || pids.length !== 1) return false;
  const processInfo = await readWindowsProcessInfo(pids[0]);
  const expectedExecutable = resolve(process.execPath).toLowerCase();
  const expectedLauncher = resolve(join(root, "src", "launcher.mjs"))
    .replaceAll("/", "\\")
    .toLowerCase();
  const actualExecutable = resolve(processInfo.executablePath || ".").toLowerCase();
  const commandLine = processInfo.commandLine.replaceAll("/", "\\").toLowerCase();
  return actualExecutable === expectedExecutable && commandLine.includes(expectedLauncher);
}

async function terminateWindowsRelay(relay) {
  if (!Number.isInteger(relay?.pid) || relay.pid <= 0) throw new Error("中继 PID 无效");
  if (relay.wslNative) {
    await execFileAsync("wsl.exe", ["-e", "kill", "-TERM", String(relay.pid)], {
      windowsHide: true,
    });
    return;
  }
  await execFileAsync("taskkill.exe", ["/PID", String(relay.pid), "/T", "/F"], {
    windowsHide: true,
  });
}

async function readWindowsProcessInfo(pid) {
  const script = `
$item=Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(pid)}' -ErrorAction SilentlyContinue;
if ($item) { $item | Select-Object Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress }
`;
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
  );
  const value = JSON.parse(String(stdout).trim() || "{}");
  return {
    name: String(value.Name ?? ""),
    executablePath: String(value.ExecutablePath ?? ""),
    commandLine: String(value.CommandLine ?? ""),
  };
}

export { stopWindowsInjectorOwners, waitForWindowsInjectorOwnersExit, windowsInjectorOwnedByInstalledApp, windowsInjectorOwnedBySource, terminateWindowsRelay };
