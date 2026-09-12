import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  access,
  chmod,
  cp,
  mkdir,
  open,
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
  DEFAULT_WINDOWS_INSTALL_DIR,
  findInjectorListenerPids,
  inspectLifecycleHost,
  lifecycleFingerprint,
  publicLifecycleHost,
  readInstalledVersion,
  readJson,
} from "../src/lifecycle-host.mjs";
import {
  codexRunsInWindowsSubsystemForLinux,
  stopCodex,
} from "../src/platform.mjs";
import { assertValidWslRelayExecutable } from "../src/relay-artifact.mjs";
import { sendWakeupRequest } from "../src/wakeup-client.mjs";
import { assertValidWindowsRelayExecutable } from "../src/windows-artifact.mjs";

const execFileAsync = promisify(execFile);
const WAIT_INTERVAL_MS = 500;

export async function createWindowsLifecyclePlan({
  root,
  projectVersion,
  expectedProtocol,
  installedApp = DEFAULT_WINDOWS_INSTALL_DIR,
  installerPath = null,
} = {}) {
  const host = await inspectLifecycleHost({ installedApp, expectedProtocol });
  const installedPresent = await pathExists(installedApp);
  const installationState = installedPresent === Boolean(host.installedVersion)
    ? installedPresent ? "versioned" : "empty"
    : "blocked-inconsistent-install";
  const wslMode = await codexRunsInWindowsSubsystemForLinux();
  const sourceRecoveryRelay = join(
    root,
    "build",
    wslMode
      ? `codex-quota-relay-wsl-${projectVersion}`
      : `codex-quota-relay-windows-${projectVersion}.exe`,
  );
  const sourceRecovery = installationState !== "empty" || await pathExists(sourceRecoveryRelay)
    ? "ready"
    : "blocked-missing-native-relay";
  return {
    batch: "C-lifecycle",
    mode: "windows-task-scheduler-supervisor",
    platform: process.platform,
    arch: process.arch,
    projectVersion,
    expectedRelayProtocol: expectedProtocol,
    installerPath,
    installationState,
    sourceRecovery,
    sourceRecoveryRelay,
    sourceRecoveryMode: wslMode ? "wsl" : "windows",
    tokenRequests: host.accounts.roundTripAvailable ? 1 : 0,
    actions: [
      "验证 Windows Setup 与版本化原生/WSL 中继",
      "备份旧安装并由 Setup 完成安全接管更新",
      "正式入口接管现有注入器并等待 Codex 重新启动",
      "核对中继 generation 已加载目标协议",
      "重复启动仍保持一个注入器和同一 Codex",
      "终止中继进程并核对自动或入口触发恢复",
      "关闭 Codex 后由正式入口重新启动",
      "真实账号切换、一次最低价官方模型冒烟、回切原账号",
    ],
    host: publicLifecycleHost(host),
    accountRoundTrip: host.accounts.roundTripAvailable
      ? "ready"
      : "blocked-less-than-two-oauth-accounts",
    controller: "Windows Task Scheduler one-shot task",
    progress: "default browser local progress page",
    reportDirectory: join(root, ".runtime", "test-results", "lifecycle"),
  };
}

export async function verifyWindowsInstaller(installerPath, { projectVersion } = {}) {
  const expectedName = `Codex-Quota-Injector-${projectVersion}-windows-x64-Setup.exe`;
  const info = await stat(installerPath).catch(() => null);
  if (!info?.isFile() || info.size < 10 * 1024 * 1024) {
    throw new Error(`Windows Setup 不存在或大小异常: ${installerPath}`);
  }
  const file = await open(installerPath, "r");
  const magic = Buffer.alloc(2);
  try {
    await file.read(magic, 0, 2, 0);
  } finally {
    await file.close();
  }
  if (magic.toString("ascii") !== "MZ") {
    throw new Error(`Windows Setup 不是有效的 PE 文件: ${installerPath}`);
  }
  if (projectVersion && installerPath.split(/[\\/]/).at(-1) !== expectedName) {
    throw new Error(`Windows Setup 文件名与项目版本不匹配，期望 ${expectedName}`);
  }
  return {
    version: projectVersion,
    architecture: "x64",
    installerPath: resolve(installerPath),
    installerSha256: await fileHash(installerPath),
    size: info.size,
  };
}

