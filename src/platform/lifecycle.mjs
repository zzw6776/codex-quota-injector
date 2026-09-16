import { spawn } from "node:child_process";
import { execFileAsync, signalProcesses, isProcessAlive, isAnyProcessAlive, delay, MACOS_CODEX_BUNDLE_ID, runPowerShell, powershellQuote, firstNonEmptyLine } from "./contract.mjs";
import { resolveCodexExecutable } from "./executables.mjs";
import { isWindowsStoreExecutable, detectWindowsStoreCodexAppId } from "./windows-discovery.mjs";
import { listCodexProcessIds } from "./processes.mjs";
import { stopMacCodex } from "./macos-lifecycle.mjs";
import { waitForCodexLaunchReady, formatCodexReadinessError } from "./readiness.mjs";
import { materializeWindowsStoreCodexExecutable } from "./windows-artifacts.mjs";

async function stopCodex({ timeoutMs = 5_000 } = {}) {
  if (process.platform === "darwin") {
    await stopMacCodex({ timeoutMs });
    return;
  }

  const processIds = await listCodexProcessIds();
  if (processIds.length === 0) return;

  if (process.platform === "win32") {
    let closeRequested = false;
    try {
      closeRequested = await requestWindowsCodexQuit({ processIds });
    } catch (error) {
      console.warn(`[platform] Codex 正常退出请求失败，将等待后强制终止：${error.message}`);
    }
    if (!closeRequested) {
      await Promise.all(processIds.map((processId) =>
        execFileAsync("taskkill.exe", ["/PID", String(processId), "/T"], {
          windowsHide: true,
        }).catch(() => undefined)
      ));
    }
  } else {
    signalProcesses(processIds, "SIGTERM");
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAnyProcessAlive(processIds)) {
      return;
    }
    await delay(100);
  }

  const remaining = processIds.filter(isProcessAlive);
  if (remaining.length === 0) {
    return;
  }

  if (process.platform === "win32") {
    for (const processId of remaining) {
      await execFileAsync("taskkill.exe", ["/PID", String(processId), "/T", "/F"], {
        windowsHide: true,
      }).catch(() => undefined);
    }
  } else {
    signalProcesses(remaining, "SIGKILL");
  }

  const forceDeadline = Date.now() + (process.platform === "win32" ? 1_000 : 3_000);
  while (Date.now() < forceDeadline) {
    if (!isAnyProcessAlive(remaining)) {
      return;
    }
    await delay(100);
  }
  throw new Error("Codex 进程未能在超时内退出");
}

async function requestWindowsCodexQuit({
  processIds,
  execFileImpl = execFileAsync,
} = {}) {
  const ids = [...new Set((processIds ?? [])
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0))];
  if (ids.length === 0) return false;
  const script = `
$requested=$false;
foreach ($processId in @(${ids.join(",")})) {
  $target=Get-Process -Id $processId -ErrorAction SilentlyContinue;
  if ($target -and $target.MainWindowHandle -ne 0 -and $target.CloseMainWindow()) {
    $requested=$true;
  }
}
if ($requested) { Write-Output 'requested' }
`;
  const { stdout = "" } = await execFileImpl(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
  );
  return String(stdout).trim() === "requested";
}

async function launchCodex(
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
    const launchEnvironment = codexLaunchEnvironment(process.env, env);
    let child;
    try {
      child = spawn(launchableExecutable, args, {
        detached: true,
        windowsHide: false,
        stdio: "ignore",
        env: launchEnvironment,
      });
      await waitForChildSpawn(child);
      child.unref();
    } catch (error) {
      if (error?.code !== "EPERM") throw error;
      await launchWindowsExecutableThroughShell(launchableExecutable, args, launchEnvironment);
    }
    return;
  }

  throw new Error("Codex 启动仅支持 macOS 和 Windows");
}

function codexLaunchEnvironment(environment = {}, overrides = {}) {
  const result = { ...environment, ...overrides };
  // Codex Desktop creates a fresh app-tools pipe for each process. A launcher
  // invoked from an existing Codex task otherwise carries that task's dead pipe
  // into the replacement desktop and prevents codex_app from registering.
  delete result.CODEX_APP_TOOLS_PIPE_PATH;
  return result;
}

async function restartCodex(port, options = {}) {
  const executable = await resolveCodexExecutable();
  await stopCodex();
  await launchCodex(port, { ...options, executable });
  let readiness = await waitForCodexLaunchReady(port, options);
  if (readiness.ready) {
    await activateCodex(executable);
    return;
  }

  console.warn(`[launcher] ${formatCodexReadinessError(port, readiness)}，正在重新启动重试`);
  await stopCodex();
  await launchCodex(port, { ...options, executable });
  readiness = await waitForCodexLaunchReady(port, options);
  if (readiness.ready) {
    await activateCodex(executable);
    return;
  }

  throw new Error(formatCodexReadinessError(port, readiness));
}

async function activateCodex(providedExecutable = null) {
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
    env,
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

export { stopCodex, requestWindowsCodexQuit, launchCodex, codexLaunchEnvironment, restartCodex, activateCodex };
