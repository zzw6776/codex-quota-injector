import { resolve, join } from "node:path";
import { runPowerShell, powershellQuote, firstNonEmptyLine, exists } from "./contract.mjs";
import { windowsCodexAppCacheRoot } from "./directories.mjs";

let cachedWindowsStoreExecutable = null;

let cachedWindowsStoreAppId = null;

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

export { detectRunningWindowsCodexExecutable, detectWindowsStoreCodexExecutable, windowsCommonExecutableCandidates, isWindowsStoreExecutable, detectWindowsStoreCodexAppId };
