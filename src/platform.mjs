import { execFile, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { isCodexDebugPortReady } from "./cdp-client.mjs";
import {
  access,
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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
const WINDOWS_CODEX_APP_CACHE_DIR = "codex-app";
const WINDOWS_CODEX_APP_CACHE_MANIFEST = "manifest.json";
const RELAY_PROCESS_START_TIME_TOLERANCE_MS = 30_000;

let cachedCodexExecutable = null;
let cachedWindowsStoreExecutable = null;
let cachedWindowsStoreAppId = null;

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
    const cacheRoot = powershellQuote(`${windowsCodexAppCacheRoot().toLowerCase()}\\`);
    const script = `
$expected='${expected}';
$cacheRoot='${cacheRoot}';
Get-CimInstance Win32_Process |
  Where-Object {
    ($_.Name -eq 'ChatGPT.exe' -or $_.Name -eq 'Codex.exe') -and
    $_.ExecutablePath -and
    ($_.ExecutablePath.ToLowerInvariant() -eq $expected -or
      $_.ExecutablePath.ToLowerInvariant().StartsWith($cacheRoot, [StringComparison]::OrdinalIgnoreCase)) -and
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
    if (!isAnyProcessAlive(processIds)) {
      if (process.platform === "darwin") await delay(200);
      return;
    }
    await delay(100);
  }

  const remaining = processIds.filter(isProcessAlive);
  if (remaining.length === 0) {
    if (process.platform === "darwin") await delay(200);
    return;
  }

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

  const forceDeadline = Date.now() + (process.platform === "win32" ? 1_000 : 3_000);
  while (Date.now() < forceDeadline) {
    if (!isAnyProcessAlive(remaining)) {
      if (process.platform === "darwin") await delay(200);
      return;
    }
    await delay(100);
  }
  throw new Error("Codex 进程未能在超时内退出");
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isAnyProcessAlive(pids) {
  return pids.some(isProcessAlive);
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
    const appPath = executable.includes(".app")
      ? executable.slice(0, executable.indexOf(".app") + 4)
      : null;
    const openTarget = appPath ? ["-a", appPath] : ["-b", MACOS_CODEX_BUNDLE_ID];
    const envArgs = Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
    const fullArgs = [
      "-n",
      ...openTarget,
      ...envArgs,
      "--args",
      ...args,
    ];
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await execFileAsync("/usr/bin/open", fullArgs);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await delay(300);
      }
    }
    throw lastError;
  }

  if (process.platform === "win32") {
    const launchableExecutable = isWindowsStoreExecutable(executable)
      ? await materializeWindowsStoreCodexExecutable(executable)
      : executable;
    let child;
    try {
      child = spawn(launchableExecutable, args, {
        detached: true,
        windowsHide: false,
        stdio: "ignore",
        env: { ...process.env, ...env },
      });
      await waitForChildSpawn(child);
      child.unref();
    } catch (error) {
      if (error?.code !== "EPERM") throw error;
      await launchWindowsExecutableThroughShell(launchableExecutable, args, env);
    }
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
      const executable = providedExecutable ?? await resolveCodexExecutable().catch(() => null);
      const appPath = executable?.includes(".app")
        ? executable.slice(0, executable.indexOf(".app") + 4)
        : null;
      if (appPath) {
        await execFileAsync("/usr/bin/open", ["-a", appPath]).catch(() =>
          execFileAsync("/usr/bin/open", ["-b", MACOS_CODEX_BUNDLE_ID])
        );
      } else {
        await execFileAsync("/usr/bin/open", ["-b", MACOS_CODEX_BUNDLE_ID]);
      }
      return true;
    }
    if (process.platform !== "win32") return false;

    const executable = providedExecutable ?? await resolveCodexExecutable();
    const processIds = await listCodexProcessIds();
    const appId = await detectWindowsStoreCodexAppId(executable);
    const pidArrayLiteral = processIds.map((pid) => Number(pid)).filter(Boolean).join(",");
    const escapedAppId = appId ? powershellQuote(appId) : "";

    const script = `
$shell=New-Object -ComObject WScript.Shell;
$pids=@(${pidArrayLiteral});
foreach ($p in $pids) {
  if ($shell.AppActivate($p)) { Write-Output 'activated'; exit 0 }
}
if ('${escapedAppId}') {
  Start-Process 'explorer.exe' -ArgumentList 'shell:AppsFolder\\${escapedAppId}' -WindowStyle Hidden;
  Write-Output 'app_invoked';
  exit 0;
}
`;
    const stdout = await runPowerShell(script).catch(() => "");
    const result = firstNonEmptyLine(stdout);
    if (result === "activated") {
      console.log(`[launcher] 已激活 Codex 窗口`);
      return true;
    }
    if (result === "app_invoked") {
      console.log(`[launcher] 已通过 Windows 官方入口激活 Codex 窗口（${appId}）`);
      return true;
    }

    console.warn("[launcher] Codex 已运行，但未能自动置前窗口");
    return false;
  } catch (error) {
    console.warn(`[launcher] Codex 窗口激活失败: ${error.message}`);
    return false;
  }
}

export async function isRelayConfigCurrent(path, generation) {
  try {
    const data = JSON.parse(await readFile(path, "utf8"));
    if (generation != null && data?.generation !== generation) return false;
    return true;
  } catch {
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
  const cacheRoot = powershellQuote(`${windowsCodexAppCacheRoot().toLowerCase()}\\`);
  const script = `
$cacheRoot='${cacheRoot}';
Get-CimInstance Win32_Process |
  Where-Object {
    ($_.Name -eq 'ChatGPT.exe' -or $_.Name -eq 'Codex.exe') -and
    $_.ExecutablePath -and
    ($_.ExecutablePath.ToLowerInvariant().StartsWith($cacheRoot, [StringComparison]::OrdinalIgnoreCase)) -eq $false -and
    ($_.CommandLine -notmatch '--type=|crashpad_handler')
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

async function materializeWindowsStoreCodexExecutable(source) {
  const sourceInfo = await stat(source);
  const sourceDirectory = dirname(source);
  const targetName = basename(source);
  const cacheKey = `${sourceInfo.size}-${Math.trunc(sourceInfo.mtimeMs)}`;
  const cacheDirectory = join(windowsCodexAppCacheRoot(), cacheKey);
  const target = join(cacheDirectory, targetName);
  const manifestPath = join(cacheDirectory, WINDOWS_CODEX_APP_CACHE_MANIFEST);
  const expectedManifest = {
    version: 1,
    sourcePath: source,
    sourceSize: sourceInfo.size,
    sourceMtimeMs: sourceInfo.mtimeMs,
    targetName,
  };
  const manifest = await readJsonFile(manifestPath);
  if (JSON.stringify(manifest) === JSON.stringify(expectedManifest) &&
    await isFileWithSize(target, sourceInfo.size)) {
    return target;
  }

  await mkdir(dirname(cacheDirectory), { recursive: true, mode: 0o700 });
  const temporaryDirectory = `${cacheDirectory}.${process.pid}.${Date.now()}.tmp`;
  try {
    await cp(sourceDirectory, temporaryDirectory, {
      recursive: true,
      force: true,
      preserveTimestamps: true,
    });
    await writeFile(
      join(temporaryDirectory, WINDOWS_CODEX_APP_CACHE_MANIFEST),
      `${JSON.stringify(expectedManifest)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporaryDirectory, cacheDirectory);
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    if (await isFileWithSize(target, sourceInfo.size)) return target;
    throw new Error(`无法准备 Windows Store Codex 启动副本：${error.message}`);
  }

  if (await isFileWithSize(target, sourceInfo.size)) return target;
  throw new Error(`Windows Store Codex 启动副本无效：${target}`);
}

function windowsCodexAppCacheRoot() {
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  return join(localAppData, "Codex Quota Injector", WINDOWS_CODEX_APP_CACHE_DIR);
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
  if (cachedWindowsStoreExecutable && await exists(cachedWindowsStoreExecutable)) {
    return cachedWindowsStoreExecutable;
  }
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
  const result = firstNonEmptyLine(stdout);
  if (result) cachedWindowsStoreExecutable = result;
  return result;
}

async function detectWindowsStoreCodexAppId(executable) {
  if (cachedWindowsStoreAppId) return cachedWindowsStoreAppId;
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
if (-not $package) {
  $package=@('OpenAI.ChatGPT','OpenAI.ChatGPT-Desktop','OpenAI.Codex') |
    ForEach-Object { Get-AppxPackage -Name $_ -ErrorAction SilentlyContinue } |
    Sort-Object @{Expression={if ($_.Name -like 'OpenAI.ChatGPT*') {0} else {1}}}, @{Expression={$_.Version};Descending=$true} |
    Select-Object -First 1;
}
if (-not $package) {
  $package=Get-AppxPackage |
    Where-Object {
      $_.Name -like 'OpenAI.ChatGPT*' -or $_.Name -like 'OpenAI.Codex*' -or
      $_.PackageFamilyName -like 'OpenAI.ChatGPT*' -or
      $_.PackageFamilyName -like 'OpenAI.Codex*'
    } |
    Sort-Object @{Expression={if ($_.Name -like 'OpenAI.ChatGPT*' -or $_.PackageFamilyName -like 'OpenAI.ChatGPT*') {0} else {1}}}, @{Expression={$_.Version};Descending=$true} |
    Select-Object -First 1;
}
if ($package) {
  $app=Get-StartApps |
    Where-Object { $_.AppID -like ($package.PackageFamilyName + '!*') } |
    Select-Object -First 1;
  if ($app) { Write-Output $app.AppID }
}
`;
  const stdout = await runPowerShell(script).catch(() => "");
  const result = firstNonEmptyLine(stdout);
  if (result) cachedWindowsStoreAppId = result;
  return result;
}

function isWindowsStoreExecutable(executable) {
  const normalizedExecutable = resolve(executable).toLowerCase();
  return normalizedExecutable.includes("\\windowsapps\\");
}

async function launchWindowsExecutableThroughShell(executable, args, env) {
  const child = spawn(process.env.ComSpec || "cmd.exe", [
    "/d",
    "/c",
    "start",
    "",
    executable,
    ...args,
  ], {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env: { ...process.env, ...env },
  });
  await waitForChildSpawn(child);
  child.unref();
}

function waitForChildSpawn(child) {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
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
  const relayPath = relay?.configPath ?? relay?.statePath;
  const relayReady = !relay
    ? true
    : relay.expectAbsent
      ? true
      : relayPath
        ? await isRelayConfigCurrent(relayPath, relay.generation)
        : true;
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
