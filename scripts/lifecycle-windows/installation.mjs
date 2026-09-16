import { cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { readInstalledVersion } from "../../src/lifecycle-host.mjs";
import { waitForCodexTurnsIdle } from "../../src/lifecycle-turn-gate.mjs";
import { stopCodex } from "../../src/platform.mjs";
import { runCommand, pathExists, runPowerShell, powershellQuote } from "./io.mjs";
import { verifyWindowsInstaller, verifyWindowsInstallation, installedWindowsCandidateEvidence } from "./packages.mjs";
import { waitForWindowsTargetHost, launchWindowsApp, launchWindowsSourceEntry } from "./host.mjs";
import { selectWindowsRecoveryEntry, selectWindowsInstallRollbackAction } from "./recovery-policy.mjs";
import { stopWindowsInjectorOwners, windowsInjectorOwnedByInstalledApp, windowsInjectorOwnedBySource } from "./process-ownership.mjs";
import { publicHostEvidence } from "./evidence.mjs";

async function installWindowsPackage(control) {
  await verifyWindowsInstaller(control.installerPath, { projectVersion: control.projectVersion });
  const existing = await installedWindowsCandidateEvidence(control);
  if (existing && control.runtime?.installed === true) return existing;
  await runCommand(control.installerPath, ["/S"], { timeout: 180_000, windowsHide: false });
  return verifyWindowsInstallation(control.installedApp, {
    projectVersion: control.projectVersion,
  });
}

async function rollbackWindowsInstallation(control) {
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

export { installWindowsPackage, rollbackWindowsInstallation };
