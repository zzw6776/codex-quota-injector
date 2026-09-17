import { activateLifecycleTaskTools, bindLifecycleTask } from "./lifecycle-task-tools.mjs";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { AccountManager } from "../src/account-manager.mjs";
import {
  DEFAULT_INSTALLED_APP,
  findInjectorListenerPids,
  inspectLifecycleHost,
  isProcessAlive,
  lifecycleFingerprint,
  publicLifecycleHost,
  readJson,
  readMacAppVersion,
} from "../src/lifecycle-host.mjs";
import { stopCodex } from "../src/platform.mjs";
import { sendWakeupRequest } from "../src/wakeup-client.mjs";
import { readSingleInstanceStatus } from "../src/single-instance.mjs";
import { readLatestUnfinishedLifecycle } from "../src/lifecycle-runner.mjs";
import { createMacLifecycleSessionGuard, protectMacLifecycleOperations } from "./lifecycle-macos-session.mjs";

const execFileAsync = promisify(execFile);
const WAIT_INTERVAL_MS = 500;
const PACKAGE_NODE_VERSION = "22.23.1";

export async function createMacLifecyclePlan({
  root,
  projectVersion,
  expectedProtocol,
  installedApp = DEFAULT_INSTALLED_APP,
  taskToolsOnly = false,
  inspectHost = inspectLifecycleHost,
} = {}) {
  const host = await inspectHost({ installedApp, expectedProtocol });
  const unfinishedLifecycle = await readLatestUnfinishedLifecycle(
    join(root, ".runtime", "test-results", "lifecycle", "latest.json"),
  );
  return {
    batch: "lifecycle-official",
    name: "启停恢复测试 - Codex 官方模型",
    mode: "macos-external-supervisor",
    platform: process.platform,
    arch: process.arch,
    projectVersion,
    expectedRelayProtocol: expectedProtocol,
    scope: taskToolsOnly ? "task-tools-startup" : "full",
    steps: [
      "verify-package", "wait-desktop-idle", "install-update", "launch-updated",
      "repeat-launch", "relay-reconnect", "close-reopen",
      ...(taskToolsOnly ? [] : ["switch-account", "restore-account"]),
      "final-state",
    ],
    tokenRequests: taskToolsOnly ? 0 : host.accounts.roundTripAvailable ? 1 : 0,
    actions: [
      "构建、验签并安装当前架构正式包",
      "绑定发起任务与回合，等待活动回合结束并核对历史持久化",
      "正式入口接管现有注入器并等待 Codex 重新启动",
      "核对中继 generation 已加载目标协议，自动打开发起任务并核验其必需工具",
      "重复启动仍保持一个注入器和同一 Codex",
      "终止中继进程并核对自动或入口触发恢复",
      "关闭 Codex 后由正式入口重新启动",
      ...(taskToolsOnly ? ["核对最终安装、原账号与进程状态；不执行账号往返或模型冒烟"]
        : ["真实账号切换、一次最低价官方模型冒烟、回切原账号"]),
    ],
    host: publicLifecycleHost(host),
    accountRoundTrip: taskToolsOnly ? "not-run"
      : host.accounts.roundTripAvailable ? "ready" : "blocked-less-than-two-oauth-accounts",
    unfinishedLifecycle,
    controller: "launchd one-shot job; no UI clicks",
    reportDirectory: join(root, ".runtime", "test-results", "lifecycle"),
  };
}

