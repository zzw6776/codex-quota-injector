import { readFile } from "node:fs/promises";
import { RELAY_STATE_VERSION } from "../relay-contract.mjs";
import { isCodexDebugPortReady } from "../cdp-client.mjs";
import { RELAY_PROCESS_START_TIME_TOLERANCE_MS, execFileAsync, runPowerShell, firstNonEmptyLine, delay } from "./contract.mjs";

async function isCodexLaunchReady(port, options = {}) {
  return (await readCodexLaunchReadiness(port, options)).ready;
}

async function getCodexLaunchReadiness(port, options = {}) {
  return readCodexLaunchReadiness(port, options);
}

async function isRelayConfigCurrent(path, generation) {
  try {
    const data = JSON.parse(await readFile(path, "utf8"));
    if (generation != null && data?.generation !== generation) return false;
    return true;
  } catch {
    return false;
  }
}

async function isRelayStateCurrent(path, generation, options = {}) {
  return (await readRelayStateReadiness(path, generation, options)).ready;
}

async function readRelayStateReadiness(path, generation, { wslNative = false, execFileImpl = execFileAsync } = {}) {
  let state;
  try {
    state = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    return { ready: false, reason: `状态文件不可读：${error.code ?? error.message}` };
  }
  if (generation != null && state?.generation !== generation) {
    return { ready: false, reason: "generation 不匹配" };
  }
  if (!Number.isInteger(state?.pid) || state.pid <= 0) {
    return { ready: false, reason: "PID 无效" };
  }
  if (wslNative) return readWslProcessReadiness(state, execFileImpl);
  if (!Number.isFinite(Number(state?.processStartedAt))) {
    return { ready: false, reason: "进程启动时间无效" };
  }
  try {
    process.kill(state.pid, 0);
    const processStartedAt = await readProcessStartedAt(state.pid);
    if (!Number.isFinite(processStartedAt)) {
      return { ready: false, reason: "无法读取进程启动时间" };
    }
    const ready = Math.abs(processStartedAt - Number(state.processStartedAt)) <=
      RELAY_PROCESS_START_TIME_TOLERANCE_MS;
    return { ready, reason: ready ? null : "进程启动时间不匹配" };
  } catch (error) {
    return { ready: false, reason: `进程不存在或不可访问：${error.code ?? error.message}` };
  }
}

async function readWslProcessReadiness(state, execFileImpl) {
  const processId = Number(state.pid);
  const script = [
    "set -eu",
    `process_id=${processId}`,
    'test -r "/proc/$process_id/stat"',
    'boot_id=$(cat /proc/sys/kernel/random/boot_id)',
    'stat_line=$(cat "/proc/$process_id/stat")',
    'stat_fields=${stat_line##*) }',
    'set -- $stat_fields',
    'shift 19',
    'start_ticks=$1',
    'printf "%s %s\\n" "$boot_id" "$start_ticks"',
  ].join("; ");
  let stdout;
  try {
    ({ stdout } = await execFileImpl("wsl.exe", ["-e", "sh", "-c", script], { windowsHide: true }));
  } catch (error) {
    return { ready: false, reason: `WSL 进程查询失败：${error.code ?? error.message}` };
  }
  const [bootId, startTicksText] = String(stdout).trim().split(/\s+/);
  const processStartTicks = Number(startTicksText);
  if (!bootId || !Number.isSafeInteger(processStartTicks) || processStartTicks < 0) {
    return { ready: false, reason: "WSL 进程身份输出无效" };
  }
  if (Number(state.version) >= RELAY_STATE_VERSION) {
    if (!state.bootId || !Number.isSafeInteger(Number(state.processStartTicks))) {
      return { ready: false, reason: "WSL 稳定进程身份缺失" };
    }
    if (state.bootId !== bootId) {
      return { ready: false, reason: "WSL boot_id 不匹配" };
    }
    if (Number(state.processStartTicks) !== processStartTicks) {
      return { ready: false, reason: "WSL 进程启动 ticks 不匹配" };
    }
    return { ready: true, reason: null };
  }
  if (!Number.isFinite(Number(state.processStartedAt))) {
    return { ready: false, reason: "旧版 WSL 进程启动时间无效" };
  }
  const legacyScript = [
    "set -eu",
    "boot_seconds=$(awk '/btime/ { print $2; exit }' /proc/stat)",
    "clock_ticks=$(getconf CLK_TCK)",
    'printf "%s %s\\n" "$boot_seconds" "$clock_ticks"',
  ].join("; ");
  let legacyStdout;
  try {
    ({ stdout: legacyStdout } = await execFileImpl(
      "wsl.exe",
      ["-e", "sh", "-c", legacyScript],
      { windowsHide: true },
    ));
  } catch (error) {
    return { ready: false, reason: `旧版 WSL 时间查询失败：${error.code ?? error.message}` };
  }
  const [bootSeconds, clockTicks] = String(legacyStdout).trim().split(/\s+/).map(Number);
  if (![bootSeconds, clockTicks].every(Number.isFinite) || clockTicks <= 0) {
    return { ready: false, reason: "旧版 WSL 时间输出无效" };
  }
  const processStartedAt = (bootSeconds + processStartTicks / clockTicks) * 1000;
  const ready = Math.abs(processStartedAt - Number(state.processStartedAt)) <=
    RELAY_PROCESS_START_TIME_TOLERANCE_MS;
  return { ready, reason: ready ? null : "旧版 WSL 进程启动时间不匹配" };
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
      ["-p", String(processId), "-o", "etime="],
    ).catch(() => ({ stdout: "" }));
    // macOS ps exposes elapsed time as [[days-]hours:]minutes:seconds.
    const elapsed = firstNonEmptyLine(stdout)?.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
    if (!elapsed) return null;
    const elapsedSeconds = Number(elapsed[1] ?? 0) * 86_400 +
      Number(elapsed[2] ?? 0) * 3_600 + Number(elapsed[3]) * 60 + Number(elapsed[4]);
    return Date.now() - elapsedSeconds * 1000;
  }
  return null;
}

