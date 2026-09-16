import { runCommand } from "./io.mjs";
import { verifyWindowsInstaller, verifyWindowsInstallation, installedWindowsCandidateEvidence } from "./packages.mjs";

async function installWindowsPackage(control) {
  await verifyWindowsInstaller(control.installerPath, { projectVersion: control.projectVersion });
  const existing = await installedWindowsCandidateEvidence(control);
  if (existing && control.runtime?.installed === true) return existing;
  await runCommand(control.installerPath, ["/S"], { timeout: 180_000, windowsHide: false });
  return verifyWindowsInstallation(control.installedApp, {
    projectVersion: control.projectVersion,
  });
}

export { installWindowsPackage };