export async function buildMacLifecycleCandidate({
  root,
  runDirectory,
  projectVersion,
  architecture = process.arch,
} = {}) {
  if (process.platform !== "darwin") throw new Error("生命周期正式包当前只适配 macOS");
  if (!new Set(["arm64", "x64"]).has(architecture)) {
    throw new Error(`不支持的 macOS 架构 ${architecture}`);
  }
  const buildDirectory = join(runDirectory, "build");
  const packageDirectory = join(runDirectory, "package");
  const worker = join(buildDirectory, "Codex Quota Injector Worker");
  const runtime = await ensureOfficialNodeRuntime({ root, architecture });
  await mkdir(buildDirectory, { recursive: true, mode: 0o700 });
  await runCommand(process.execPath, [
    join(root, "scripts", "build-sea.mjs"),
    "--node-binary", runtime.executable,
    "--output", worker,
  ], { cwd: root });
  await runCommand(process.execPath, [
    join(root, "scripts", "package-macos.mjs"),
    "--architecture", architecture,
    "--input-executable", worker,
    "--node-license", runtime.license,
    "--output-dir", packageDirectory,
  ], { cwd: root });
  const appPath = join(packageDirectory, "Codex Quota Injector.app");
  const verified = await verifyMacAppBundle(appPath, { projectVersion, architecture });
  return {
    appPath,
    dmgPath: join(packageDirectory,
      `Codex-Quota-Injector-${projectVersion}-macos-${architecture}.dmg`),
    ...verified,
  };
}

export async function ensureOfficialNodeRuntime({
  root,
  architecture = process.arch,
  version = PACKAGE_NODE_VERSION,
} = {}) {
  const archiveArchitecture = architecture === "x64" ? "x64" : "arm64";
  const runtimeRoot = join(root, ".runtime", "node-runtimes");
  const directoryName = `node-v${version}-darwin-${archiveArchitecture}`;
  const directory = join(runtimeRoot, directoryName);
  const executable = join(directory, "bin", "node");
  const license = join(directory, "LICENSE");
  if (await pathExists(executable) && await pathExists(license)) {
    await assertBinaryArchitecture(executable, architecture);
    return { version, executable, license, downloaded: false };
  }
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  const archiveName = `${directoryName}.tar.gz`;
  const archivePath = join(runtimeRoot, archiveName);
  const checksumsPath = join(runtimeRoot, `SHASUMS256-v${version}.txt`);
  const baseUrl = `https://nodejs.org/dist/v${version}`;
  await runCommand("/usr/bin/curl", [
    "-fL", "--retry", "3", "--output", checksumsPath, `${baseUrl}/SHASUMS256.txt`,
  ]);
  await runCommand("/usr/bin/curl", [
    "-fL", "--retry", "3", "--output", archivePath, `${baseUrl}/${archiveName}`,
  ]);
  const expected = checksumForArchive(await readFile(checksumsPath, "utf8"), archiveName);
  const actual = await fileHash(archivePath);
  if (actual !== expected) {
    throw new Error(`Node.js 运行时校验失败：${archiveName}`);
  }
  await runCommand("/usr/bin/tar", ["-xzf", archivePath, "-C", runtimeRoot]);
  await access(executable);
  await access(license);
  await assertBinaryArchitecture(executable, architecture);
  return { version, executable, license, downloaded: true };
}

export function checksumForArchive(manifest, archiveName) {
  const line = String(manifest).split(/\r?\n/).find((entry) =>
    entry.trim().endsWith(`  ${archiveName}`) || entry.trim().endsWith(` ${archiveName}`)
  );
  const checksum = line?.trim().split(/\s+/)[0]?.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(checksum ?? "")) {
    throw new Error(`Node.js 校验清单中缺少 ${archiveName}`);
  }
  return checksum;
}