async function waitForCodexLaunchReady(port, options, { timeoutMs = 20_000 } = {}) {
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
  const relayRequired = Boolean(relay && !relay.expectAbsent);
  const relayExpectedAbsent = Boolean(relay?.expectAbsent);
  let relayConfigReady = true;
  let relayStateReady = true;
  let relayStateReason = null;
  let relayReady = true;
  if (relayRequired) {
    relayConfigReady = !relay.configPath ||
      await isRelayConfigCurrent(relay.configPath, relay.generation);
    const relayStateReadiness = !relay.statePath
      ? { ready: true, reason: null }
      : await readRelayStateReadiness(relay.statePath, relay.generation, {
        wslNative: relay.wslNative === true,
      });
    relayStateReady = relayStateReadiness.ready;
    relayStateReason = relayStateReadiness.reason;
    relayReady = relayConfigReady && relayStateReady;
  } else if (relayExpectedAbsent && relay.statePath) {
    const relayStateReadiness = await readRelayStateReadiness(
      relay.statePath,
      null,
      { wslNative: relay.wslNative === true },
    );
    relayStateReady = !relayStateReadiness.ready;
    relayStateReason = relayStateReadiness.ready
      ? "仍检测到运行中的模型中继"
      : null;
    relayReady = relayStateReady;
  }
  return {
    ready: debugReady && relayReady,
    debugReady,
    relayReady,
    relayRequired,
    relayExpectedAbsent,
    relayConfigReady,
    relayStateReady,
    relayStateReason,
  };
}

function formatCodexReadinessError(port, readiness) {
  const debugStatus = readiness.debugReady ? "正常" : "不可用";
  if (readiness.relayExpectedAbsent && !readiness.relayReady) {
    return `Codex 启动后未就绪：调试端口 ${port}=${debugStatus}，模型中继仍在运行`;
  }
  if (!readiness.relayRequired) {
    return `Codex 启动后未就绪：调试端口 ${port}=${debugStatus}，模型中继=不要求`;
  }
  const relayConfigStatus = readiness.relayConfigReady ? "正常" : "未就绪";
  const relayStateStatus = readiness.relayStateReady
    ? "正常"
    : `未就绪（${readiness.relayStateReason ?? "未知原因"}）`;
  return `Codex 启动后未就绪：调试端口 ${port}=${debugStatus}，` +
    `模型中继配置=${relayConfigStatus}，模型中继进程=${relayStateStatus}`;
}

export { waitForCodexLaunchReady, formatCodexReadinessError, isCodexLaunchReady, getCodexLaunchReadiness, isRelayConfigCurrent, isRelayStateCurrent };
