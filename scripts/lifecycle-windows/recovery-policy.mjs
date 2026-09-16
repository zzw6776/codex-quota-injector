function selectWindowsRecoveryEntry(initialHost) {
  const entry = initialHost?.recoveryEntry;
  if (!["current-source", "installed-package"].includes(entry)) {
    throw new Error("生命周期控制文件没有记录测试前的启动入口，拒绝猜测恢复方式");
  }
  return entry;
}

function selectWindowsRuntimeRestoreEntry({ candidateInstalled, initialEntry } = {}) {
  if (candidateInstalled) return "candidate-package";
  if (!["current-source", "installed-package"].includes(initialEntry)) {
    throw new Error("无法确认运行方式恢复后应使用的启动入口");
  }
  return initialEntry;
}

function selectWindowsInstallRollbackAction({
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

export { selectWindowsRecoveryEntry, selectWindowsRuntimeRestoreEntry, selectWindowsInstallRollbackAction };