export async function verifyMacAppBundle(appPath, {
  projectVersion,
  architecture = process.arch,
} = {}) {
  const executable = join(appPath, "Contents", "MacOS", "Codex Quota Injector");
  const worker = join(appPath, "Contents", "Resources", "Codex Quota Injector Worker");
  const shim = join(appPath, "Contents", "Resources", "Codex Quota Injector Shim");
  for (const path of [executable, worker, shim]) await access(path);
  const version = await readMacAppVersion(appPath);
  if (version !== projectVersion) {
    throw new Error(`正式包版本不匹配：期望 ${projectVersion}，实际 ${version ?? "未知"}`);
  }
  await runCommand("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
  const architectureNames = [];
  for (const path of [executable, worker, shim]) {
    const { stdout } = await execFileAsync("/usr/bin/lipo", ["-archs", path], { encoding: "utf8" });
    const names = String(stdout).trim().split(/\s+/).filter(Boolean);
    architectureNames.push(names);
    const expected = architecture === "x64" ? "x86_64" : "arm64";
    if (names.length !== 1 || names[0] !== expected) {
      throw new Error(`正式包架构不匹配：${path} 为 ${names.join("/") || "未知"}`);
    }
  }
  return {
    version,
    architecture,
    architectureNames,
    executableSha256: await fileHash(executable),
    workerSha256: await fileHash(worker),
    shimSha256: await fileHash(shim),
  };
}

export function createMacLifecycleOperations(controlPath, initialControl, {
  sessionGuard = createMacLifecycleSessionGuard(initialControl),
} = {}) {
  let control = structuredClone(initialControl);
  const updateControl = async (runtimePatch) => {
    control.runtime = { ...(control.runtime ?? {}), ...runtimePatch };
    await writePrivateJson(controlPath, control);
  };
  const currentHost = async () => {
    const host = await inspectLifecycleHost({
      installedApp: control.installedApp,
      expectedProtocol: control.expectedProtocol,
      threadId: control.sessionCheckpoint ? bindLifecycleTask(control).threadId : null,
    });
    host.launcher = await readSingleInstanceStatus().catch(() => null);
    host.readiness.launcherReady = launcherMatchesHost(host, control.projectVersion);
    host.readiness.ready &&= host.readiness.launcherReady;
    return host;
  };
  const verifyReady = async (options = {}) => {
    const host = await waitForTargetHost(control, { readLauncherStatus: readSingleInstanceStatus, ...options });
    await sessionGuard.after();
    return host;
  };
  const launchInstalledApp = async () => {
    await sessionGuard.before();
    await launchApp(control.installedApp);
  };
  const stopDesktop = async () => {
    await sessionGuard.before();
    await stopCodex();
  };
  const restartThroughInstalledEntry = async () => {
    await launchInstalledApp();
    return verifyReady();
  };
  const restoreOriginalAccount = async () => {
    if (!control.accounts?.available) return { skipped: true };
    // Stop the injector's credential watcher before another AccountStore
    // instance writes the shared index and encrypted account files.
    await sessionGuard.before();
    await stopInjectorOwners();
    const manager = new AccountManager();
    try {
      const view = await manager.initialize();
      assertExpectedAccount(view.currentAccountId, control.accounts, "恢复原账号");
      if (view.currentAccountId !== control.accounts.originalId) {
        await manager.switchAccount(control.accounts.originalId);
      }
    } catch (error) {
      throw redactAccountError(error, manager.getViewModel());
    } finally {
      manager.close();
    }
    await stopDesktop();
    const host = await restartThroughInstalledEntry();
    return {
      account: lifecycleFingerprint(control.accounts.originalId),
      codexPids: host.codexPids,
      relayPid: host.relay.pid,
    };
  };

  const operations = {
    "verify-package": {
      replaySafe: true,
      run: async () => verifyMacAppBundle(control.candidateApp, {
        projectVersion: control.projectVersion,
        architecture: control.arch,
      }),
      reconcile: async () => ({
        completed: true,
        evidence: await verifyMacAppBundle(control.candidateApp, {
          projectVersion: control.projectVersion,
          architecture: control.arch,
        }),
      }),
    },
    "wait-desktop-idle": {
      replaySafe: true,
      run: async () => ({ status: "idle" }),
      reconcile: async () => ({ completed: true, evidence: { status: "idle" } }),
    },
    "install-update": {
      replaySafe: true,
      run: async () => {
        await stopInjectorOwners();
        await stopDesktop();
        const evidence = await installAppBundle(control);
        await updateControl({ installed: true });
        return evidence;
      },
      reconcile: async () => {
        const installed = await installedCandidateEvidence(control);
        return installed
          ? { completed: true, evidence: installed }
          : { completed: false, safeToRetry: true };
      },
    },
    "launch-updated": {
      replaySafe: true,
      run: async () => {
        const before = await currentHost();
        const alreadyInstalledOwner = await injectorOwnedByInstalledApp(
          before.injectorPids,
          control.installedApp,
        );
        await launchInstalledApp();
        const requireCodexChange = control.initialHost?.relay?.protocol !== control.expectedProtocol;
        const host = await verifyReady({
          previousCodexPids: requireCodexChange ? control.initialHost.codexPids : null,
          previousInjectorPids: alreadyInstalledOwner ? null : before.injectorPids,
          ownerCheck: (snapshot) => injectorOwnedByInstalledApp(
            snapshot.injectorPids,
            control.installedApp,
          ),
          ownerFailure: "installed-package-owner",
        });
        return publicHostEvidence(host, {
          previousCodexPids: control.initialHost.codexPids,
          packagedOwner: true,
          alreadyInstalledOwner,
          takeoverObserved: !alreadyInstalledOwner,
        });
      },
      reconcile: async () => {
        const host = await currentHost();
        const packagedOwner = host.readiness.ready &&
          await injectorOwnedByInstalledApp(host.injectorPids, control.installedApp);
        return packagedOwner
          ? { completed: true, evidence: publicHostEvidence(host, { packagedOwner }) }
          : { completed: false, safeToRetry: true };
      },
    },
    "repeat-launch": {
      run: async () => {
        const before = await verifyReady();
        await updateControl({
          repeatBaseline: {
            injectorPids: before.injectorPids,
            codexPids: before.codexPids,
            relayPid: before.relay.pid,
          },
        });
        await launchInstalledApp();
        const settled = await verifyReady({ afterLauncherRevision: before.launcher.revision, stableBaseline: before });
        const after = await assertStableHost(control, settled, 8_000);
        return publicHostEvidence(after, { retainedInjectorPid: after.injectorPids[0] });
      },
      reconcile: async () => {
        const baseline = control.runtime?.repeatBaseline;
        if (!baseline) return { completed: false, safeToRetry: true };
        const host = await currentHost();
        const completed = host.readiness.ready &&
          samePids(baseline.injectorPids, host.injectorPids) &&
          samePids(baseline.codexPids, host.codexPids) &&
          baseline.relayPid === host.relay.pid;
        return completed
          ? { completed: true, evidence: publicHostEvidence(host, { recoveredAfterControllerInterruption: true }) }
          : { completed: false, safeToRetry: false };
      },
    },
    "relay-reconnect": {
      replaySafe: true,
      run: async () => {
        const before = await verifyReady();
        await updateControl({ reconnectBaselineRelayPid: before.relay.pid });
        await sessionGuard.before();
        try {
          process.kill(before.relay.pid, "SIGTERM");
        } catch (error) {
          if (error?.code !== "ESRCH") throw error;
        }
        let host;
        let recovery = "automatic";
        try {
          host = await verifyReady({ previousRelayPid: before.relay.pid, timeoutMs: 15_000 });
        } catch {
          recovery = "injector-entry";
          await launchInstalledApp();
          host = await verifyReady({ previousRelayPid: before.relay.pid });
        }
        return publicHostEvidence(host, {
          previousRelayPid: before.relay.pid,
          recovery,
        });
      },
      reconcile: async () => {
        const previousRelayPid = control.runtime?.reconnectBaselineRelayPid;
        if (!previousRelayPid) return { completed: false, safeToRetry: true };
        const host = await currentHost();
        return host.readiness.ready && host.relay.pid !== previousRelayPid
          ? { completed: true, evidence: publicHostEvidence(host, { previousRelayPid }) }
          : { completed: false, safeToRetry: true };
      },
    },
    "close-reopen": {
      replaySafe: true,
      run: async () => {
        const before = await verifyReady();
        await updateControl({ closeBaselineCodexPids: before.codexPids });
        await stopDesktop();
        const stopped = await currentHost();
        if (stopped.codexPids.length !== 0) throw new Error("Codex 关闭后仍有主进程存活");
        const host = await restartThroughInstalledEntry();
        if (samePids(before.codexPids, host.codexPids)) throw new Error("Codex 重开后 PID 没有变化");
        return publicHostEvidence(host, { previousCodexPids: before.codexPids });
      },
      reconcile: async () => {
        const previous = control.runtime?.closeBaselineCodexPids;
        if (!previous) return { completed: false, safeToRetry: true };
        const host = await currentHost();
        return host.readiness.ready && !samePids(previous, host.codexPids)
          ? { completed: true, evidence: publicHostEvidence(host, { previousCodexPids: previous }) }
          : { completed: false, safeToRetry: true };
      },
    },
    "switch-account": {
      run: async () => {
        if (!control.accounts?.available) throw new Error("没有两个可用于往返测试的 OAuth 账号");
        await sessionGuard.before();
        await stopInjectorOwners();
        const manager = new AccountManager();
        try {
          const view = await manager.initialize();
          assertExpectedAccount(view.currentAccountId, control.accounts, "切换测试账号");
          if (view.currentAccountId !== control.accounts.targetId) {
            await manager.switchAccount(control.accounts.targetId);
          }
          await updateControl({ accountWritten: "target" });
          await stopDesktop();
          const host = await restartThroughInstalledEntry();
          await updateControl({ targetAccountRestarted: true });
          const controller = new AbortController();
          const smoke = await manager.withWakeupAccount(
            control.accounts.targetId,
            (getCredentials) => sendWakeupRequest(getCredentials, controller.signal),
          );
          await updateControl({
            targetSmokePassed: true,
            targetSmokeModel: smoke.model,
          });
          return publicHostEvidence(host, {
            account: lifecycleFingerprint(control.accounts.targetId),
            modelSmoke: { status: "passed", model: smoke.model },
          });
        } catch (error) {
          throw redactAccountError(error, manager.getViewModel());
        } finally {
          manager.close();
        }
      },
      reconcile: async () => {
        if (!control.accounts?.available) return { completed: false, safeToRetry: false };
        control = await readJson(controlPath) ?? control;
        const manager = new AccountManager();
        try {
          const view = await manager.initialize();
          assertExpectedAccount(view.currentAccountId, control.accounts, "恢复账号切换步骤");
          if (view.currentAccountId === control.accounts.targetId) {
            const host = await currentHost();
            const completed = host.readiness.ready && control.runtime?.targetAccountRestarted === true &&
              control.runtime?.targetSmokePassed === true;
            return completed
              ? { completed: true, evidence: publicHostEvidence(host, {
                  account: lifecycleFingerprint(control.accounts.targetId),
                  modelSmoke: { status: "passed", model: control.runtime.targetSmokeModel },
                }) }
              : { completed: false, safeToRetry: false };
          }
          return { completed: false, safeToRetry: control.runtime?.accountWritten !== "target" };
        } finally {
          manager.close();
        }
      },
    },
    "restore-account": {
      replaySafe: true,
      run: async () => {
        const evidence = await restoreOriginalAccount();
        await updateControl({ accountWritten: "original", originalAccountRestarted: true });
        return evidence;
      },
      reconcile: async () => {
        if (!control.accounts?.available) return { completed: true, evidence: { skipped: true } };
        const manager = new AccountManager();
        try {
          const view = await manager.initialize();
          const host = await currentHost();
          const completed = view.currentAccountId === control.accounts.originalId && host.readiness.ready;
          return completed
            ? { completed: true, evidence: publicHostEvidence(host, {
                account: lifecycleFingerprint(control.accounts.originalId),
              }) }
            : { completed: false, safeToRetry: true };
        } finally {
          manager.close();
        }
      },
    },
    "final-state": {
      replaySafe: true,
      run: async () => {
        const host = await verifyReady();
        const installed = await installedCandidateEvidence(control);
        if (!installed) throw new Error("最终安装包不是本次构建产物");
        if (control.accounts?.available) {
          const manager = new AccountManager();
          try {
            const view = await manager.initialize();
            if (view.currentAccountId !== control.accounts.originalId) {
              throw new Error("最终账号没有恢复为测试前账号");
            }
          } finally {
            manager.close();
          }
        }
        await rm(control.stagingApp, { recursive: true, force: true });
        return publicHostEvidence(host, {
          installed,
          originalAccountRestored: control.accounts?.available ? true : null,
        });
      },
      reconcile: async () => {
        const host = await currentHost();
        const installed = await installedCandidateEvidence(control);
        let originalAccountRestored = true;
        if (control.accounts?.available) {
          const manager = new AccountManager();
          try {
            originalAccountRestored = (await manager.initialize()).currentAccountId ===
              control.accounts.originalId;
          } finally {
            manager.close();
          }
        }
        return host.readiness.ready && installed && originalAccountRestored
          ? { completed: true, evidence: publicHostEvidence(host, {
              installed,
              originalAccountRestored: control.accounts?.available ? true : null,
            }) }
          : { completed: false, safeToRetry: true };
      },
    },
  };
  return protectMacLifecycleOperations(operations, sessionGuard);
}

export async function installAppBundle(control, {
  verifyBundle = verifyMacAppBundle,
  copyBundle = (source, target) => runCommand("/usr/bin/ditto", [source, target]),
} = {}) {
  const candidate = await verifyBundle(control.candidateApp, {
    projectVersion: control.projectVersion,
    architecture: control.arch,
  });
  await rm(control.stagingApp, { recursive: true, force: true });
  await copyBundle(control.candidateApp, control.stagingApp);
  await verifyBundle(control.stagingApp, {
    projectVersion: control.projectVersion,
    architecture: control.arch,
  });
  await rm(control.installedApp, { recursive: true, force: true });
  await rename(control.stagingApp, control.installedApp);
  return {
    installedVersion: candidate.version,
    workerSha256: candidate.workerSha256,
  };
}

export async function waitForTargetHost(control, {
  timeoutMs = 90_000,
  previousRelayPid = null,
  previousCodexPids = null,
  previousInjectorPids = null,
  ownerCheck = null,
  ownerFailure = "target-owner",
  inspectHost = inspectLifecycleHost,
  pollIntervalMs = WAIT_INTERVAL_MS,
  activateTaskTools = activateLifecycleTaskTools,
  readLauncherStatus = null,
  afterLauncherRevision = null,
  stableBaseline = null,
} = {}) {
  const taskThreadId = control.sessionCheckpoint ? bindLifecycleTask(control).threadId : null;
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  let taskToolsActivation = null;
  const activatedPids = new Set();
  let ownerMatches = ownerCheck === null;
  let launcherReady = readLauncherStatus === null;
  while (Date.now() < deadline) {
    latest = await inspectHost({
      installedApp: control.installedApp,
      expectedProtocol: control.expectedProtocol,
      threadId: taskThreadId,
    });
    if (stableBaseline) assertHostIdentity(stableBaseline, latest);
    if (readLauncherStatus) {
      latest.launcher = await readLauncherStatus().catch(() => null);
      launcherReady = launcherMatchesHost(latest, control.projectVersion) &&
        (afterLauncherRevision == null || latest.launcher.revision > afterLauncherRevision);
    }
    const relayChanged = previousRelayPid == null || latest.relay.pid !== previousRelayPid;
    const codexChanged = previousCodexPids == null || !samePids(latest.codexPids, previousCodexPids);
    const injectorChanged = previousInjectorPids == null ||
      !samePids(latest.injectorPids, previousInjectorPids);
    ownerMatches = ownerCheck === null || await ownerCheck(latest);
    const health = latest.hostHealth ?? latest.readiness.hostHealth;
    const taskToolsReady = latest.readiness.hostToolsReady &&
      (health?.required !== true || taskThreadId == null || health.threadId === taskThreadId);
    if (latest.readiness.coreReady && !taskToolsReady &&
      relayChanged && codexChanged && injectorChanged && ownerMatches && launcherReady &&
      !activatedPids.has(latest.codexPids[0])) {
      taskToolsActivation = await activateTaskTools(control, latest);
      activatedPids.add(latest.codexPids[0]);
    }
    if (latest.readiness.ready && taskToolsReady && relayChanged && codexChanged && injectorChanged && ownerMatches && launcherReady) {
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
  if (!launcherReady) reasons.push(`launcher-not-ready:${JSON.stringify(latest?.launcher ?? null)}`);
  throw new Error(`等待 Codex 生命周期就绪超时：${reasons.join(", ")}`);
}

async function assertStableHost(control, baseline, durationMs) {
  const deadline = Date.now() + durationMs;
  let latest = baseline;
  while (Date.now() < deadline) {
    latest = await inspectLifecycleHost({
      installedApp: control.installedApp,
      expectedProtocol: control.expectedProtocol,
      threadId: control.sessionCheckpoint ? bindLifecycleTask(control).threadId : null,
    });
    latest.launcher = await readSingleInstanceStatus();
    if (latest.launcher.phase !== "ready" || latest.launcher.pid !== baseline.launcher.pid ||
      latest.launcher.revision !== baseline.launcher.revision) {
      throw new Error(`稳定性检查期间启动流程发生变化：${JSON.stringify(latest.launcher)}`);
    }
    if (!latest.readiness.ready) throw new Error(`重复启动后的 Codex 不再就绪：${JSON.stringify(publicHostEvidence(latest))}`);
    assertHostIdentity(baseline, latest);
    await delay(WAIT_INTERVAL_MS);
  }
  return latest;
}

function assertHostIdentity(baseline, latest) {
  assertSamePids(baseline.injectorPids, latest.injectorPids, "重复启动产生了新的注入器");
  assertSamePids(baseline.codexPids, latest.codexPids, "重复启动意外重启了 Codex");
  if (baseline.relay.pid !== latest.relay.pid) throw new Error("重复启动意外替换了中继进程");
}

function launcherMatchesHost(host, version) {
  return host.launcher?.phase === "ready" && host.injectorPids.length === 1 &&
    host.launcher.pid === host.injectorPids[0] && host.launcher.version === version;
}

export async function launchApp(appPath) {
  await runCommand("/usr/bin/open", ["-n", "-a", appPath]);
}

export async function stopInjectorOwners() {
  const pids = await findInjectorListenerPids();
  for (const pid of pids) {
    const { stdout } = await execFileAsync("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="])
      .catch(() => ({ stdout: "" }));
    const command = String(stdout).trim().toLowerCase();
    if (!command.includes("codex quota injector") && !command.includes("codex-quota-injector") &&
      !command.includes("launcher.mjs")) {
      throw new Error(`49229 端口 PID ${pid} 不是可确认的注入器，拒绝终止`);
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await findInjectorListenerPids()).length === 0) return;
    await delay(100);
  }
  throw new Error("注入器单实例监听未在超时内退出");
}

export async function injectorOwnedByInstalledApp(pids, appPath) {
  const expected = resolve(join(appPath, "Contents", "Resources", "Codex Quota Injector Worker"));
  return injectorOwnedByExecutable(pids, expected);
}

export async function injectorOwnedByExecutable(pids, executablePath) {
  if (!Array.isArray(pids) || pids.length !== 1) return false;
  const expected = resolve(executablePath);
  const expectedStat = await stat(expected, { bigint: true }).catch(() => null);
  if (!expectedStat?.isFile()) return false;
  const { stdout } = await execFileAsync("/usr/sbin/lsof", [
    "-a", "-p", String(pids[0]), "-d", "txt", "-FfDin",
  ]).catch(() => ({ stdout: "" }));
  return lsofContainsFileIdentity(stdout, {
    device: expectedStat.dev,
    inode: expectedStat.ino,
  });
}

export function lsofContainsFileIdentity(output, { device, inode }) {
  const records = [];
  let current = null;
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const field = line[0];
    const value = line.slice(1);
    if (field === "f") {
      current = { descriptor: value };
      records.push(current);
    } else if (current && field === "D") {
      current.device = parseLsofInteger(value);
    } else if (current && field === "i") {
      current.inode = parseLsofInteger(value);
    }
  }
  const expectedDevice = parseLsofInteger(device);
  const expectedInode = parseLsofInteger(inode);
  return expectedDevice !== null && expectedInode !== null && records.some((record) =>
    record.descriptor === "txt" && record.device === expectedDevice && record.inode === expectedInode
  );
}

