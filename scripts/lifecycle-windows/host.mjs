import { inspectLifecycleHost } from "../../src/lifecycle-host.mjs";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { WAIT_INTERVAL_MS, delay } from "./io.mjs";
import { selectWindowsRecoveryEntry } from "./recovery-policy.mjs";
import { windowsInjectorOwnedByInstalledApp, windowsInjectorOwnedBySource } from "./process-ownership.mjs";
import { publicHostEvidence, runtimeModeMatches, hostRuntimeTarget, samePids, assertSamePids } from "./evidence.mjs";

async function restartWindowsInitialEntry(control) {
  const runtimeTarget = control.runtimeConfiguration?.originalRuntime ?? control.sourceRecoveryMode;
  const current = await inspectLifecycleHost({
    installedApp: control.installedApp,
    expectedProtocol: control.initialHost?.relay?.protocol ?? control.expectedProtocol,
  });
  if (current.readiness.ready && runtimeModeMatches(current, runtimeTarget)) {
    return publicHostEvidence(current, { recoveryEntry: "already-running" });
  }
  const recoveryEntry = selectWindowsRecoveryEntry(control.initialHost);
  let ownerCheck;
  let ownerFailure;
  if (recoveryEntry === "current-source") {
    await launchWindowsSourceEntry(control.root, control.sourceRecoveryRelay);
    ownerCheck = (snapshot) => windowsInjectorOwnedBySource(snapshot.injectorPids, control.root);
    ownerFailure = "rollback-source-owner";
  } else {
    await launchWindowsApp(control.installedApp);
    ownerCheck = (snapshot) => windowsInjectorOwnedByInstalledApp(
      snapshot.injectorPids,
      control.installedApp,
    );
    ownerFailure = "rollback-installed-owner";
  }
  const host = await waitForWindowsTargetHost({
    ...control,
    expectedProtocol: control.initialHost?.relay?.protocol ?? control.expectedProtocol,
  }, { expectedRuntimeTarget: runtimeTarget, ownerCheck, ownerFailure });
  return publicHostEvidence(host, { recoveryEntry });
}

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
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  let ownerMatches = ownerCheck === null;
  while (Date.now() < deadline) {
    latest = await inspectHost({
      installedApp: control.installedApp,
      expectedProtocol: control.expectedProtocol,
    });
    const relayChanged = previousRelayPid == null || latest.relay.pid !== previousRelayPid;
    const codexChanged = previousCodexPids == null || !samePids(latest.codexPids, previousCodexPids);
    const injectorChanged = previousInjectorPids == null ||
      !samePids(latest.injectorPids, previousInjectorPids);
    const runtimeMatches = expectedRuntimeTarget == null ||
      runtimeModeMatches(latest, expectedRuntimeTarget);
    ownerMatches = ownerCheck === null || await ownerCheck(latest);
    if (latest.readiness.ready && runtimeMatches && relayChanged && codexChanged &&
      injectorChanged && ownerMatches) {
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

async function launchWindowsSourceEntry(root, relayExecutable) {
  await access(relayExecutable);
  const child = spawn(process.execPath, [join(root, "src", "launcher.mjs"), "--explicit-start"], {
    cwd: root,
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    env: {
      ...process.env,
      CODEX_QUOTA_EXPLICIT_START: "1",
      CODEX_QUOTA_RELAY_EXECUTABLE: relayExecutable,
    },
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

export { restartWindowsInitialEntry, waitForWindowsTargetHost, launchWindowsApp, launchWindowsSourceEntry, assertStableWindowsHost, waitForSettledWindowsHost };
