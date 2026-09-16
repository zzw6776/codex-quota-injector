import { execFileAsync, MACOS_HELPER_TERM_TIMEOUT_MS, MACOS_HELPER_FORCE_TIMEOUT_MS, isProcessAlive, waitForProcessIdsExit, delay, MACOS_CODEX_BUNDLE_ID } from "./contract.mjs";
import { resolveCodexExecutable } from "./executables.mjs";
import { listMacCodexLifecycleProcesses } from "./processes.mjs";

async function stopMacCodex({
  timeoutMs = 5_000,
  executable: providedExecutable,
  execFileImpl = execFileAsync,
  listProcessesImpl,
  requestQuitImpl = requestMacCodexQuit,
  signalProcessImpl = (processId, signal) => process.kill(processId, signal),
  isProcessAliveImpl = isProcessAlive,
  delayImpl = delay,
  nowImpl = Date.now,
} = {}) {
  const executable = providedExecutable ?? await resolveCodexExecutable().catch(() => null);
  if (!executable) return;
  const readProcesses = () => listProcessesImpl
    ? listProcessesImpl({ executable })
    : listMacCodexLifecycleProcesses({ executable, execFileImpl });
  const snapshot = await readProcesses();
  if (snapshot.length === 0) return;

  const mainProcesses = snapshot.filter((entry) => entry.role === "desktop");
  let termRequested = false;
  if (mainProcesses.length > 0) {
    try {
      await requestQuitImpl({ execFileImpl });
    } catch (error) {
      console.warn(`[platform] Codex 正常退出请求失败，回退到进程信号：${error.message}`);
      const remaining = await matchingMacProcessSnapshot(snapshot, readProcesses);
      signalMacProcessSnapshot(remaining, "SIGTERM", signalProcessImpl);
      termRequested = true;
    }
  } else {
    const remaining = await matchingMacProcessSnapshot(snapshot, readProcesses);
    signalMacProcessSnapshot(remaining, "SIGTERM", signalProcessImpl);
    termRequested = true;
  }

  await waitForProcessIdsExit(
    snapshot.map((entry) => entry.pid),
    termRequested ? Math.min(timeoutMs, MACOS_HELPER_TERM_TIMEOUT_MS) : timeoutMs,
    { isProcessAliveImpl, delayImpl, nowImpl },
  );
  let remaining = await matchingMacProcessSnapshot(snapshot, readProcesses);
  if (remaining.length === 0) {
    await delayImpl(200);
    return;
  }

  if (!termRequested) {
    signalMacProcessSnapshot(remaining, "SIGTERM", signalProcessImpl);
    await waitForProcessIdsExit(
      remaining.map((entry) => entry.pid),
      MACOS_HELPER_TERM_TIMEOUT_MS,
      { isProcessAliveImpl, delayImpl, nowImpl },
    );
    remaining = await matchingMacProcessSnapshot(remaining, readProcesses);
    if (remaining.length === 0) {
      await delayImpl(200);
      return;
    }
  }

  signalMacProcessSnapshot(remaining, "SIGKILL", signalProcessImpl);
  await waitForProcessIdsExit(
    remaining.map((entry) => entry.pid),
    MACOS_HELPER_FORCE_TIMEOUT_MS,
    { isProcessAliveImpl, delayImpl, nowImpl },
  );
  const stubborn = await matchingMacProcessSnapshot(remaining, readProcesses);
  if (stubborn.length > 0) {
    throw new Error(`Codex 进程未能在超时内退出：${stubborn.map((entry) => entry.pid).join(", ")}`);
  }
  await delayImpl(200);
}

async function requestMacCodexQuit({ execFileImpl = execFileAsync } = {}) {
  await execFileImpl("/usr/bin/osascript", [
    "-e",
    `tell application id "${MACOS_CODEX_BUNDLE_ID}" to quit`,
  ], { timeout: 5_000 });
}

async function matchingMacProcessSnapshot(snapshot, readProcesses) {
  const currentByPid = new Map((await readProcesses()).map((entry) => [entry.pid, entry]));
  return snapshot.filter((entry) =>
    currentByPid.get(entry.pid)?.executablePath === entry.executablePath
  );
}

function signalMacProcessSnapshot(processes, signal, signalProcessImpl) {
  for (const entry of processes) {
    try {
      signalProcessImpl(entry.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}

export { stopMacCodex, requestMacCodexQuit };
