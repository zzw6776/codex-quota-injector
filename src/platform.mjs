import { execFile, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MACOS_EXECUTABLES = [
  "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  "/Applications/Codex.app/Contents/MacOS/Codex",
];
const WINDOWS_EXECUTABLE_NAMES = ["ChatGPT.exe", "Codex.exe"];

let cachedCodexExecutable = null;
let cachedWindowsAppId = null;

export function defaultAccountDataDir() {
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

export function defaultLogDir() {
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

export async function resolveCodexExecutable({ refresh = false } = {}) {
  if (!refresh && cachedCodexExecutable && await exists(cachedCodexExecutable)) {
    return cachedCodexExecutable;
  }

  let resolved = null;
  if (process.platform === "darwin") {
    resolved = await firstExisting(MACOS_EXECUTABLES);
  } else if (process.platform === "win32") {
    resolved =
      await detectRunningWindowsCodexExecutable() ??
      await detectWindowsStoreCodexExecutable() ??
      await firstExisting(windowsCommonExecutableCandidates());
  }

  if (!resolved) {
    throw new Error(
      process.platform === "win32"
        ? "未检测到 Codex，请先从 Microsoft Store 安装 ChatGPT / Codex"
        : "未检测到 /Applications/ChatGPT.app 或 /Applications/Codex.app",
    );
  }
  cachedCodexExecutable = resolved;
  return resolved;
}

export async function resolveCodexCliBinary() {
  const executable = await resolveCodexExecutable();
  const appDir = dirname(executable);
  const candidates = process.platform === "darwin"
    ? [join(appDir, "..", "Resources", "codex")]
    : [
        join(appDir, "resources", "codex.exe"),
        join(appDir, "Resources", "codex.exe"),
        join(appDir, "resources", "codex"),
      ];
  const resolved = await firstExisting(candidates);
  if (!resolved) throw new Error("未找到 Codex 自带的 app-server 可执行文件");
  return resolved;
}

export async function listCodexProcessIds() {
  const executable = await resolveCodexExecutable().catch(() => null);
  if (!executable) return [];

  if (process.platform === "darwin") {
    const { stdout } = await execFileAsync("/bin/ps", ["-axww", "-o", "pid=,comm="]);
    return parseProcessList(stdout, executable);
  }
  if (process.platform === "win32") {
    const expected = powershellQuote(executable.toLowerCase());
    const script = `
$expected='${expected}';
Get-CimInstance Win32_Process |
  Where-Object {
    ($_.Name -eq 'ChatGPT.exe' -or $_.Name -eq 'Codex.exe') -and
    $_.ExecutablePath -and $_.ExecutablePath.ToLowerInvariant() -eq $expected -and
    ($_.CommandLine -notmatch '--type=|crashpad_handler')
  } |
  ForEach-Object { Write-Output $_.ProcessId }
`;
    const stdout = await runPowerShell(script).catch(() => "");
    return stdout
      .split(/\r?\n/)
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value > 0);
  }
  return [];
}

export async function isCodexRunning() {
  if (process.platform !== "darwin" && process.platform !== "win32") return true;
  return (await listCodexProcessIds()).length > 0;
}

export async function stopCodex({ timeoutMs = 10_000 } = {}) {
  const processIds = await listCodexProcessIds();
  if (processIds.length === 0) return;

  if (process.platform === "win32") {
    for (const processId of processIds) {
      await execFileAsync("taskkill.exe", ["/PID", String(processId), "/T"], {
        windowsHide: true,
      }).catch(() => undefined);
    }
  } else {
    for (const processId of processIds) {
      try {
        process.kill(processId, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await listCodexProcessIds()).length === 0) return;
    await delay(250);
  }

  const remaining = await listCodexProcessIds();
  if (process.platform === "win32") {
    for (const processId of remaining) {
      await execFileAsync("taskkill.exe", ["/PID", String(processId), "/T", "/F"], {
        windowsHide: true,
      }).catch(() => undefined);
    }
  } else {
    for (const processId of remaining) {
      try {
        process.kill(processId, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  }

  const forceDeadline = Date.now() + 5_000;
  while (Date.now() < forceDeadline) {
    if ((await listCodexProcessIds()).length === 0) return;
    await delay(250);
  }
  throw new Error("Codex 进程未能在超时内退出");
}

export async function launchCodex(port) {
  const executable = await resolveCodexExecutable({ refresh: true });
  const args = [
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
  ];

  if (process.platform === "darwin") {
    const appRoot = executable.slice(0, executable.lastIndexOf("/Contents/MacOS/"));
    await execFileAsync("/usr/bin/open", ["-na", appRoot, "--args", ...args]);
    return;
  }

  if (process.platform === "win32") {
    const appId = await resolveWindowsCodexAppId();
    if (appId) {
      const argumentList = args.map((value) => `'${powershellQuote(value)}'`).join(",");
      const script = `
$target='shell:AppsFolder\\${powershellQuote(appId)}';
Start-Process -FilePath $target -ArgumentList @(${argumentList}) -ErrorAction Stop | Out-Null
`;
      await runPowerShell(script);
      return;
    }
    const child = spawn(executable, args, {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    child.unref();
    return;
  }

  throw new Error("Codex 启动仅支持 macOS 和 Windows");
}

export async function restartCodex(port) {
  await stopCodex();
  await launchCodex(port);
}

function parseProcessList(processList, executable) {
  const processIds = [];
  for (const line of String(processList).split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (match?.[2] === executable) processIds.push(Number(match[1]));
  }
  return processIds;
}

async function detectRunningWindowsCodexExecutable() {
  const script = `
Get-CimInstance Win32_Process |
  Where-Object {
    ($_.Name -eq 'ChatGPT.exe' -or $_.Name -eq 'Codex.exe') -and
    $_.ExecutablePath -and ($_.CommandLine -notmatch '--type=|crashpad_handler')
  } |
  Select-Object -First 1 -ExpandProperty ExecutablePath
`;
  const stdout = await runPowerShell(script).catch(() => "");
  return firstNonEmptyLine(stdout);
}

async function detectWindowsStoreCodexExecutable() {
  const script = `
$names=@('OpenAI.ChatGPT','OpenAI.ChatGPT-Desktop','OpenAI.Codex');
$pkg=$names |
  ForEach-Object { Get-AppxPackage -Name $_ -ErrorAction SilentlyContinue } |
  Sort-Object @{Expression={if ($_.Name -like 'OpenAI.ChatGPT*') {0} else {1}}}, @{Expression={$_.Version};Descending=$true} |
  Select-Object -First 1;
if (-not $pkg) {
  $pkg=Get-AppxPackage |
    Where-Object {
      $_.Name -like 'OpenAI.ChatGPT*' -or $_.Name -like 'OpenAI.Codex*' -or
      $_.PackageFamilyName -like 'OpenAI.ChatGPT*' -or
      $_.PackageFamilyName -like 'OpenAI.Codex*'
    } |
    Sort-Object @{Expression={if ($_.Name -like 'OpenAI.ChatGPT*' -or $_.PackageFamilyName -like 'OpenAI.ChatGPT*') {0} else {1}}}, @{Expression={$_.Version};Descending=$true} |
    Select-Object -First 1;
}
if ($pkg) {
  foreach ($name in @('ChatGPT.exe','Codex.exe')) {
    $candidate=Join-Path (Join-Path $pkg.InstallLocation 'app') $name;
    if (Test-Path $candidate) { Write-Output $candidate; exit 0 }
  }
}
`;
  const stdout = await runPowerShell(script).catch(() => "");
  return firstNonEmptyLine(stdout);
}

async function resolveWindowsCodexAppId() {
  if (cachedWindowsAppId) return cachedWindowsAppId;
  const script = `
$entry=Get-StartApps |
  Where-Object {
    $_.AppID -like 'OpenAI.ChatGPT*' -or $_.AppID -like 'OpenAI.Codex*' -or
    $_.Name -like 'ChatGPT*' -or $_.Name -like 'Codex*'
  } |
  Sort-Object @{Expression={if ($_.Name -like 'ChatGPT*') {0} else {1}}},Name |
  Select-Object -First 1;
if ($entry) {
  Write-Output $entry.AppID;
  exit 0;
}
$names=@('OpenAI.ChatGPT','OpenAI.ChatGPT-Desktop','OpenAI.Codex');
$pkg=$names |
  ForEach-Object { Get-AppxPackage -Name $_ -ErrorAction SilentlyContinue } |
  Sort-Object @{Expression={if ($_.Name -like 'OpenAI.ChatGPT*') {0} else {1}}}, @{Expression={$_.Version};Descending=$true} |
  Select-Object -First 1;
if (-not $pkg) {
  $pkg=Get-AppxPackage |
    Where-Object {
      $_.Name -like 'OpenAI.ChatGPT*' -or $_.Name -like 'OpenAI.Codex*' -or
      $_.PackageFamilyName -like 'OpenAI.ChatGPT*' -or
      $_.PackageFamilyName -like 'OpenAI.Codex*'
    } |
    Sort-Object @{Expression={if ($_.Name -like 'OpenAI.ChatGPT*' -or $_.PackageFamilyName -like 'OpenAI.ChatGPT*') {0} else {1}}}, @{Expression={$_.Version};Descending=$true} |
    Select-Object -First 1;
}
if ($pkg -and $pkg.PackageFamilyName) {
  Write-Output ($pkg.PackageFamilyName.Trim() + '!App');
}
`;
  const stdout = await runPowerShell(script).catch(() => "");
  cachedWindowsAppId = firstNonEmptyLine(stdout);
  return cachedWindowsAppId;
}

function windowsCommonExecutableCandidates() {
  const roots = [process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs")];
  for (const key of ["PROGRAMFILES", "PROGRAMFILES(X86)"]) {
    if (process.env[key]) roots.push(process.env[key]);
  }
  const relativePaths = [
    ["ChatGPT", "ChatGPT.exe"],
    ["OpenAI ChatGPT", "ChatGPT.exe"],
    ["Codex", "Codex.exe"],
    ["OpenAI Codex", "Codex.exe"],
  ];
  return roots.filter(Boolean).flatMap((root) =>
    relativePaths.map((segments) => join(root, ...segments))
  );
}

async function runPowerShell(script) {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
  );
  return stdout;
}

function powershellQuote(value) {
  return String(value).replaceAll("'", "''");
}

function firstNonEmptyLine(value) {
  return String(value)
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^"|"$/g, ""))
    .find(Boolean) ?? null;
}

async function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (candidate && await exists(candidate)) return candidate;
  }
  return null;
}

async function exists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { parseProcessList };
