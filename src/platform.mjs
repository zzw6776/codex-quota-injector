import { execFile, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { isCodexDebugPortReady } from "./cdp-client.mjs";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MACOS_EXECUTABLES = [
  "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  "/Applications/Codex.app/Contents/MacOS/Codex",
];
const MACOS_CODEX_BUNDLE_ID = "com.openai.codex";
const WINDOWS_EXECUTABLE_NAMES = ["ChatGPT.exe", "Codex.exe"];
const WINDOWS_CODEX_CACHE_DIR = "codex-upstream";
const WINDOWS_CODEX_CACHE_FILE = "codex-upstream.exe";
const WINDOWS_CODEX_CACHE_MANIFEST = "manifest.json";
const RELAY_PROCESS_START_TIME_TOLERANCE_MS = 30_000;

let cachedCodexExecutable = null;

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
    resolved =
      await detectRunningMacCodexExecutable() ??
      await firstExisting(MACOS_EXECUTABLES);
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

export async function resolveCodexCliExecutable() {
  if (process.env.CODEX_QUOTA_UPSTREAM_CODEX_CLI) {
    const overridden = resolve(process.env.CODEX_QUOTA_UPSTREAM_CODEX_CLI);
    if (await exists(overridden)) return overridden;
    throw new Error(`指定的 Codex CLI 不存在: ${overridden}`);
  }
  const appExecutable = await resolveCodexExecutable({ refresh: true });
  const candidates = process.platform === "win32"
    ? [
      join(dirname(appExecutable), "resources", "codex.exe"),
      join(dirname(appExecutable), "resources", "codex"),
      join(dirname(appExecutable), "Resources", "codex.exe"),
      join(dirname(appExecutable), "Resources", "codex"),
    ]
    : [join(dirname(dirname(appExecutable)), "Resources", "codex")];
  const candidate = await firstExisting(candidates);
  if (!candidate) {
    throw new Error(`Codex App Server 可执行文件不存在: ${candidates.join(" / ")}`);
  }
  return process.platform === "win32"
    ? materializeWindowsCodexCli(candidate)
    : candidate;
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

export async function stopCodex({ timeoutMs = 2_000 } = {}) {
  const processIds = await listCodexProcessIds();
  if (processIds.length === 0) return;

  if (process.platform === "win32") {
    await Promise.all(processIds.map((processId) =>
      execFileAsync("taskkill.exe", ["/PID", String(processId), "/T", "/F"], {
        windowsHide: true,
      }).catch(() => undefined)
    ));
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

  const forceDeadline = Date.now() + (process.platform === "win32" ? 2_000 : 5_000);
  while (Date.now() < forceDeadline) {
    if ((await listCodexProcessIds()).length === 0) return;
    await delay(250);
  }
  throw new Error("Codex 进程未能在超时内退出");
}

export async function launchCodex(
  port,
  { env = {}, executable: providedExecutable = null } = {},
) {
  const executable = providedExecutable ?? await resolveCodexExecutable({ refresh: true });
  const args = [
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
  ];

  if (process.platform === "darwin") {
    await execFileAsync("/usr/bin/open", [
      "-b",
      MACOS_CODEX_BUNDLE_ID,
      ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      "--args",
      ...args,
    ]);
    return;
  }

  if (process.platform === "win32") {
    const child = spawn(executable, args, {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, ...env },
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    return;
  }

  throw new Error("Codex 启动仅支持 macOS 和 Windows");
}

export async function restartCodex(port, options = {}) {
  const executable = await resolveCodexExecutable();
  await stopCodex();
  await launchCodex(port, { ...options, executable });
  let readiness = await waitForCodexLaunchReady(port, options);
  if (readiness.ready) {
    await activateCodex(executable);
    return;
  }

  if (process.platform === "win32") {
    throw new Error(formatCodexReadinessError(port, readiness));
  }

  console.warn("[launcher] Codex 首次启动未开放调试端口，正在重新启动");
  await stopCodex();
  await launchCodex(port, { ...options, executable });
  readiness = await waitForCodexLaunchReady(port, options);
  if (readiness.ready) {
    await activateCodex(executable);
    return;
  }

  throw new Error(formatCodexReadinessError(port, readiness));
}

export async function isCodexLaunchReady(port, options = {}) {
  return (await readCodexLaunchReadiness(port, options)).ready;
}

export async function activateCodex(providedExecutable = null) {
  try {
    if (process.platform === "darwin") {
      await execFileAsync("/usr/bin/open", ["-b", MACOS_CODEX_BUNDLE_ID]);
      return true;
    }
    if (process.platform !== "win32") return false;

    const executable = providedExecutable ?? await resolveCodexExecutable();
    const appId = await detectWindowsStoreCodexAppId(executable);
    if (!appId) {
      console.warn("[launcher] 未找到 Windows Codex 官方应用入口，无法激活现有窗口");
      return false;
    }
    await execFileAsync("explorer.exe", [`shell:AppsFolder\\${appId}`], {
      windowsHide: true,
    });
    console.log(`[launcher] 已通过 Windows 官方入口激活 Codex 窗口（${appId}）`);
    return true;
  } catch (error) {
    console.warn(`[launcher] Codex 窗口激活失败: ${error.message}`);
    return false;
  }
}

export async function isRelayStateCurrent(path, generation) {
  try {
    const state = JSON.parse(await readFile(path, "utf8"));
    if (generation != null && state?.generation !== generation) return false;
    if (!Number.isInteger(state?.pid)) return false;
    if (!Number.isFinite(Number(state?.processStartedAt))) return false;
    process.kill(state.pid, 0);
    const processStartedAt = await readProcessStartedAt(state.pid);
    if (!Number.isFinite(processStartedAt)) return false;
    return Math.abs(processStartedAt - Number(state.processStartedAt)) <=
      RELAY_PROCESS_START_TIME_TOLERANCE_MS;
  } catch {
    return false;
  }
}

async function readProcessStartedAt(processId) {
  if (process.platform === "win32") {
    const script = `
$processId=${Number(processId)};
Get-CimInstance Win32_Process -Filter "ProcessId = $processId" |
  Select-Object -First 1 @{Name='startedAt';Expression={([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}} |
  ConvertTo-Json -Compress
`;
    const stdout = await runPowerShell(script).catch(() => "");
    if (!stdout.trim()) return null;
    try {
      const value = JSON.parse(stdout);
      const startedAt = Number(value?.startedAt);
      return Number.isFinite(startedAt) ? startedAt : null;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    const { stdout } = await execFileAsync(
      "/bin/ps",
      ["-p", String(processId), "-o", "etimes="],
    ).catch(() => ({ stdout: "" }));
    const elapsedSeconds = Number(firstNonEmptyLine(stdout));
    return Number.isFinite(elapsedSeconds)
      ? Date.now() - elapsedSeconds * 1000
      : null;
  }
  return null;
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

async function detectRunningMacCodexExecutable() {
  const { stdout } = await execFileAsync("/bin/ps", ["-axww", "-o", "pid=,comm="])
    .catch(() => ({ stdout: "" }));
  return MACOS_EXECUTABLES.find((executable) =>
    parseProcessList(stdout, executable).length > 0
  ) ?? null;
}

async function materializeWindowsCodexCli(source) {
  const dataDir = defaultAccountDataDir();
  const sourceDir = dirname(source);
  const helperEntries = (await readdir(sourceDir, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const sourceFiles = [
    { sourcePath: source, targetName: WINDOWS_CODEX_CACHE_FILE },
    ...helperEntries
      .filter((entry) =>
        entry.isFile() &&
        /^codex.*\.exe$/i.test(entry.name) &&
        entry.name.toLowerCase() !== "codex.exe"
      )
      .map((entry) => ({
        sourcePath: join(sourceDir, entry.name),
        targetName: entry.name,
      })),
  ];
  const sourceRecords = [];
  for (const file of sourceFiles) {
    const info = await stat(file.sourcePath);
    sourceRecords.push({
      ...file,
      size: info.size,
      mtimeMs: info.mtimeMs,
    });
  }

  const mainSource = sourceRecords[0];
  const cacheKey = `${mainSource.size}-${Math.trunc(mainSource.mtimeMs)}`;
  const cacheDir = join(dataDir, WINDOWS_CODEX_CACHE_DIR, cacheKey);
  const target = join(cacheDir, WINDOWS_CODEX_CACHE_FILE);
  const manifestPath = join(cacheDir, WINDOWS_CODEX_CACHE_MANIFEST);
  const manifest = await readJsonFile(manifestPath);
  const expectedFiles = sourceRecords.map(({ targetName, size, mtimeMs }) => ({
    targetName,
    size,
    mtimeMs,
  }));
  const manifestMatches = manifest?.version === 2 &&
    manifest.sourcePath === source &&
    JSON.stringify(manifest.files) === JSON.stringify(expectedFiles);
  if (manifestMatches && await Promise.all(sourceRecords.map(({ targetName, size }) =>
    isFileWithSize(join(cacheDir, targetName), size)
  )).then((values) => values.every(Boolean))) {
    return target;
  }

  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const temporaryPaths = [];
  try {
    for (const file of sourceRecords) {
      const temporaryPath = join(
        cacheDir,
        `.${file.targetName}.${process.pid}.${Date.now()}.tmp`,
      );
      temporaryPaths.push(temporaryPath);
      await copyFile(file.sourcePath, temporaryPath);
      await unlink(join(cacheDir, file.targetName)).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      await rename(temporaryPath, join(cacheDir, file.targetName));
    }
    await writeFile(manifestPath, `${JSON.stringify({
      version: 2,
      sourcePath: source,
      files: expectedFiles,
    })}\n`, { encoding: "utf8", mode: 0o600 });
    return target;
  } catch (error) {
    await Promise.all(temporaryPaths.map((path) => unlink(path).catch(() => undefined)));
    throw new Error(`无法准备 Windows Codex CLI 及旁车组件：${error.message}`);
  }
}

async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return null;
  }
}

async function isFileWithSize(path, size) {
  try {
    const info = await stat(path);
    return info.isFile() && info.size === size;
  } catch {
    return false;
  }
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

async function detectWindowsStoreCodexAppId(executable) {
  const target = powershellQuote(executable);
  const script = `
$targetPath=[IO.Path]::GetFullPath('${target}');
$package=Get-AppxPackage |
  Where-Object {
    if ([string]::IsNullOrWhiteSpace($_.InstallLocation)) { return $false }
    $installRoot=[IO.Path]::GetFullPath($_.InstallLocation).TrimEnd('\\') + '\\';
    $targetPath.StartsWith($installRoot, [StringComparison]::OrdinalIgnoreCase)
  } |
  Sort-Object @{Expression={$_.InstallLocation.Length};Descending=$true} |
  Select-Object -First 1;
if ($package) {
  $app=Get-StartApps |
    Where-Object { $_.AppID -like ($package.PackageFamilyName + '!*') } |
    Select-Object -First 1;
  if ($app) { Write-Output $app.AppID }
}
`;
  const stdout = await runPowerShell(script).catch(() => "");
  return firstNonEmptyLine(stdout);
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

async function waitForCodexLaunchReady(port, options, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let readiness = { ready: false, debugReady: false, relayReady: false };
  while (Date.now() < deadline) {
    readiness = await readCodexLaunchReadiness(port, options);
    if (readiness.ready) return readiness;
    await delay(250);
  }
  return readiness;
}

async function readCodexLaunchReadiness(port, options = {}) {
  const debugReady = await isCodexDebugPortReady(port, { timeoutMs: 1_000 });
  const relay = options?.relay;
  const relayReady = !relay
    ? true
    : relay.expectAbsent
      ? !await isRelayStateCurrent(relay.statePath)
      : await isRelayStateCurrent(relay.statePath, relay.generation);
  return {
    ready: debugReady && relayReady,
    debugReady,
    relayReady,
  };
}

function formatCodexReadinessError(port, readiness) {
  const debugStatus = readiness.debugReady ? "正常" : "不可用";
  const relayStatus = readiness.relayReady ? "正常" : "未就绪";
  return `Codex 启动后未就绪：调试端口 ${port}=${debugStatus}，模型中继=${relayStatus}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { parseProcessList };
