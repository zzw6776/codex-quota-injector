import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  access,
  chmod,
  cp,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { AccountManager } from "../src/account-manager.mjs";
import {
  commitRolloutHistoryRepair,
  inspectRolloutHistory,
  prepareRolloutHistoryRepair,
} from "../src/lifecycle-history.mjs";
import {
  inspectThreadHistoryStore,
  resetThreadHistoryProjection,
} from "../src/lifecycle-history-store.mjs";
import { requestThreadHistoryRebuild } from "../src/lifecycle-history-rebuild.mjs";
import {
  DEFAULT_WINDOWS_INSTALL_DIR,
  findInjectorListenerPids,
  inspectLifecycleHost,
  lifecycleFingerprint,
  publicLifecycleHost,
  readInstalledVersion,
  readJson,
} from "../src/lifecycle-host.mjs";
import { waitForCodexTurnsIdle } from "../src/lifecycle-turn-gate.mjs";
import {
  codexRunsInWindowsSubsystemForLinux,
  defaultAccountDataDir,
  parseWindowsSubsystemSetting,
  stopCodex,
  updateWindowsSubsystemSetting,
} from "../src/platform.mjs";
import { assertValidWslRelayExecutable } from "../src/relay-artifact.mjs";
import { sendWakeupRequest } from "../src/wakeup-client.mjs";
import { assertValidWindowsRelayExecutable } from "../src/windows-artifact.mjs";
import { WINDOWS_NATIVE, WSL_NATIVE } from "./test-runtime-targets.mjs";

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
  const currentRuntime = wslMode ? WSL_NATIVE : WINDOWS_NATIVE;
  const wslRuntime = await inspectWslLifecyclePrerequisites();
  const sourceRecoveryRelay = join(
    root,
    "build",
    wslMode
      ? `codex-quota-relay-wsl-${projectVersion}`
      : `codex-quota-relay-windows-${projectVersion}.exe`,
  );
  const sourceRecoveryCheck = await inspectWindowsSourceRecovery({
    installationState,
    currentRuntime,
    sourceRecoveryRelay,
  });
  return {
    batch: "C-lifecycle",
    mode: "windows-task-scheduler-supervisor",
    platform: process.platform,
    arch: process.arch,
    projectVersion,
    expectedRelayProtocol: expectedProtocol,
    installerPath,
    installationState,
    sourceRecovery: sourceRecoveryCheck.status,
    sourceRecoveryReason: sourceRecoveryCheck.reason,
    sourceRecoveryRelay,
    sourceRecoveryMode: currentRuntime,
    currentRuntime,
    runtimeTargets: [WINDOWS_NATIVE, WSL_NATIVE],
    automaticRuntimeSwitch: true,
    manualRuntimeSwitchRequired: false,
    wslRuntime,
    tokenRequests: host.accounts.roundTripAvailable ? 1 : 0,
    actions: [
      "验证 Windows Setup 与版本化原生/WSL 中继",
      "等待所有 Codex 活动回合完成落盘后再执行可能中断桌面的操作",
      "备份旧安装并由 Setup 完成安全接管更新",
      "自动切换并验证 Windows 原生 Relay 的接管、单实例、重连和关闭重开",
      "自动切换并验证 WSL 原生 Relay 的接管、单实例、重连和关闭重开",
      "恢复测试前的 Codex 运行方式并核对正式入口",
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

export async function inspectWindowsSourceRecovery({
  installationState,
  currentRuntime,
  sourceRecoveryRelay,
  assertWindowsExecutable = assertValidWindowsRelayExecutable,
  assertWslExecutable = assertValidWslRelayExecutable,
} = {}) {
  if (installationState !== "empty") return { status: "ready", reason: null };
  try {
    if (currentRuntime === WINDOWS_NATIVE) await assertWindowsExecutable(sourceRecoveryRelay);
    else if (currentRuntime === WSL_NATIVE) await assertWslExecutable(sourceRecoveryRelay);
    else throw new Error(`未知 Windows 运行环境 ${currentRuntime}`);
    return { status: "ready", reason: null };
  } catch (error) {
    return {
      status: "blocked-invalid-or-missing-native-relay",
      reason: String(error?.message ?? error),
    };
  }
}

export async function inspectWslLifecyclePrerequisites({
  platform = process.platform,
  execFileImpl = execFileAsync,
} = {}) {
  if (platform !== "win32") {
    return { status: "not-applicable", reason: "仅 Windows 支持 WSL 生命周期" };
  }
  try {
    const { stdout } = await execFileImpl("wsl.exe", [
      "-e", "sh", "-lc",
      "set -eu; command -v codex >/dev/null; command -v node >/dev/null; " +
        "node -e \"import('node:sqlite')\" >/dev/null 2>&1; " +
        "test -r /proc/sys/kernel/random/boot_id; printf ready",
    ], { windowsHide: true, encoding: "utf8", timeout: 10_000 });
    if (String(stdout).trim() !== "ready") throw new Error("WSL 就绪探针没有返回 ready");
    return { status: "ready" };
  } catch (error) {
    return { status: "blocked", reason: `WSL 原生 Codex 环境不可用：${error.message}` };
  }
}

export async function captureWindowsRuntimeConfiguration({
  runDirectory,
  configPath = join(homedir(), ".codex", "config.toml"),
} = {}) {
  const backupPath = join(runDirectory, "codex-config.before-runtime-switch.toml");
  let contents;
  let existed = true;
  try {
    contents = await readFile(configPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    existed = false;
    contents = Buffer.alloc(0);
  }
  if (existed) await writeFile(backupPath, contents, { mode: 0o600 });
  const text = contents.toString("utf8");
  return {
    configPath,
    backupPath,
    existed,
    sha256: hashBytes(contents),
    generatedSha256: {
      [WINDOWS_NATIVE]: hashBytes(Buffer.from(updateWindowsSubsystemSetting(text, false))),
      [WSL_NATIVE]: hashBytes(Buffer.from(updateWindowsSubsystemSetting(text, true))),
    },
    originalRuntime: parseConfigRuntime(text),
    mutationStarted: false,
  };
}

export async function setWindowsRuntimeConfiguration(configuration, runtimeTarget) {
  if (![WINDOWS_NATIVE, WSL_NATIVE].includes(runtimeTarget)) {
    throw new Error(`Windows 生命周期运行环境无效：${runtimeTarget}`);
  }
  const contents = await readFile(configuration.configPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  const currentHash = contents == null ? null : hashBytes(contents);
  const allowedHashes = new Set([
    configuration.sha256,
    ...Object.values(configuration.generatedSha256 ?? {}),
    configuration.lastAppliedSha256,
    configuration.restoredSha256,
  ]);
  const initialMissing = contents == null && !configuration.existed && !configuration.mutationStarted;
  const externalChangeAfterMutation = currentHash != null && !allowedHashes.has(currentHash) &&
    configuration.mutationStarted &&
    parseConfigRuntime(contents.toString("utf8")) === configuration.activeRuntime;
  const preservingExternalContent = externalChangeAfterMutation ||
    currentHash === configuration.lastAppliedSha256 &&
      configuration.externalChangesPreserved === true;
  if (!initialMissing && (currentHash == null ||
    !allowedHashes.has(currentHash) && !externalChangeAfterMutation)) {
    throw new Error("Codex 配置在生命周期测试期间被外部修改，拒绝切换运行方式");
  }
  const updated = updateWindowsSubsystemSetting(contents?.toString("utf8") ?? "", runtimeTarget === WSL_NATIVE);
  if (!preservingExternalContent && hashBytes(Buffer.from(updated)) !==
    configuration.generatedSha256?.[runtimeTarget]) {
    throw new Error("Codex 运行方式切换结果与测试前生成的安全版本不一致");
  }
  await writePrivateText(configuration.configPath, updated);
  configuration.mutationStarted = true;
  configuration.activeRuntime = runtimeTarget;
  configuration.lastAppliedSha256 = hashBytes(Buffer.from(updated));
  configuration.restoredSha256 = null;
  configuration.externalChangesPreserved = configuration.externalChangesPreserved === true ||
    externalChangeAfterMutation;
  const actual = parseConfigRuntime(await readFile(configuration.configPath, "utf8"));
  if (actual !== runtimeTarget) throw new Error(`Codex 运行方式写入后仍为 ${actual}`);
  return { runtimeTarget, configSha256: hashBytes(Buffer.from(updated)) };
}

export async function restoreWindowsRuntimeConfiguration(configuration) {
  const current = await readFile(configuration.configPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  const currentHash = current ? hashBytes(current) : null;
  const allowedHashes = new Set([
    configuration.sha256,
    ...Object.values(configuration.generatedSha256 ?? {}),
    configuration.lastAppliedSha256,
  ]);
  let restored;
  let externalChangesPreserved = false;
  if (currentHash != null && currentHash === configuration.restoredSha256) {
    restored = current;
    externalChangesPreserved = configuration.externalChangesPreserved === true;
  } else if (currentHash != null && (!allowedHashes.has(currentHash) ||
    currentHash === configuration.lastAppliedSha256 &&
      configuration.externalChangesPreserved === true)) {
    if (!configuration.mutationStarted ||
      parseConfigRuntime(current.toString("utf8")) !== configuration.activeRuntime) {
      throw new Error("Codex 运行方式被外部修改或不属于本次测试，拒绝覆盖");
    }
    restored = Buffer.from(updateWindowsSubsystemSetting(
      current.toString("utf8"),
      configuration.originalRuntime === WSL_NATIVE,
    ));
    externalChangesPreserved = true;
    await writePrivateText(configuration.configPath, restored);
  } else if (currentHash == null && configuration.existed) {
    throw new Error("Codex 配置在生命周期测试期间被删除，拒绝覆盖未知状态");
  } else if (configuration.existed) {
    const original = await readFile(configuration.backupPath);
    if (hashBytes(original) !== configuration.sha256) {
      throw new Error("Codex 运行方式备份哈希不匹配，拒绝恢复未知内容");
    }
    await writePrivateText(configuration.configPath, original);
    restored = original;
  } else {
    await rm(configuration.configPath, { force: true });
    restored = null;
  }
  configuration.activeRuntime = configuration.originalRuntime;
  configuration.lastAppliedSha256 = restored ? hashBytes(restored) : null;
  configuration.restoredSha256 = restored ? hashBytes(restored) : null;
  configuration.externalChangesPreserved = externalChangesPreserved;
  if (!await windowsRuntimeConfigurationMatches(configuration)) {
    throw new Error("Codex 运行方式没有恢复为测试前内容");
  }
  return {
    runtimeTarget: configuration.originalRuntime,
    configRestored: true,
    configSha256: configuration.restoredSha256,
    externalChangesPreserved,
  };
}

export async function windowsRuntimeConfigurationMatches(configuration) {
  try {
    const contents = await readFile(configuration.configPath);
    return parseConfigRuntime(contents.toString("utf8")) === configuration.originalRuntime;
  } catch (error) {
    return !configuration.existed && error?.code === "ENOENT";
  }
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
  const originalRuntimeTarget = control.runtimeConfiguration?.originalRuntime ??
    (control.sourceRecoveryMode === "wsl" || control.sourceRecoveryMode === WSL_NATIVE
      ? WSL_NATIVE
      : WINDOWS_NATIVE);
  const updateControl = async (runtimePatch) => {
    control.runtime = { ...(control.runtime ?? {}), ...runtimePatch };
    await writePrivateJson(controlPath, control);
  };
  const currentHost = (expectedProtocol = control.expectedProtocol) => inspectLifecycleHost({
    installedApp: control.installedApp,
    expectedProtocol,
  });
  const verifyReady = async (options = {}) => waitForWindowsTargetHost(control, options);
  const waitForDesktopIdle = () => waitForCodexTurnsIdle({ codexHome: control.codexHome });
  const safeguardDesktopHistory = () => safeguardWindowsDesktopHistory(control, {
    updateControl,
    waitForDesktopIdle,
  });
  const waitForRuntimeHistory = (runtimeTarget) =>
    waitForWindowsHistoryDurable(control, runtimeTarget);
  const prepareRuntimeHistory = (runtimeTarget) =>
    prepareWindowsHistoryBeforeLaunch(control, runtimeTarget);
  const restartThroughInstalledEntry = async (runtimeTarget = originalRuntimeTarget) => {
    await launchWindowsApp(control.installedApp);
    return verifyReady({ expectedRuntimeTarget: runtimeTarget });
  };
  const baselineKey = (runtimeTarget, action) =>
    `${runtimeTarget.replaceAll("-", "_")}_${action}`;
  const restoreOriginalRuntime = async () => {
    await waitForDesktopIdle();
    await stopWindowsInjectorOwners();
    await stopCodex();
    const restored = await restoreWindowsRuntimeConfiguration(control.runtimeConfiguration);
    const candidateInstalled = Boolean(await installedWindowsCandidateEvidence(control));
    const recoveryEntry = selectWindowsRuntimeRestoreEntry({
      candidateInstalled,
      initialEntry: selectWindowsRecoveryEntry(control.initialHost),
    });
    let host;
    if (recoveryEntry === "candidate-package") {
      host = await restartThroughInstalledEntry(originalRuntimeTarget);
    } else if (recoveryEntry === "current-source") {
      await launchWindowsSourceEntry(control.root, control.sourceRecoveryRelay);
      host = await waitForWindowsTargetHost({
        ...control,
        expectedProtocol: control.initialHost?.relay?.protocol ?? control.expectedProtocol,
      }, {
        expectedRuntimeTarget: originalRuntimeTarget,
        ownerCheck: (snapshot) => windowsInjectorOwnedBySource(snapshot.injectorPids, control.root),
        ownerFailure: "rollback-source-owner",
      });
    } else {
      await launchWindowsApp(control.installedApp);
      host = await waitForWindowsTargetHost({
        ...control,
        expectedProtocol: control.initialHost?.relay?.protocol ?? null,
      }, {
        expectedRuntimeTarget: originalRuntimeTarget,
        ownerCheck: (snapshot) => windowsInjectorOwnedByInstalledApp(
          snapshot.injectorPids,
          control.installedApp,
        ),
        ownerFailure: "rollback-installed-owner",
      });
    }
    await updateControl({ activeRuntimeTarget: control.runtimeConfiguration.originalRuntime,
      runtimeConfigurationRestored: true });
    return publicHostEvidence(host, { ...restored, recoveryEntry });
  };
  const switchRuntimeOperation = (runtimeTarget) => ({
    replaySafe: true,
    run: async () => {
      const before = await currentHost();
      await updateControl({ [baselineKey(runtimeTarget, "switchBaseline")]: {
        codexPids: before.codexPids,
        injectorPids: before.injectorPids,
        relayPid: before.relay.pid,
      } });
      const configured = await setWindowsRuntimeConfiguration(
        control.runtimeConfiguration,
        runtimeTarget,
      );
      await updateControl({ activeRuntimeTarget: runtimeTarget });
      await waitForDesktopIdle();
      await stopWindowsInjectorOwners();
      await stopCodex();
      return { ...configured, previousRuntimeTarget: hostRuntimeTarget(before) };
    },
    rollback: restoreOriginalRuntime,
  });
  const launchRuntimeOperation = (runtimeTarget) => ({
    replaySafe: true,
    run: async () => {
      const baseline = control.runtime?.[baselineKey(runtimeTarget, "switchBaseline")] ?? {};
      const historyPreparation = await prepareRuntimeHistory(runtimeTarget);
      await launchWindowsApp(control.installedApp);
      const readyHost = await verifyReady({
        expectedRuntimeTarget: runtimeTarget,
        previousCodexPids: baseline.codexPids?.length ? baseline.codexPids : null,
        previousInjectorPids: baseline.injectorPids?.length ? baseline.injectorPids : null,
        ownerCheck: (snapshot) => windowsInjectorOwnedByInstalledApp(
          snapshot.injectorPids,
          control.installedApp,
        ),
        ownerFailure: "installed-package-owner",
      });
      const host = await waitForSettledWindowsHost(control, readyHost, {
        expectedRuntimeTarget: runtimeTarget,
        ownerCheck: (snapshot) => windowsInjectorOwnedByInstalledApp(
          snapshot.injectorPids,
          control.installedApp,
        ),
      });
      const history = {
        ...await waitForRuntimeHistory(runtimeTarget),
        rebuild: historyPreparation.rebuild,
      };
      return publicHostEvidence(host, {
        previousCodexPids: baseline.codexPids ?? [],
        packagedOwner: true,
        history,
      });
    },
    reconcile: async () => {
      const host = await currentHost();
      const packagedOwner = host.readiness.ready && runtimeModeMatches(host, runtimeTarget) &&
        await windowsInjectorOwnedByInstalledApp(host.injectorPids, control.installedApp);
      if (!packagedOwner) return { completed: false, safeToRetry: true };
      const settled = await waitForSettledWindowsHost(control, host, {
        expectedRuntimeTarget: runtimeTarget,
        ownerCheck: (snapshot) => windowsInjectorOwnedByInstalledApp(
          snapshot.injectorPids,
          control.installedApp,
        ),
      });
      const history = await waitForWindowsHistoryDurable(control, runtimeTarget);
      return { completed: true, evidence: publicHostEvidence(settled, { packagedOwner, history }) };
    },
  });
  const repeatRuntimeOperation = (runtimeTarget) => ({
    run: async () => {
      const before = await verifyReady({ expectedRuntimeTarget: runtimeTarget });
      await updateControl({ [baselineKey(runtimeTarget, "repeatBaseline")]: {
        injectorPids: before.injectorPids,
        codexPids: before.codexPids,
        relayPid: before.relay.pid,
      } });
      await launchWindowsApp(control.installedApp);
      const after = await assertStableWindowsHost(control, before, 8_000, runtimeTarget);
      return publicHostEvidence(after, { retainedInjectorPid: after.injectorPids[0] });
    },
    reconcile: async () => {
      const baseline = control.runtime?.[baselineKey(runtimeTarget, "repeatBaseline")];
      if (!baseline) return { completed: false, safeToRetry: true };
      const host = await currentHost();
      const completed = host.readiness.ready && runtimeModeMatches(host, runtimeTarget) &&
        samePids(baseline.injectorPids, host.injectorPids) &&
        samePids(baseline.codexPids, host.codexPids) && baseline.relayPid === host.relay.pid;
      return completed
        ? { completed: true, evidence: publicHostEvidence(host, {
            recoveredAfterControllerInterruption: true,
          }) }
        : { completed: false, safeToRetry: false };
    },
  });
  const reconnectRuntimeOperation = (runtimeTarget) => ({
    replaySafe: true,
    run: async () => {
      const before = await verifyReady({ expectedRuntimeTarget: runtimeTarget });
      await updateControl({ [baselineKey(runtimeTarget, "reconnectRelayPid")]: before.relay.pid });
      await waitForDesktopIdle();
      await terminateWindowsRelay(before.relay);
      let host;
      let recovery = "automatic";
      try {
        host = await verifyReady({ expectedRuntimeTarget: runtimeTarget,
          previousRelayPid: before.relay.pid, timeoutMs: 15_000 });
      } catch {
        recovery = "injector-entry";
        await launchWindowsApp(control.installedApp);
        host = await verifyReady({ expectedRuntimeTarget: runtimeTarget,
          previousRelayPid: before.relay.pid });
      }
      return publicHostEvidence(host, { previousRelayPid: before.relay.pid, recovery });
    },
    reconcile: async () => {
      const previousRelayPid = control.runtime?.[baselineKey(runtimeTarget, "reconnectRelayPid")];
      if (!previousRelayPid) return { completed: false, safeToRetry: true };
      const host = await currentHost();
      return host.readiness.ready && runtimeModeMatches(host, runtimeTarget) &&
        host.relay.pid !== previousRelayPid
        ? { completed: true, evidence: publicHostEvidence(host, { previousRelayPid }) }
        : { completed: false, safeToRetry: true };
    },
  });
  const reopenRuntimeOperation = (runtimeTarget) => ({
    replaySafe: true,
    run: async () => {
      const before = await verifyReady({ expectedRuntimeTarget: runtimeTarget });
      await updateControl({ [baselineKey(runtimeTarget, "closeCodexPids")]: before.codexPids });
      await waitForDesktopIdle();
      await stopCodex();
      const stopped = await currentHost();
      if (stopped.codexPids.length !== 0) throw new Error("Codex 关闭后仍有主进程存活");
      const injectorShutdown = await waitForWindowsInjectorOwnersExit(before.injectorPids);
      const historyPreparation = await prepareRuntimeHistory(runtimeTarget);
      const host = await restartThroughInstalledEntry(runtimeTarget);
      if (samePids(before.codexPids, host.codexPids)) throw new Error("Codex 重开后 PID 没有变化");
      const history = {
        ...await waitForRuntimeHistory(runtimeTarget),
        rebuild: historyPreparation.rebuild,
      };
      return publicHostEvidence(host, {
        previousCodexPids: before.codexPids,
        injectorShutdown,
        history,
      });
    },
    reconcile: async () => {
      const previous = control.runtime?.[baselineKey(runtimeTarget, "closeCodexPids")];
      if (!previous) return { completed: false, safeToRetry: true };
      const host = await currentHost();
      if (!host.readiness.ready || !runtimeModeMatches(host, runtimeTarget) ||
        samePids(previous, host.codexPids)) return { completed: false, safeToRetry: true };
      const history = await waitForWindowsHistoryDurable(control, runtimeTarget);
      return { completed: true, evidence: publicHostEvidence(host, {
        previousCodexPids: previous,
        history,
      }) };
    },
  });
  const restoreOriginalAccount = async () => {
    if (!control.accounts?.available) return { skipped: true };
    await waitForDesktopIdle();
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
    const host = await restartThroughInstalledEntry(originalRuntimeTarget);
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
    "wait-desktop-idle": {
      replaySafe: true,
      run: waitForDesktopIdle,
      reconcile: async () => ({ completed: false, safeToRetry: true }),
    },
    "repair-desktop-history": {
      replaySafe: true,
      run: safeguardDesktopHistory,
      reconcile: async () => control.runtime?.desktopHistory
        ? { completed: true, evidence: control.runtime.desktopHistory }
        : { completed: false, safeToRetry: true },
      rollback: async () => restartWindowsInitialEntry(control),
    },
    "install-update": {
      replaySafe: true,
      run: async () => {
        await waitForDesktopIdle();
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
    ...(control.version === 1 ? {
      "launch-updated": launchRuntimeOperation(originalRuntimeTarget),
      "repeat-launch": repeatRuntimeOperation(originalRuntimeTarget),
      "relay-reconnect": reconnectRuntimeOperation(originalRuntimeTarget),
      "close-reopen": reopenRuntimeOperation(originalRuntimeTarget),
    } : {}),
    "switch-windows-runtime": switchRuntimeOperation(WINDOWS_NATIVE),
    "launch-windows-native": launchRuntimeOperation(WINDOWS_NATIVE),
    "repeat-windows-native": repeatRuntimeOperation(WINDOWS_NATIVE),
    "reconnect-windows-native": reconnectRuntimeOperation(WINDOWS_NATIVE),
    "reopen-windows-native": reopenRuntimeOperation(WINDOWS_NATIVE),
    "switch-wsl-runtime": switchRuntimeOperation(WSL_NATIVE),
    "launch-wsl-native": launchRuntimeOperation(WSL_NATIVE),
    "repeat-wsl-native": repeatRuntimeOperation(WSL_NATIVE),
    "reconnect-wsl-native": reconnectRuntimeOperation(WSL_NATIVE),
    "reopen-wsl-native": reopenRuntimeOperation(WSL_NATIVE),
    "restore-runtime": {
      replaySafe: true,
      run: restoreOriginalRuntime,
      reconcile: async () => {
        const configRestored = await windowsRuntimeConfigurationMatches(control.runtimeConfiguration);
        const host = await currentHost();
        return configRestored && host.readiness.ready &&
          runtimeModeMatches(host, control.runtimeConfiguration.originalRuntime)
          ? { completed: true, evidence: publicHostEvidence(host, { configRestored }) }
          : { completed: false, safeToRetry: true };
      },
      rollback: restoreOriginalRuntime,
    },
    "switch-account": {
      run: async () => {
        if (!control.accounts?.available) throw new Error("没有两个可用于往返测试的 OAuth 账号");
        await waitForDesktopIdle();
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
            const completed = host.readiness.ready && runtimeModeMatches(
              host,
              originalRuntimeTarget,
            ) &&
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
            host.readiness.ready && runtimeModeMatches(
              host,
              originalRuntimeTarget,
            );
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
        const host = await verifyReady({
          expectedRuntimeTarget: originalRuntimeTarget,
        });
        const installed = await installedWindowsCandidateEvidence(control);
        if (!installed) throw new Error("最终安装包不是本次测试版本");
        if (control.runtimeConfiguration &&
          !await windowsRuntimeConfigurationMatches(control.runtimeConfiguration)) {
          throw new Error("最终 Codex 运行方式配置没有恢复为测试前内容");
        }
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
          runtimeConfigurationRestored: true,
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
        const runtimeConfigurationRestored = control.runtimeConfiguration
          ? await windowsRuntimeConfigurationMatches(control.runtimeConfiguration)
          : true;
        const completed = host.readiness.ready && runtimeModeMatches(
          host,
          originalRuntimeTarget,
        ) && installed && originalAccountRestored && runtimeConfigurationRestored;
        return completed
          ? {
              completed: true,
              evidence: publicHostEvidence(host, {
                installed,
                runtimeConfigurationRestored,
                originalAccountRestored: control.accounts?.available ? true : null,
              }),
            }
          : { completed: false, safeToRetry: true };
      },
    },
  };
}

export async function safeguardWindowsDesktopHistory(control, {
  updateControl = async () => undefined,
  waitForDesktopIdle = () => waitForCodexTurnsIdle({ codexHome: control.codexHome }),
  inspectHistory = inspectRolloutHistory,
  runStoreRequest = (runtimeTarget, request) =>
    runWindowsHistoryStoreRequest(control, runtimeTarget, request),
  stopInjectorOwners = stopWindowsInjectorOwners,
  stopDesktop = stopCodex,
  inspectHost = inspectLifecycleHost,
  prepareRepair = prepareRolloutHistoryRepair,
  commitRepair = commitRolloutHistoryRepair,
} = {}) {
  const groups = checkpointGroups(control.sessionCheckpoint);
  if (groups.length === 0) {
    const evidence = { status: "not-applicable", capturedTurns: 0, repairs: [] };
    await updateControl({ desktopHistory: evidence });
    return evidence;
  }
  await waitForDesktopIdle();
  const currentRuntime = control.runtimeConfiguration?.originalRuntime ?? control.sourceRecoveryMode;
  const inspected = [];
  for (const group of groups) {
    const history = await inspectHistory(group.path);
    if (history.activeTurn) throw new Error(`Codex 任务 ${group.threadId} 仍有活动回合，拒绝关闭桌面应用`);
    const projection = await runStoreRequest(currentRuntime, {
      operation: "inspect",
      threadId: group.threadId,
      rolloutPath: group.path,
      lastOrdinal: history.lastOrdinal,
      turnIds: group.turnIds,
    });
    inspected.push({ group, history, projection });
  }
  const repairTargets = inspected.filter(({ history, projection }) =>
    history.repairRequired || !projection.healthy
  );
  for (const { group, history, projection } of repairTargets) {
    if (history.repairRequired && !history.repairable) {
      throw new Error(`Codex 任务 ${group.threadId} 的历史损坏无法安全自动修复`);
    }
    if (!history.repairRequired &&
      !["projection-behind", "turn-not-durable", "missing-thread"].includes(projection.reason)) {
      throw new Error(
        `Codex 任务 ${group.threadId} 的分页投影异常无法安全自动修复：${projection.reason}`,
      );
    }
  }
  const repairs = [];
  if (repairTargets.length > 0) {
    await stopInjectorOwners();
    await stopDesktop();
    for (const { group, history, projection } of repairTargets) {
      const prepared = history.repairRequired
        ? await prepareRepair({
            path: group.path,
            runDirectory: dirname(control.reportPath),
            expectedSha256: history.sha256,
            expectedSize: history.size,
          })
        : null;
      const stores = [];
      for (const runtimeTarget of [WINDOWS_NATIVE, WSL_NATIVE]) {
        stores.push(await runStoreRequest(runtimeTarget, {
          operation: "reset",
          threadId: group.threadId,
          backupDirectory: join(dirname(control.reportPath), "history-database-backups"),
          label: runtimeTarget,
        }));
      }
      const committed = prepared ? await commitRepair(prepared) : null;
      repairs.push({
        threadId: group.threadId,
        reason: history.repairRequired ? "rollout-and-projection" : projection.reason,
        sourceSha256: history.sha256,
        repairedSha256: committed?.after.sha256 ?? history.sha256,
        sequenceIssues: history.sequenceIssues.length,
        insertedTerminalEvents: committed?.manifest.insertedTerminalEvents.length ?? 0,
        conversationRecords: committed?.after.conversationRecordCount ??
          history.conversationRecordCount,
        backupPath: committed?.backupPath ?? null,
        displacedPath: committed?.displacedPath ?? null,
        stores,
      });
    }
  }
  const host = await inspectHost({
    installedApp: control.installedApp,
    expectedProtocol: control.expectedProtocol,
  });
  let currentProjection = null;
  if (host.codexPids.length > 0 && repairs.length === 0) {
    currentProjection = {
      status: "durable",
      runtimeTarget: currentRuntime,
      threads: inspected.map(({ projection }) => publicHistoryStoreEvidence(projection)),
    };
  }
  const evidence = {
    status: repairs.length > 0 ? "repaired-awaiting-rebuild" : "durable",
    capturedTurns: groups.reduce((count, group) => count + group.turnIds.length, 0),
    repairs,
    currentProjection,
  };
  await updateControl({ desktopHistory: evidence });
  return evidence;
}

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

export async function prepareWindowsHistoryBeforeLaunch(control, runtimeTarget, {
  requestRebuild = requestWindowsRuntimeHistoryRebuild,
  inspectHistory = inspectRolloutHistory,
  runStoreRequest = (target, request) => runWindowsHistoryStoreRequest(control, target, request),
  inspectHost = inspectLifecycleHost,
  waitForDurable = waitForWindowsHistoryDurable,
} = {}) {
  const groups = checkpointGroups(control.sessionCheckpoint);
  if (groups.length === 0) {
    return { status: "not-applicable", runtimeTarget, rebuild: null, threads: [] };
  }
  const host = await inspectHost({
    installedApp: control.installedApp,
    expectedProtocol: control.expectedProtocol,
  });
  if ((host.codexPids ?? []).length > 0 || (host.appServerPids ?? []).length > 0) {
    throw new Error("Codex 桌面或 app-server 仍在运行，拒绝并发启动历史重建 app-server");
  }
  const latest = [];
  for (const group of groups) {
    const rollout = await inspectHistory(group.path);
    if (rollout.repairRequired || rollout.activeTurn) {
      throw new Error(`Codex 任务 ${group.threadId} 的 rollout 在启动前仍不完整`);
    }
    latest.push(await runStoreRequest(runtimeTarget, {
      operation: "inspect",
      threadId: group.threadId,
      rolloutPath: group.path,
      lastOrdinal: rollout.lastOrdinal,
      turnIds: group.turnIds,
    }));
  }
  if (latest.every((entry) => entry.healthy)) {
    return {
      status: "durable",
      runtimeTarget,
      rebuild: null,
      threads: latest.map(publicHistoryStoreEvidence),
    };
  }
  for (const entry of latest.filter((candidate) => !candidate.healthy)) {
    const missingBothDatabases = entry.reason === "missing-history-database" &&
      !entry.paths?.state && !entry.paths?.history;
    if (!missingBothDatabases &&
      !["projection-behind", "turn-not-durable", "missing-thread"].includes(entry.reason)) {
      throw new Error(
        `Codex ${runtimeTarget} 分页投影异常无法安全自动重建：${entry.reason}`,
      );
    }
  }
  const rebuild = await requestRebuild(
    control,
    runtimeTarget,
    groups.map((group) => group.threadId),
  );
  const durable = await waitForDurable(control, runtimeTarget, {
    inspectHistory,
    runStoreRequest,
  });
  return { ...durable, rebuild };
}

export async function waitForWindowsHistoryDurable(control, runtimeTarget, {
  timeoutMs = 60_000,
  pollIntervalMs = 500,
  inspectHistory = inspectRolloutHistory,
  runStoreRequest = (target, request) => runWindowsHistoryStoreRequest(control, target, request),
} = {}) {
  const groups = checkpointGroups(control.sessionCheckpoint);
  if (groups.length === 0) return { status: "not-applicable", runtimeTarget, threads: [] };
  const deadline = Date.now() + timeoutMs;
  let latest = [];
  while (Date.now() < deadline) {
    latest = [];
    for (const group of groups) {
      const rollout = await inspectHistory(group.path);
      if (rollout.repairRequired || rollout.activeTurn) {
        throw new Error(`Codex 任务 ${group.threadId} 的 rollout 在重启后仍不完整`);
      }
      latest.push(await runStoreRequest(runtimeTarget, {
        operation: "inspect",
        threadId: group.threadId,
        rolloutPath: group.path,
        lastOrdinal: rollout.lastOrdinal,
        turnIds: group.turnIds,
      }));
    }
    if (latest.every((entry) => entry.healthy)) {
      return {
        status: "durable",
        runtimeTarget,
        rebuild: null,
        threads: latest.map(publicHistoryStoreEvidence),
      };
    }
    await delay(pollIntervalMs);
  }
  throw new Error(
    `Codex ${runtimeTarget} 会话历史未在超时内完成分页持久化：` +
    latest.map((entry) => `${entry.thread?.id ?? "unknown"}:${entry.reason}`).join(", ") +
    "；桌面启动后只允许只读检查，拒绝并发启动第二个 app-server",
  );
}

export async function requestWindowsRuntimeHistoryRebuild(control, runtimeTarget, threadIds, {
  requestHistory = requestThreadHistoryRebuild,
} = {}) {
  if (![WINDOWS_NATIVE, WSL_NATIVE].includes(runtimeTarget)) {
    throw new Error(`未知 Codex 历史运行环境：${runtimeTarget}`);
  }
  const runDirectory = dirname(control.reportPath);
  const relayConfigPath = join(
    control.dataDir ?? defaultAccountDataDir(),
    "app-server-relay-config.json",
  );
  const relayConfig = await readJson(relayConfigPath);
  if (!relayConfig?.upstreamExecutable) {
    throw new Error("当前正式包中继配置不可读，无法主动重建会话历史");
  }
  const rebuildConfigPath = join(runDirectory, `history-rebuild-${runtimeTarget}-relay.json`);
  const rebuildStatePath = join(runDirectory, `history-rebuild-${runtimeTarget}-state.json`);
  const rebuildUsagePath = join(runDirectory, `history-rebuild-${runtimeTarget}-usage.jsonl`);
  await writePrivateJson(rebuildConfigPath, {
    ...relayConfig,
    relayStatePath: rebuildStatePath,
    tokenUsageEventsPath: rebuildUsagePath,
    generation: `${relayConfig.generation}:history-rebuild:${randomUUID()}`,
  });

  let command;
  let args;
  let env = { ...process.env };
  if (runtimeTarget === WINDOWS_NATIVE) {
    command = join(
      control.installedApp,
      "relay",
      `codex-quota-relay-windows-${control.projectVersion}.exe`,
    );
    args = ["app-server", "--listen", "stdio://"];
    env.CODEX_HOME = control.codexHome;
    env.CODEX_SQLITE_HOME = control.codexHome;
    env.CODEX_QUOTA_RELAY_CONFIG = rebuildConfigPath;
    env.CODEX_QUOTA_WINDOWS_NATIVE = "1";
    env.CODEX_QUOTA_WSL_NATIVE = "0";
  } else {
    const [relayExecutable, directories] = await Promise.all([
      windowsPathToWsl(join(
        control.installedApp,
        "relay",
        `codex-quota-relay-wsl-${control.projectVersion}`,
      )),
      defaultWslCodexDirectories(),
    ]);
    command = "wsl.exe";
    args = [
      "-e", "env",
      `CODEX_HOME=${directories.codexHome}`,
      `CODEX_SQLITE_HOME=${directories.sqliteHome}`,
      `CODEX_QUOTA_RELAY_CONFIG=${rebuildConfigPath}`,
      "CODEX_QUOTA_WSL_NATIVE=1",
      "CODEX_QUOTA_WINDOWS_NATIVE=0",
      relayExecutable,
      "app-server", "--listen", "stdio://",
    ];
  }
  const result = await requestHistory({ command, args, env, threadIds });
  return {
    ...result,
    method: "thread/resume",
    relayRuntime: runtimeTarget,
  };
}

async function runWindowsHistoryStoreRequest(control, runtimeTarget, request) {
  if (runtimeTarget === WINDOWS_NATIVE) {
    const native = { ...request, sqliteHome: control.codexHome };
    return request.operation === "reset"
      ? resetThreadHistoryProjection(native)
      : inspectThreadHistoryStore(native);
  }
  if (runtimeTarget !== WSL_NATIVE) throw new Error(`未知 Codex 历史运行环境：${runtimeTarget}`);
  const [scriptPath, sqliteHome, rolloutPath, backupDirectory] = await Promise.all([
    windowsPathToWsl(join(control.root, "scripts", "lifecycle-history-store.mjs")),
    defaultWslSqliteHome(),
    request.rolloutPath ? windowsPathToWsl(request.rolloutPath) : null,
    request.backupDirectory ? windowsPathToWsl(request.backupDirectory) : null,
  ]);
  const wslRequest = {
    ...request,
    sqliteHome,
    ...(rolloutPath ? { rolloutPath } : {}),
    ...(backupDirectory ? { backupDirectory } : {}),
  };
  const encoded = Buffer.from(JSON.stringify(wslRequest)).toString("base64url");
  const { stdout } = await execFileAsync("wsl.exe", [
    "-e", "node", scriptPath, `--request=${encoded}`,
  ], { windowsHide: true, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 120_000 });
  return JSON.parse(String(stdout).trim());
}

async function windowsPathToWsl(path) {
  const { stdout } = await execFileAsync("wsl.exe", ["-e", "wslpath", "-u", path], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 10_000,
  });
  const converted = String(stdout).trim();
  if (!converted.startsWith("/")) throw new Error(`Windows 路径无法转换到 WSL：${path}`);
  return converted;
}

async function defaultWslSqliteHome() {
  const { stdout } = await execFileAsync("wsl.exe", [
    "-e", "sh", "-lc", 'printf "%s" "${CODEX_SQLITE_HOME:-$HOME/.codex/sqlite}"',
  ], { windowsHide: true, encoding: "utf8", timeout: 10_000 });
  const path = String(stdout).trim();
  if (!path.startsWith("/")) throw new Error("无法确定 WSL Codex SQLite 目录");
  return path;
}

async function defaultWslCodexDirectories() {
  const { stdout } = await execFileAsync("wsl.exe", [
    "-e", "sh", "-lc",
    'printf "%s\\n%s\\n" "${CODEX_HOME:-$HOME/.codex}" "${CODEX_SQLITE_HOME:-$HOME/.codex/sqlite}"',
  ], { windowsHide: true, encoding: "utf8", timeout: 10_000 });
  const [codexHome, sqliteHome] = String(stdout).trim().split(/\r?\n/);
  if (!codexHome?.startsWith("/") || !sqliteHome?.startsWith("/")) {
    throw new Error("无法确定 WSL Codex 数据目录");
  }
  return { codexHome, sqliteHome };
}

function checkpointGroups(checkpoint) {
  const groups = new Map();
  for (const turn of checkpoint?.turns ?? []) {
    const threadId = threadIdFromRolloutPath(turn.path);
    if (!threadId || !turn.turnId) throw new Error("Codex 会话检查点缺少任务或回合 ID");
    const group = groups.get(turn.path) ?? { path: turn.path, threadId, turnIds: [] };
    group.turnIds.push(turn.turnId);
    groups.set(turn.path, group);
  }
  return [...groups.values()];
}

function threadIdFromRolloutPath(path) {
  return String(path ?? "").match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i)?.[1] ?? null;
}

function publicHistoryStoreEvidence(entry) {
  return {
    threadId: entry.thread?.id ?? null,
    historyMode: entry.thread?.historyMode ?? null,
    nextRolloutOrdinal: entry.projection?.nextRolloutOrdinal ?? null,
    rolloutSize: entry.rolloutSize,
    turns: entry.turns,
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
  await waitForCodexTurnsIdle({ codexHome: control.codexHome });
  await stopWindowsInjectorOwners();
  await stopCodex();
  if (rollbackAction === "restore-backup") {
    await rm(control.installedApp, { recursive: true, force: true });
    await cp(control.backupApp, control.installedApp, { recursive: true, force: true });
  } else if (rollbackAction === "remove-installed") {
    await rm(control.installedApp, { recursive: true, force: true });
    await removeWindowsInstallRegistration();
  }

  let expectedProtocol;
  let ownerCheck;
  let ownerFailure;
  let recoveryEntry;
  const initialEntry = selectWindowsRecoveryEntry(control.initialHost);
  if (initialEntry === "current-source") {
    await launchWindowsSourceEntry(control.root, control.sourceRecoveryRelay);
    expectedProtocol = control.initialHost?.relay?.protocol ?? control.expectedProtocol;
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
    expectedRuntimeTarget: control.runtimeConfiguration?.originalRuntime ??
      control.sourceRecoveryMode,
    ownerCheck,
    ownerFailure,
  });
  const restoredInstallation = rollbackAction === "restore-backup"
    ? await restoreAndVerifyWindowsInstallation(control)
    : null;
  return publicHostEvidence(host, {
    installedVersion: restoredInstallation?.installedVersion ??
      await readInstalledVersion(control.installedApp),
    rollbackAction,
    recoveryEntry,
  });
}

async function restoreAndVerifyWindowsInstallation(control) {
  const version = control.initialHost.installedVersion;
  await restoreWindowsInstallRegistry(version, control.installedApp);
  return verifyWindowsInstallation(control.installedApp, { projectVersion: version });
}

export function selectWindowsRecoveryEntry(initialHost) {
  const entry = initialHost?.recoveryEntry;
  if (!["current-source", "installed-package"].includes(entry)) {
    throw new Error("生命周期控制文件没有记录测试前的启动入口，拒绝猜测恢复方式");
  }
  return entry;
}

export function selectWindowsRuntimeRestoreEntry({ candidateInstalled, initialEntry } = {}) {
  if (candidateInstalled) return "candidate-package";
  if (!["current-source", "installed-package"].includes(initialEntry)) {
    throw new Error("无法确认运行方式恢复后应使用的启动入口");
  }
  return initialEntry;
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

export async function waitForWindowsInjectorOwnersExit(expectedPids, {
  findPids = findInjectorListenerPids,
  timeoutMs = 5_000,
  pollIntervalMs = 100,
  wait = delay,
} = {}) {
  const expected = [...new Set((expectedPids ?? [])
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (expected.length === 0) throw new Error("Codex 关闭前没有可跟踪的注入器 PID");
  const expectedSet = new Set(expected);
  const deadline = Date.now() + timeoutMs;
  let remaining = expected;
  while (Date.now() < deadline) {
    remaining = (await findPids()).filter((pid) => expectedSet.has(pid));
    if (remaining.length === 0) {
      return { status: "exited", previousInjectorPids: expected };
    }
    await wait(pollIntervalMs);
  }
  throw new Error(`Codex 已关闭，但旧注入器仍占用单实例监听：PID ${remaining.join(", ")}`);
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
  recovery = false,
} = {}) {
  const modeArgument = recovery ? " --recover" : "";
  const argument = `${quoteWindowsArgument(supervisorScript)}${modeArgument} --control ${quoteWindowsArgument(controlPath)}`;
  return `
$ErrorActionPreference='Stop';
$user=([System.Security.Principal.WindowsIdentity]::GetCurrent().Name);
$action=New-ScheduledTaskAction -Execute '${powershellQuote(nodeExecutable)}' -Argument '${powershellQuote(argument)}' -WorkingDirectory '${powershellQuote(workingDirectory)}';
$principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited;
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $user;
$settings=New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Hours 1);
Register-ScheduledTask -TaskName '${powershellQuote(taskName)}' -Action $action -Principal $principal -Trigger $trigger -Settings $settings -Force | Out-Null;
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

export async function assertStableWindowsHost(control, baseline, durationMs, runtimeTarget = null, {
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

export async function waitForSettledWindowsHost(control, initialHost, {
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
    appServerPids: host.appServerPids,
    injectorPids: host.injectorPids,
    relayPid: host.relay.pid,
    relayProtocol: host.relay.protocol,
    runtimeTarget: hostRuntimeTarget(host),
    relayMode: host.relay.wslNative ? "WSL 原生 Relay" : "Windows 原生 Relay",
    debugReady: host.readiness.debugReady,
    generationMatches: host.relay.generationMatches,
    ...extra,
  };
}

function hostRuntimeTarget(host) {
  return host?.relay?.wslNative ? WSL_NATIVE : WINDOWS_NATIVE;
}

function runtimeModeMatches(host, runtimeTarget) {
  return hostRuntimeTarget(host) === runtimeTarget;
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

async function writePrivateText(path, contents) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function hashBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseConfigRuntime(contents) {
  return parseWindowsSubsystemSetting(contents) ? WSL_NATIVE : WINDOWS_NATIVE;
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