export async function verifyWindowsInstallation(installDir, {
  projectVersion,
  assertWindowsExecutable = assertValidWindowsRelayExecutable,
  assertWslExecutable = assertValidWslRelayExecutable,
  readVersion = readInstalledVersion,
  hashFile = fileHash,
} = {}) {
  const executable = join(installDir, "Codex Quota Injector.exe");
  const windowsRelay = join(
    installDir,
    "relay",
    `codex-quota-relay-windows-${projectVersion}.exe`,
  );
  const wslRelay = join(installDir, "relay", `codex-quota-relay-wsl-${projectVersion}`);
  await assertWindowsExecutable(executable);
  await assertWindowsExecutable(windowsRelay);
  await assertWslExecutable(wslRelay);
  const installedVersion = await readVersion(installDir);
  if (installedVersion !== projectVersion) {
    throw new Error(
      `Windows 已安装版本不匹配：期望 ${projectVersion}，实际 ${installedVersion ?? "未知"}`,
    );
  }
  return {
    installedVersion,
    executableSha256: await hashFile(executable),
    windowsRelaySha256: await hashFile(windowsRelay),
    wslRelaySha256: await hashFile(wslRelay),
  };
}

export function createWindowsLifecycleOperations(controlPath, initialControl) {
  let control = structuredClone(initialControl);
  const updateControl = async (runtimePatch) => {
    control.runtime = { ...(control.runtime ?? {}), ...runtimePatch };
    await writePrivateJson(controlPath, control);
  };
  const currentHost = (expectedProtocol = control.expectedProtocol) => inspectLifecycleHost({
    installedApp: control.installedApp,
    expectedProtocol,
  });
  const verifyReady = async (options = {}) => waitForWindowsTargetHost(control, options);
  const restartThroughInstalledEntry = async () => {
    await launchWindowsApp(control.installedApp);
    return verifyReady();
  };
  const restoreOriginalAccount = async () => {
    if (!control.accounts?.available) return { skipped: true };
    await stopWindowsInjectorOwners();
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
    await stopCodex();
    const host = await restartThroughInstalledEntry();
    return {
      account: lifecycleFingerprint(control.accounts.originalId),
      codexPids: host.codexPids,
      relayPid: host.relay.pid,
    };
  };

  return {
    "verify-package": {
      replaySafe: true,
      run: async () => verifyWindowsInstaller(control.installerPath, {
        projectVersion: control.projectVersion,
      }),
      reconcile: async () => ({
        completed: true,
        evidence: await verifyWindowsInstaller(control.installerPath, {
          projectVersion: control.projectVersion,
        }),
      }),
    },
    "install-update": {
      replaySafe: true,
      run: async () => {
        if (control.initialHost.installedPresent && !await pathExists(control.backupApp)) {
          const backupStaging = `${control.backupApp}.staging`;
          await rm(backupStaging, { recursive: true, force: true });
          await cp(control.installedApp, backupStaging, { recursive: true, force: false });
          await rename(backupStaging, control.backupApp);
          await updateControl({ backupCreated: true });
        }
        await updateControl({ installStarted: true });
        const evidence = await installWindowsPackage(control);
        await updateControl({ installed: true, installedEvidence: evidence });
        return evidence;
      },
      reconcile: async () => {
        const installed = await installedWindowsCandidateEvidence(control);
        return installed
          ? { completed: true, evidence: installed }
          : { completed: false, safeToRetry: true };
      },
      rollback: async () => rollbackWindowsInstallation(control),
    },
    "launch-updated": {
      replaySafe: true,
      run: async () => {
        const before = await currentHost();
        const alreadyInstalledOwner = await windowsInjectorOwnedByInstalledApp(
          before.injectorPids,
          control.installedApp,
        );
        await launchWindowsApp(control.installedApp);
        const requireCodexChange = control.initialHost?.relay?.protocol !== control.expectedProtocol;
        const host = await verifyReady({
          previousCodexPids: requireCodexChange ? control.initialHost.codexPids : null,
          previousInjectorPids: alreadyInstalledOwner ? null : before.injectorPids,
          ownerCheck: (snapshot) => windowsInjectorOwnedByInstalledApp(
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
          await windowsInjectorOwnedByInstalledApp(host.injectorPids, control.installedApp);
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
        await launchWindowsApp(control.installedApp);
        const after = await assertStableWindowsHost(control, before, 8_000);
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
          ? { completed: true, evidence: publicHostEvidence(host, {
              recoveredAfterControllerInterruption: true,
            }) }
          : { completed: false, safeToRetry: false };
      },
    },
    "relay-reconnect": {
      replaySafe: true,
      run: async () => {
        const before = await verifyReady();
        await updateControl({ reconnectBaselineRelayPid: before.relay.pid });
        await terminateWindowsRelay(before.relay);
        let host;
        let recovery = "automatic";
        try {
          host = await verifyReady({ previousRelayPid: before.relay.pid, timeoutMs: 15_000 });
        } catch {
          recovery = "injector-entry";
          await launchWindowsApp(control.installedApp);
          host = await verifyReady({ previousRelayPid: before.relay.pid });
        }
        return publicHostEvidence(host, { previousRelayPid: before.relay.pid, recovery });
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
        await stopCodex();
        const stopped = await currentHost();
        if (stopped.codexPids.length !== 0) throw new Error("Codex 关闭后仍有主进程存活");
        const host = await restartThroughInstalledEntry();
        if (samePids(before.codexPids, host.codexPids)) {
          throw new Error("Codex 重开后 PID 没有变化");
        }
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
        await stopWindowsInjectorOwners();
        const manager = new AccountManager();
        try {
          const view = await manager.initialize();
          assertExpectedAccount(view.currentAccountId, control.accounts, "切换测试账号");
          if (view.currentAccountId !== control.accounts.targetId) {
            await manager.switchAccount(control.accounts.targetId);
          }
          await updateControl({ accountWritten: "target" });
          await stopCodex();
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
            const completed = host.readiness.ready &&
              control.runtime?.targetAccountRestarted === true &&
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
      rollback: restoreOriginalAccount,
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
          const completed = view.currentAccountId === control.accounts.originalId &&
            host.readiness.ready;
          return completed
            ? { completed: true, evidence: publicHostEvidence(host, {
                account: lifecycleFingerprint(control.accounts.originalId),
              }) }
            : { completed: false, safeToRetry: true };
        } finally {
          manager.close();
        }
      },
      rollback: restoreOriginalAccount,
    },
    "final-state": {
      replaySafe: true,
      run: async () => {
        const host = await verifyReady();
        const installed = await installedWindowsCandidateEvidence(control);
        if (!installed) throw new Error("最终安装包不是本次测试版本");
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
        await rm(control.backupApp, { recursive: true, force: true });
        return publicHostEvidence(host, {
          installed,
          originalAccountRestored: control.accounts?.available ? true : null,
        });
      },
      reconcile: async () => {
        const host = await currentHost();
        const installed = await installedWindowsCandidateEvidence(control);
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
}

export async function installWindowsPackage(control) {
  await verifyWindowsInstaller(control.installerPath, { projectVersion: control.projectVersion });
  const existing = await installedWindowsCandidateEvidence(control);
  if (existing && control.runtime?.installed === true) return existing;
  await runCommand(control.installerPath, ["/S"], { timeout: 180_000, windowsHide: false });
  return verifyWindowsInstallation(control.installedApp, {
    projectVersion: control.projectVersion,
  });
}

export async function rollbackWindowsInstallation(control) {
  const backupExists = await pathExists(control.backupApp);
  const installedCandidate = backupExists
    ? null
    : await installedWindowsCandidateEvidence(control);
  const rollbackAction = selectWindowsInstallRollbackAction({
    backupExists,
    initialInstalledPresent: control.initialHost.installedPresent,
    initialInstalledVersion: control.initialHost.installedVersion,
    projectVersion: control.projectVersion,
    installedCandidate: Boolean(installedCandidate),
    installStarted: control.runtime?.installStarted === true,
  });
  await stopWindowsInjectorOwners();
  await stopCodex();
  if (rollbackAction === "restore-backup") {
    await rm(control.installedApp, { recursive: true, force: true });
    await cp(control.backupApp, control.installedApp, { recursive: true, force: true });
    await restoreWindowsInstallRegistry(control.initialHost.installedVersion, control.installedApp);
  } else if (rollbackAction === "remove-installed") {
    await rm(control.installedApp, { recursive: true, force: true });
    await removeWindowsInstallRegistration();
  }

  let expectedProtocol;
  let ownerCheck;
  let ownerFailure;
  let recoveryEntry;
  if (rollbackAction === "remove-installed") {
    await launchWindowsSourceEntry(control.root, control.sourceRecoveryRelay);
    expectedProtocol = control.expectedProtocol;
    ownerCheck = (snapshot) => windowsInjectorOwnedBySource(snapshot.injectorPids, control.root);
    ownerFailure = "rollback-source-owner";
    recoveryEntry = "current-source";
  } else {
    if (!await pathExists(join(control.installedApp, "Codex Quota Injector.exe"))) {
      throw new Error("Windows 安装回滚后没有可启动的注入器");
    }
    await launchWindowsApp(control.installedApp);
    expectedProtocol = rollbackAction === "restore-backup" || rollbackAction === "leave-original"
      ? control.initialHost?.relay?.protocol ?? null
      : control.expectedProtocol;
    ownerCheck = (snapshot) => windowsInjectorOwnedByInstalledApp(
      snapshot.injectorPids,
      control.installedApp,
    );
    ownerFailure = "rollback-installed-owner";
    recoveryEntry = "installed-package";
  }
  const host = await waitForWindowsTargetHost({
    ...control,
    expectedProtocol,
  }, {
    ownerCheck,
    ownerFailure,
  });
  return publicHostEvidence(host, {
    installedVersion: await readInstalledVersion(control.installedApp),
    rollbackAction,
    recoveryEntry,
  });
}

export function selectWindowsInstallRollbackAction({
  backupExists,
  initialInstalledPresent,
  initialInstalledVersion,
  projectVersion,
  installedCandidate,
  installStarted = true,
}) {
  if (backupExists) return "restore-backup";
  if (!initialInstalledPresent && !initialInstalledVersion) return "remove-installed";
  if (initialInstalledPresent && !installStarted) return "leave-original";
  if (initialInstalledVersion === projectVersion && installedCandidate) return "leave-installed";
  throw new Error("Windows 安装前文件备份不存在，拒绝把未知安装状态标为已回滚");
}

export async function waitForWindowsTargetHost(control, {
  timeoutMs = 90_000,
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
    ownerMatches = ownerCheck === null || await ownerCheck(latest);
    if (latest.readiness.ready && relayChanged && codexChanged && injectorChanged && ownerMatches) {
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
  throw new Error(`等待 Windows Codex 生命周期就绪超时：${reasons.join(", ")}`);
}

export async function launchWindowsApp(installDir) {
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

export async function launchWindowsSourceEntry(root, relayExecutable) {
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

export async function stopWindowsInjectorOwners() {
  const pids = await findInjectorListenerPids();
  for (const pid of pids) {
    const processInfo = await readWindowsProcessInfo(pid);
    const identity = `${processInfo.name} ${processInfo.executablePath} ${processInfo.commandLine}`
      .toLowerCase();
    if (!identity.includes("codex quota injector") &&
      !identity.includes("codex-quota-injector") &&
      !/[\\/]src[\\/]launcher\.mjs/.test(identity)) {
      throw new Error(`49229 端口 PID ${pid} 不是可确认的注入器，拒绝终止`);
    }
    await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T"], {
      windowsHide: true,
    }).catch(() => undefined);
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await findInjectorListenerPids()).length === 0) return;
    await delay(100);
  }
  for (const pid of await findInjectorListenerPids()) {
    await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
    }).catch(() => undefined);
  }
  const forceDeadline = Date.now() + 2_000;
  while (Date.now() < forceDeadline) {
    if ((await findInjectorListenerPids()).length === 0) return;
    await delay(100);
  }
  throw new Error("Windows 注入器单实例监听未在超时内退出");
}

export async function windowsInjectorOwnedByInstalledApp(pids, installDir) {
  if (!Array.isArray(pids) || pids.length !== 1) return false;
  const expected = resolve(join(installDir, "Codex Quota Injector.exe")).toLowerCase();
  const actual = resolve((await readWindowsProcessInfo(pids[0])).executablePath || ".")
    .toLowerCase();
  return actual === expected;
}

export async function windowsInjectorOwnedBySource(pids, root) {
  if (!Array.isArray(pids) || pids.length !== 1) return false;
  const processInfo = await readWindowsProcessInfo(pids[0]);
  const expectedExecutable = resolve(process.execPath).toLowerCase();
  const expectedLauncher = resolve(join(root, "src", "launcher.mjs"))
    .replaceAll("/", "\\")
    .toLowerCase();
  const actualExecutable = resolve(processInfo.executablePath || ".").toLowerCase();
  const commandLine = processInfo.commandLine.replaceAll("/", "\\").toLowerCase();
  return actualExecutable === expectedExecutable && commandLine.includes(expectedLauncher);
}

export async function installedWindowsCandidateEvidence(control) {
  if (!await pathExists(control.installedApp)) return null;
  const verified = await verifyWindowsInstallation(control.installedApp, {
    projectVersion: control.projectVersion,
  }).catch(() => null);
  if (!verified) return null;
  const expected = control.runtime?.installedEvidence;
  if (expected && ["executableSha256", "windowsRelaySha256", "wslRelaySha256"]
    .some((key) => expected[key] !== verified[key])) return null;
  return verified;
}

export async function writePrivateJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export function windowsScheduledTaskScript({
  taskName,
  nodeExecutable,
  supervisorScript,
  controlPath,
  workingDirectory,
} = {}) {
  const argument = `${quoteWindowsArgument(supervisorScript)} --control ${quoteWindowsArgument(controlPath)}`;
  return `
$ErrorActionPreference='Stop';
$action=New-ScheduledTaskAction -Execute '${powershellQuote(nodeExecutable)}' -Argument '${powershellQuote(argument)}' -WorkingDirectory '${powershellQuote(workingDirectory)}';
$principal=New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited;
Register-ScheduledTask -TaskName '${powershellQuote(taskName)}' -Action $action -Principal $principal -Force | Out-Null;
Start-ScheduledTask -TaskName '${powershellQuote(taskName)}';
`;
}

async function terminateWindowsRelay(relay) {
  if (!Number.isInteger(relay?.pid) || relay.pid <= 0) throw new Error("中继 PID 无效");
  if (relay.wslNative) {
    await execFileAsync("wsl.exe", ["-e", "kill", "-TERM", String(relay.pid)], {
      windowsHide: true,
    });
    return;
  }
  await execFileAsync("taskkill.exe", ["/PID", String(relay.pid), "/T", "/F"], {
    windowsHide: true,
  });
}

async function assertStableWindowsHost(control, baseline, durationMs) {
  const deadline = Date.now() + durationMs;
  let latest = baseline;
  while (Date.now() < deadline) {
    latest = await inspectLifecycleHost({
      installedApp: control.installedApp,
      expectedProtocol: control.expectedProtocol,
    });
    if (!latest.readiness.ready) throw new Error("重复启动后的 Codex 不再就绪");
    assertSamePids(baseline.injectorPids, latest.injectorPids, "重复启动产生了新的注入器");
    assertSamePids(baseline.codexPids, latest.codexPids, "重复启动意外重启了 Codex");
    if (baseline.relay.pid !== latest.relay.pid) throw new Error("重复启动意外替换了中继进程");
    await delay(WAIT_INTERVAL_MS);
  }
  return latest;
}

async function readWindowsProcessInfo(pid) {
  const script = `
$item=Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(pid)}' -ErrorAction SilentlyContinue;
if ($item) { $item | Select-Object Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress }
`;
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
  );
  const value = JSON.parse(String(stdout).trim() || "{}");
  return {
    name: String(value.Name ?? ""),
    executablePath: String(value.ExecutablePath ?? ""),
    commandLine: String(value.CommandLine ?? ""),
  };
}

async function restoreWindowsInstallRegistry(version, installDir) {
  if (!version) return;
  const script = `
$install='${powershellQuote(installDir)}';
New-Item -Path 'HKCU:\Software\Codex Quota Injector' -Force | Out-Null;
Set-ItemProperty -LiteralPath 'HKCU:\Software\Codex Quota Injector' -Name InstallDir -Value $install;
$uninstall='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Codex Quota Injector';
New-Item -Path $uninstall -Force | Out-Null;
Set-ItemProperty -LiteralPath $uninstall -Name DisplayName -Value 'Codex Quota Injector';
Set-ItemProperty -LiteralPath $uninstall -Name DisplayVersion -Value '${powershellQuote(version)}';
Set-ItemProperty -LiteralPath $uninstall -Name InstallLocation -Value $install;
Set-ItemProperty -LiteralPath $uninstall -Name UninstallString -Value ('"' + (Join-Path $install 'Uninstall.exe') + '"');
`;
  await runPowerShell(script);
}

async function removeWindowsInstallRegistration() {
  const script = `
Remove-Item -LiteralPath 'HKCU:\\Software\\Codex Quota Injector' -Recurse -Force -ErrorAction SilentlyContinue;
Remove-Item -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Codex Quota Injector' -Recurse -Force -ErrorAction SilentlyContinue;
$desktop=[Environment]::GetFolderPath('Desktop');
$programs=[Environment]::GetFolderPath('Programs');
Remove-Item -LiteralPath (Join-Path $desktop 'Codex Quota Injector.lnk') -Force -ErrorAction SilentlyContinue;
Remove-Item -LiteralPath (Join-Path $programs 'Codex Quota Injector') -Recurse -Force -ErrorAction SilentlyContinue;
`;
  await runPowerShell(script);
}

function publicHostEvidence(host, extra = {}) {
  return {
    codexPids: host.codexPids,
    injectorPids: host.injectorPids,
    relayPid: host.relay.pid,
    relayProtocol: host.relay.protocol,
    relayMode: host.relay.wslNative ? "wsl" : "windows",
    debugReady: host.readiness.debugReady,
    generationMatches: host.relay.generationMatches,
    ...extra,
  };
}

function assertExpectedAccount(currentAccountId, accounts, action) {
  if (currentAccountId !== accounts.originalId && currentAccountId !== accounts.targetId) {
    throw new Error(`${action}前检测到测试范围外的账号变化，拒绝继续`);
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
  return execFileAsync(file, args, {
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  });
}

async function runPowerShell(script) {
  return execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
  );
}

async function fileHash(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function quoteWindowsArgument(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

function powershellQuote(value) {
  return String(value).replaceAll("'", "''");
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