export async function installedCandidateEvidence(control) {
  if (!await pathExists(control.installedApp)) return null;
  const verified = await verifyMacAppBundle(control.installedApp, {
    projectVersion: control.projectVersion,
    architecture: control.arch,
  }).catch(() => null);
  if (!verified || verified.workerSha256 !== control.candidate.workerSha256) return null;
  return {
    installedVersion: verified.version,
    workerSha256: verified.workerSha256,
    executableSha256: verified.executableSha256,
    shimSha256: verified.shimSha256,
  };
}

export async function writePrivateJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export function launchdPlist({ label, nodeExecutable, supervisorScript, controlPath,
  workingDirectory, stdoutPath, stderrPath }) {
  const args = [nodeExecutable, supervisorScript, "--control", controlPath]
    .map((value) => `<string>${xmlEscape(value)}</string>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xmlEscape(label)}</string>
<key>ProgramArguments</key><array>${args}</array>
<key>WorkingDirectory</key><string>${xmlEscape(workingDirectory)}</string>
<key>RunAtLoad</key><true/>
<key>ProcessType</key><string>Background</string>
<key>AbandonProcessGroup</key><true/>
<key>StandardOutPath</key><string>${xmlEscape(stdoutPath)}</string>
<key>StandardErrorPath</key><string>${xmlEscape(stderrPath)}</string>
</dict></plist>
`;
}

function publicHostEvidence(host, extra = {}) {
  return {
    codexPids: host.codexPids,
    hostHealth: host.hostHealth ?? host.readiness.hostHealth,
    ...(host.taskToolsActivation ? { taskToolsActivation: host.taskToolsActivation } : {}),
    injectorPids: host.injectorPids,
    relayPid: host.relay.pid,
    relayProtocol: host.relay.protocol,
    debugReady: host.readiness.debugReady,
    generationMatches: host.relay.generationMatches,
    readiness: host.readiness,
    launcher: host.launcher ?? null,
    ...extra,
  };
}

function assertExpectedAccount(currentAccountId, accounts, action) {
  if (currentAccountId !== accounts.originalId && currentAccountId !== accounts.targetId) {
    throw new Error(`${action}前检测到测试范围外的账号变化，拒绝继续`);
  }
}

function parseLsofInteger(value) {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function redactAccountError(error, view) {
  let message = String(error?.message ?? error);
  for (const account of view?.accounts ?? []) {
    for (const secret of [account.id, account.email]) {
      if (secret) message = message.replaceAll(secret, "[已隐藏账号]");
    }
  }
  const replacement = new Error(message);
  replacement.code = error?.code;
  return replacement;
}

function assertSamePids(left, right, message) {
  if (!samePids(left, right)) throw new Error(message);
}

function samePids(left, right) {
  return JSON.stringify([...(left ?? [])].sort((a, b) => a - b)) ===
    JSON.stringify([...(right ?? [])].sort((a, b) => a - b));
}

async function runCommand(file, args, options = {}) {
  const result = await execFileAsync(file, args, {
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  });
  return result;
}

async function fileHash(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

async function assertBinaryArchitecture(path, architecture) {
  const { stdout } = await execFileAsync("/usr/bin/lipo", ["-archs", path], { encoding: "utf8" });
  const actual = String(stdout).trim().split(/\s+/).filter(Boolean);
  const expected = architecture === "x64" ? "x86_64" : "arm64";
  if (actual.length !== 1 || actual[0] !== expected) {
    throw new Error(`Node.js 运行时架构不匹配：期望 ${expected}，实际 ${actual.join("/") || "未知"}`);
  }
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
