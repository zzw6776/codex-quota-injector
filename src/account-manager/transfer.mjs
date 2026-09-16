import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { TRANSFER_KIND, TRANSFER_VERSION, TRANSFER_MODES, atomicWrite } from "./contract.mjs";
import { jwtExpiration, isPermanentRefreshError } from "./tokens.mjs";
import { writeOfficialCredentials, clearOfficialCredentials } from "./credentials.mjs";

function toTransferAccount(account, mode) {
  const common = {
    id: account.id,
    email: account.email,
    authMode: account.authMode,
  };
  if (account.authMode === "apiKey") {
    return { ...common, OPENAI_API_KEY: account.openaiApiKey };
  }
  const result = {
    ...common,
    tokens: {
      id_token: account.tokens.idToken,
      access_token: account.tokens.accessToken,
      account_id: account.accountId,
    },
  };
  if (mode === "handoff") result.tokens.refresh_token = account.tokens.refreshToken ?? "";
  if (mode === "temporary") {
    result.temporary_expires_at = jwtExpiration(account.tokens.accessToken);
  }
  return result;
}

function canExportAccount(account, mode) {
  if (!account || account.authStatus !== "active") return false;
  if (account.authMode === "apiKey") {
    return mode === "handoff" && Boolean(account.openaiApiKey);
  }
  return Boolean(account.tokens.accessToken && account.tokens.refreshToken);
}

async function transferAccounts({ mode, accountIds }, { store, codexHome, exportDirectory, syncOfficialKeychain, syncCurrentAccountFromOfficialCredentials, withAccountLock, refreshStoredTokens, ensureFreshTokens }) {
      if (!TRANSFER_MODES.has(mode)) throw new Error("请选择临时使用或完整转移");
      await syncCurrentAccountFromOfficialCredentials();
      const requestedIds = [...new Set(Array.isArray(accountIds) ? accountIds.map(String) : [])];
      const available = store.list();
      const selected = requestedIds.length > 0
        ? requestedIds.map((accountId) => {
            const account = store.get(accountId);
            if (!account) throw new Error(`账号不存在: ${accountId}`);
            return account;
          })
        : available.filter((account) => canExportAccount(account, mode));
      if (selected.length === 0) throw new Error("请至少选择一个可迁移账号");
      for (const account of selected) {
        if (!canExportAccount(account, mode)) {
          throw new Error(`${account.email} 当前不能用于${mode === "handoff" ? "完整转移" : "临时迁移"}`);
        }
      }

      for (const account of selected) {
        if (account.authMode !== "oauth") continue;
        let refreshed;
        try {
          refreshed = await withAccountLock(account.id, async () => {
            const latest = store.get(account.id);
            if (!canExportAccount(latest, mode)) throw new Error(`${account.email} 的凭据状态已变化，请重试`);
            return refreshStoredTokens(latest);
          });
        } catch (error) {
          if (isPermanentRefreshError(error)) {
            await store.update(account.id, {
              authStatus: "needsReauth",
              quotaError: `迁移前刷新失败，需要重新授权（${error.code ?? error.message}）`,
            });
          }
          throw error;
        }
        if (mode === "temporary" && refreshed.id === store.index.currentAccountId) {
          await writeOfficialCredentials(codexHome, refreshed, {
            syncKeychain: syncOfficialKeychain,
            strictKeychain: syncOfficialKeychain,
          });
        }
      }

      const refreshedAccounts = selected.map((account) => store.get(account.id));
      const exportedAt = new Date();
      const fileName = `codex-quota-${mode === "handoff" ? "handoff" : "temporary"}-${exportedAt.toISOString()
        .replace(/[:.]/g, "-")}.json`;
      const exportPath = join(exportDirectory, fileName);
      const payload = {
        version: TRANSFER_VERSION,
        kind: TRANSFER_KIND,
        mode,
        exportedAt: exportedAt.toISOString(),
        accounts: refreshedAccounts.map((account) => toTransferAccount(account, mode)),
      };

      let restartRequired = false;
      if (mode === "handoff") {
        const snapshots = refreshedAccounts.map((account) => structuredClone(account));
        const selectedIds = new Set(snapshots.map((account) => account.id));
        const currentId = store.index.currentAccountId;
        const currentSelected = currentId != null && selectedIds.has(currentId);
        let fallback = null;
        try {
          for (const account of snapshots) {
            await store.update(account.id, (latest) => ({
              authStatus: "transferred",
              transferredAt: exportedAt.getTime(),
              temporaryExpiresAt: null,
              quotaError: null,
              wakeup: { ...latest.wakeup, enabled: false },
            }));
          }
          if (currentSelected) {
            fallback = store.list().find((account) =>
              !selectedIds.has(account.id) && account.authStatus === "active" &&
              (account.authMode === "apiKey" ? account.openaiApiKey : account.tokens.refreshToken)
            ) ?? null;
            if (fallback?.authMode === "oauth") {
              fallback = await withAccountLock(fallback.id, async () =>
                ensureFreshTokens(store.get(fallback.id), {
                  refreshIfExpirationUnknown: true,
                }));
            }
            if (fallback) {
              if (fallback.authMode === "apiKey" && syncOfficialKeychain) {
                await clearOfficialCredentials(codexHome, { syncKeychain: true });
              }
              await writeOfficialCredentials(codexHome, fallback, {
                syncKeychain: syncOfficialKeychain,
                strictKeychain: syncOfficialKeychain,
              });
            } else {
              await clearOfficialCredentials(codexHome, {
                syncKeychain: syncOfficialKeychain,
              });
            }
            await store.setCurrent(fallback?.id ?? null);
            restartRequired = true;
          }
          await atomicWrite(exportPath, `${JSON.stringify(payload, null, 2)}\n`);
        } catch (error) {
          for (const snapshot of snapshots) {
            await store.upsert(snapshot).catch(() => undefined);
          }
          if (currentSelected) {
            const previousCurrent = snapshots.find((account) => account.id === currentId);
            if (previousCurrent) {
              await writeOfficialCredentials(codexHome, previousCurrent, {
                syncKeychain: syncOfficialKeychain,
                strictKeychain: syncOfficialKeychain,
              }).catch(() => undefined);
              await store.setCurrent(previousCurrent.id).catch(() => undefined);
            }
          }
          await unlink(exportPath).catch(() => undefined);
          throw error;
        }
      } else {
        await atomicWrite(exportPath, `${JSON.stringify(payload, null, 2)}\n`);
      }

      const label = mode === "handoff" ? "完整转移文件" : "临时迁移文件";
      return {
        message: `已生成 ${refreshedAccounts.length} 个账号的${label}：${exportPath}`,
        exportPath,
        mode,
        restartRequired,
      };
}

export { transferAccounts, canExportAccount };
