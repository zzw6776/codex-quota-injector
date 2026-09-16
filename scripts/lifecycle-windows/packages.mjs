import { open, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { readInstalledVersion } from "../../src/lifecycle-host.mjs";
import { assertValidWslRelayExecutable } from "../../src/relay-artifact.mjs";
import { assertValidWindowsRelayExecutable } from "../../src/windows-artifact.mjs";
import { fileHash, pathExists } from "./io.mjs";

async function verifyWindowsInstaller(installerPath, { projectVersion } = {}) {
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

async function verifyWindowsInstallation(installDir, {
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

async function installedWindowsCandidateEvidence(control) {
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

export { verifyWindowsInstaller, verifyWindowsInstallation, installedWindowsCandidateEvidence };
