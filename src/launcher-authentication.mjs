async function recoverLauncherAuthentication(accountManager) {
  const refresh = accountManager.store.list().length > 0
    ? await accountManager.refreshAll({ recoverCurrentSession: true })
    : { authenticationRecovery: null };
  return {
    refresh,
    officialLoginRequired:
      refresh.authenticationRecovery?.kind === "login" ||
      accountManager.store.index.currentAccountId == null,
  };
}

export { recoverLauncherAuthentication };
