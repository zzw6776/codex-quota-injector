import { activateLifecycleTaskTools, bindLifecycleTask } from "../lifecycle-task-tools.mjs";
import { inspectLifecycleHost } from "../../src/lifecycle-host.mjs";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { WAIT_INTERVAL_MS, delay } from "./io.mjs";
import { runtimeModeMatches, hostRuntimeTarget, samePids, assertSamePids } from "./evidence.mjs";

async function waitForWindowsTargetHost(control, {
  timeoutMs = 90_000,
  expectedRuntimeTarget = null,
  previousRelayPid = null,
  previousCodexPids = null,
  previousInjectorPids = null,
  ownerCheck = null,
  ownerFailure = "target-owner",
  inspectHost = inspectLifecycleHost,
  pollIntervalMs = WAIT_INTERVAL_MS,
  activateTaskTools = activateLifecycleTaskTools,
} = {}) {
  const taskThreadId = control.sessionCheckpoint ? bindLifecycleTask(control).threadId : null;
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  let taskToolsActivation = null;
  const activatedPids = new Set();
  let ownerMatches = ownerCheck === null;
  while (Date.now() < deadline) {
    latest = await inspectHost({
      installedApp: control.installedApp,
      expectedProtocol: control.expectedProtocol,
      threadId: taskThreadId,
    });
    const relayChanged = previousRelayPid == null || latest.relay.pid !== previousRelayPid;
    const codexChanged = previousCodexPids == null || !samePids(latest.codexPids, previousCodexPids);
    const injectorChanged = previousInjectorPids == null ||
      !samePids(latest.injectorPids, previousInjectorPids);
    const runtimeMatches = expectedRuntimeTarget == null ||
      runtimeModeMatches(latest, expectedRuntimeTarget);
    ownerMatches = ownerCheck === null || await ownerCheck(latest);
    const health = latest.hostHealth ?? latest.readiness.hostHealth;
    const taskToolsReady = latest.readiness.hostToolsReady &&
      (health?.required !== true || taskThreadId == null || health.threadId === taskThreadId);
    if (latest.readiness.coreReady && !taskToolsReady &&
      runtimeMatches && relayChanged && codexChanged && injectorChanged && ownerMatches &&
      !activatedPids.has(latest.codexPids[0])) {
      taskToolsActivation = await activateTaskTools(control, latest);
      activatedPids.add(latest.codexPids[0]);
    }
    if (latest.readiness.ready && taskToolsReady && runtimeMatches && relayChanged && codexChanged &&
      injectorChanged && ownerMatches) {
      if (taskToolsActivation?.codexPid === latest.codexPids[0]) {
        latest.taskToolsActivation = { ...taskToolsActivation, verifiedAt: new Date().toISOString() };
      }
      return latest;
    }
    await delay(pollIntervalMs);
  }
  const reasons = latest ? Object.entries(latest.readiness)
    .filter(([name, value]) => name !== "expectedProtocol" && value === false)
    .map(([name]) => name) : ["host-unreadable"];
  if (latest && previousRelayPid != null && latest.relay.pid === previousRelayPid) {
    reasons.push("relay-pid-unchanged");
  }
  if (latest && previousCodexPids != null && samePids(latest.codexPids, previousCodexPids)) {
    reasons.push("codex-pids-unchanged");
  }
  if (latest && previousInjectorPids != null &&
    samePids(latest.injectorPids, previousInjectorPids)) {
    reasons.push("injector-pids-unchanged");
  }
  const finalHealth = latest?.hostHealth ?? latest?.readiness?.hostHealth;
  if (taskThreadId && finalHealth?.required === true && finalHealth.threadId !== taskThreadId) {
    reasons.push("initiating-task-tools-not-verified");
  }
  if (!ownerMatches) reasons.push(ownerFailure);
  if (latest && expectedRuntimeTarget != null && !runtimeModeMatches(latest, expectedRuntimeTarget)) {
    reasons.push(`runtime-${hostRuntimeTarget(latest)}-expected-${expectedRuntimeTarget}`);
  }
  throw new Error(`等待 Windows Codex 生命周期就绪超时：${reasons.join(", ")}`);
}

async function launchWindowsApp(installDir) {
  const executable = join(installDir, "Codex Quota Injector.exe");
  await access(executable);
  const child = spawn(executable, [], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  await new Promise((resolveSpawn, reject) => {
    child.once("spawn", resolveSpawn);
    child.once("error", reject);
  });
  child.unref();
}

async function assertStableWindowsHost(control, baseline, durationMs, runtimeTarget = null, {
  inspectHost = inspectLifecycleHost,
  pollIntervalMs = WAIT_INTERVAL_MS,
} = {}) {
  const deadline = Date.now() + durationMs;
  let latest = baseline;
  while (Date.now() < deadline) {
    latest = await inspectHost({
      installedApp: control.installedApp,
      expectedProtocol: control.expectedProtocol,
      threadId: control.sessionCheckpoint ? bindLifecycleTask(control).threadId : null,
    });
    if (!latest.readiness.ready || runtimeTarget && !runtimeModeMatches(latest, runtimeTarget)) {
      throw new Error("重复启动后的 Codex 不再处于目标运行环境");
    }
    assertSamePids(baseline.injectorPids, latest.injectorPids, "重复启动产生了新的注入器");
    assertSamePids(baseline.codexPids, latest.codexPids, "重复启动意外重启了 Codex");
    if (baseline.relay.pid !== latest.relay.pid) throw new Error("重复启动意外替换了中继进程");
    await delay(pollIntervalMs);
  }
  return latest;
}

async function waitForSettledWindowsHost(control, initialHost, {
  expectedRuntimeTarget = null,
  ownerCheck = null,
  stableDurationMs = 8_000,
  timeoutMs = 45_000,
  inspectHost = inspectLifecycleHost,
  pollIntervalMs = WAIT_INTERVAL_MS,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let baseline = initialHost;
  let stableSince = Date.now();
  let latest = initialHost;
  while (Date.now() < deadline) {
    latest = await inspectHost({
      installedApp: control.installedApp,
      expectedProtocol: control.expectedProtocol,
      threadId: control.sessionCheckpoint ? bindLifecycleTask(control).threadId : null,
    });
    const ready = latest.readiness.ready &&
      (expectedRuntimeTarget == null || runtimeModeMatches(latest, expectedRuntimeTarget)) &&
      (ownerCheck == null || await ownerCheck(latest));
    const sameProcessSet = ready &&
      samePids(baseline.injectorPids, latest.injectorPids) &&
      samePids(baseline.codexPids, latest.codexPids) &&
      baseline.relay.pid === latest.relay.pid;
    if (!sameProcessSet) {
      baseline = latest;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= stableDurationMs) {
      return latest;
    }
    await delay(pollIntervalMs);
  }
  throw new Error("Windows Codex 首次启动后未在限定时间内达到稳定状态");
}

export { waitForWindowsTargetHost, launchWindowsApp, assertStableWindowsHost, waitForSettledWindowsHost };
