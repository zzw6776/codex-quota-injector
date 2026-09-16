import { execFileAsync, runPowerShell, powershellQuote } from "./contract.mjs";
import { resolveCodexExecutable } from "./executables.mjs";
import { windowsCodexAppCacheRoot, windowsCodexUpstreamRoot } from "./directories.mjs";
import { parseProcessList, parseMacCodexLifecycleProcesses } from "./process-parsing.mjs";

async function listCodexProcessIds() {
  const executable = await resolveCodexExecutable().catch(() => null);
  if (!executable) return [];

  if (process.platform === "darwin") {
    const { stdout } = await execFileAsync("/bin/ps", ["-axww", "-o", "pid=,comm="]);
    return parseProcessList(stdout, executable);
  }
  if (process.platform === "win32") {
    const expected = powershellQuote(executable.toLowerCase());
    const cacheRoot = powershellQuote(`${windowsCodexAppCacheRoot().toLowerCase()}\\`);
    const upstreamRoot = powershellQuote(`${windowsCodexUpstreamRoot().toLowerCase()}\\`);
    // The isolated wakeup client's log_dir argument contains codex-quota-wakeup-.
    // It must not keep the injector alive after the desktop app exits.
    const script = `
$expected='${expected}';
$cacheRoot='${cacheRoot}';
$upstreamRoot='${upstreamRoot}';
Get-CimInstance Win32_Process |
  Where-Object {
    (($_.Name -eq 'ChatGPT.exe' -or $_.Name -eq 'Codex.exe') -and
      $_.ExecutablePath -and
      ($_.ExecutablePath.ToLowerInvariant() -eq $expected -or
        $_.ExecutablePath.ToLowerInvariant().StartsWith($cacheRoot, [StringComparison]::OrdinalIgnoreCase)) -and
      ($_.CommandLine -notmatch '--type=|crashpad_handler')) -or
    ($_.Name -eq 'codex-upstream.exe' -and
      ($_.CommandLine -notmatch 'codex-quota-wakeup-') -and
      $_.ExecutablePath -and
      $_.ExecutablePath.ToLowerInvariant().StartsWith($upstreamRoot, [StringComparison]::OrdinalIgnoreCase))
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

async function listMacCodexLifecycleProcesses({
  executable: providedExecutable,
  execFileImpl = execFileAsync,
} = {}) {
  const executable = providedExecutable ?? await resolveCodexExecutable().catch(() => null);
  if (!executable) return [];
  const { stdout } = await execFileImpl("/bin/ps", ["-axww", "-o", "pid=,comm="]);
  return parseMacCodexLifecycleProcesses(stdout, executable);
}

async function listCodexDesktopProcessIds({
  platform = process.platform,
  executable: providedExecutable,
  execFileImpl = execFileAsync,
} = {}) {
  const executable = providedExecutable ?? await resolveCodexExecutable().catch(() => null);
  if (!executable) return [];
  if (platform === "darwin") {
    const { stdout } = await execFileImpl("/bin/ps", ["-axww", "-o", "pid=,comm="]);
    return parseProcessList(stdout, executable);
  }
  if (platform !== "win32") return [];
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
  const { stdout } = await execFileImpl(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
  ).catch(() => ({ stdout: "" }));
  return String(stdout)
    .split(/\r?\n/)
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
}

async function isCodexRunning() {
  if (process.platform !== "darwin" && process.platform !== "win32") return true;
  return (await listCodexProcessIds()).length > 0;
}

export { listCodexProcessIds, listMacCodexLifecycleProcesses, listCodexDesktopProcessIds, isCodexRunning };
