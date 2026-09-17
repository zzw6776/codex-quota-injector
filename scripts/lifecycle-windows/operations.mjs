import { bindLifecycleTask } from "../lifecycle-task-tools.mjs";
import { AccountManager } from "../../src/account-manager.mjs";
import { inspectLifecycleHost, lifecycleFingerprint, readJson } from "../../src/lifecycle-host.mjs";
import { waitForCodexTurnsIdle } from "../../src/lifecycle-turn-gate.mjs";
import { stopCodex } from "../../src/platform.mjs";
import { sendWakeupRequest } from "../../src/wakeup-client.mjs";
import { WINDOWS_NATIVE, WSL_NATIVE } from "../test-runtime-targets.mjs";
import { writePrivateJson } from "./io.mjs";
import { setWindowsRuntimeConfiguration, restoreWindowsRuntimeConfiguration, windowsRuntimeConfigurationMatches } from "./runtime-configuration.mjs";
import { verifyWindowsInstaller, installedWindowsCandidateEvidence } from "./packages.mjs";
import { safeguardWindowsDesktopHistory, prepareWindowsHistoryBeforeLaunch, waitForWindowsHistoryDurable } from "./history.mjs";
import { waitForWindowsTargetHost, launchWindowsApp, assertStableWindowsHost, waitForSettledWindowsHost } from "./host.mjs";
import { installWindowsPackage } from "./installation.mjs";
import { stopWindowsInjectorOwners, waitForWindowsInjectorOwnersExit, windowsInjectorOwnedByInstalledApp, terminateWindowsRelay } from "./process-ownership.mjs";
import { publicHostEvidence, hostRuntimeTarget, runtimeModeMatches, samePids } from "./evidence.mjs";

function createWindowsLifecycleOperations(controlPath, initialControl) {
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
    threadId: control.sessionCheckpoint ? bindLifecycleTask(control).threadId : null,
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
    const host = await restartThroughInstalledEntry(originalRuntimeTarget);
    await updateControl({ activeRuntimeTarget: control.runtimeConfiguration.originalRuntime,
      runtimeConfigurationRestored: true });
    return publicHostEvidence(host, { ...restored, entry: "candidate-package" });
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
      if (readyHost.taskToolsActivation) host.taskToolsActivation = readyHost.taskToolsActivation;
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
    },
    "install-update": {
      replaySafe: true,
      run: async () => {
        await waitForDesktopIdle();
        await stopWindowsInjectorOwners();
        await stopCodex();
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

export { createWindowsLifecycleOperations };
