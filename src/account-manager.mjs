import { createHash, randomBytes } from "node:crypto";
import { watch } from "node:fs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { AccountStore } from "./account-store.mjs";
import { CLIENT_ID, AUTH_ENDPOINT, OAUTH_CALLBACK_PORT, OAUTH_TIMEOUT_MS, SUBSCRIPTION_REFRESH_MS, OFFICIAL_SYNC_DEBOUNCE_MS, sha256, resolveCodexHome } from "./account-manager/contract.mjs";
import { fetchQuota, fetchSubscription, normalizeUsageWindow, parseAccountCheck } from "./account-manager/api.mjs";
import { refreshTokens, jwtExpiration, sameTokens, isPermanentRefreshError, createTemporaryTokenExpiredError, createOAuthCancelledError, ensureFreshTokens, refreshStoredTokens, decodeJwt } from "./account-manager/tokens.mjs";
import { exchangeAuthorizationCode, waitForOAuthCallback, listen, closeServer, openExternal, base64Url } from "./account-manager/oauth.mjs";
import { writeOfficialCredentials, matchOfficialAccount } from "./account-manager/credentials.mjs";
import { toPublicAccount, upsertOAuthTokens, upsertApiKey } from "./account-manager/accounts.mjs";
import { transferAccounts } from "./account-manager/transfer.mjs";
import { parseCredentialInput, parseTokenInput } from "./account-manager/credential-input.mjs";

export class AccountManager {
  constructor({ store = new AccountStore(), codexHome = resolveCodexHome(),
    oauth = {}, exportDirectory = join(homedir(), "Downloads"),
    syncOfficialKeychain = process.platform === "darwin" } = {}) {
    this.store = store;
    this.codexHome = codexHome;
    this.oauth = { callbackPort: OAUTH_CALLBACK_PORT, timeoutMs: OAUTH_TIMEOUT_MS, openExternal, ...oauth };
    this.exportDirectory = exportDirectory;
    this.syncOfficialKeychain = syncOfficialKeychain;
    this.operation = null;
    this.oauthPromise = null;
    this.oauthAbortController = null;
    this.refreshLocks = new Map();
    this.subscriptionRefreshAttempts = new Map();
    this.officialSyncPromise = null;
    this.officialCredentialWatcher = null;
    this.officialSyncTimer = null;
    this.operationClearTimer = null;
  }

  async initialize() {
    await this.store.initialize();
    await this.#importOfficialAccountIfStoreEmpty();
    await this.syncCurrentAccountFromOfficialCredentials();
    return this.getViewModel();
  }

  startOfficialCredentialWatch(onChange) {
    if (this.officialCredentialWatcher) return;
    try {
      this.officialCredentialWatcher = watch(
        this.codexHome,
        { persistent: false },
        (_eventType, fileName) => {
          if (fileName && String(fileName) !== "auth.json") return;
          clearTimeout(this.officialSyncTimer);
          this.officialSyncTimer = setTimeout(() => {
            this.officialSyncTimer = null;
            void this.syncCurrentAccountFromOfficialCredentials()
              .then((result) => {
                if (result?.changed) onChange?.(result);
              })
              .catch((error) => {
                console.error(`[accounts] Codex 凭证同步失败: ${error.message}`);
              });
          }, OFFICIAL_SYNC_DEBOUNCE_MS);
        },
      );
      this.officialCredentialWatcher.on("error", (error) => {
        console.error(`[accounts] Codex 凭证监听失败: ${error.message}`);
      });
    } catch (error) {
      console.error(`[accounts] 无法监听 Codex 凭证: ${error.message}`);
    }
  }

  close() {
    clearTimeout(this.officialSyncTimer);
    this.officialSyncTimer = null;
    clearTimeout(this.operationClearTimer);
    this.operationClearTimer = null;
    this.officialCredentialWatcher?.close();
    this.officialCredentialWatcher = null;
    this.oauthAbortController?.abort(createOAuthCancelledError());
  }

  async syncCurrentAccountFromOfficialCredentials() {
    const previous = this.officialSyncPromise ?? Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(() => this.#syncCurrentAccountFromOfficialCredentialsOnce());
    this.officialSyncPromise = task;
    try {
      return await task;
    } finally {
      if (this.officialSyncPromise === task) this.officialSyncPromise = null;
    }
  }

  getViewModel() {
    const accounts = this.store.list().map((account) => toPublicAccount(
      account,
      account.id === this.store.index.currentAccountId,
    ));
    const current = accounts.find((account) => account.current) ?? null;
    return {
      accounts,
      currentAccountId: current?.id ?? null,
      windows: current?.windows ?? [],
      credits: current?.credits ?? null,
      operation: this.operation,
    };
  }

  async getCurrentModelCatalogAccount() {
    await this.syncCurrentAccountFromOfficialCredentials();
    const accountId = this.store.index.currentAccountId;
    const account = accountId ? this.store.get(accountId) : null;
    if (["transferred", "needsReauth"].includes(account?.authStatus)) return null;
    if (account?.authMode === "apiKey" && account.openaiApiKey) return account;
    return account?.authMode === "oauth" && account.tokens?.accessToken ? account : null;
  }

  async refreshAll({ forceSubscription = false } = {}) {
    await this.syncCurrentAccountFromOfficialCredentials();
    const accounts = this.store.list().filter((account) =>
      account.authMode === "oauth" && account.authStatus !== "transferred"
    );
    const results = await Promise.allSettled(
      accounts.map((account) => this.refreshAccount(account.id, { forceSubscription })),
    );
    return { viewModel: this.getViewModel(), results };
  }

  async refreshAllWithOperation() {
    return this.#withOperation("正在刷新全部账号…", async () => {
      const { results } = await this.refreshAll({ forceSubscription: true });
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length > 0) {
        const messages = [...new Set(failures
          .map((result) => result.reason?.message)
          .filter(Boolean))];
        throw new Error(
          `${failures.length} 个账号刷新失败${messages.length > 0 ? `：${messages.join("；")}` : ""}`,
        );
      }
      return "全部账号已刷新";
    });
  }

  async refreshAccount(accountId, { forceSubscription = false } = {}) {
    return this.#withAccountLock(
      accountId,
      () => this.#refreshAccountOnce(accountId, { forceSubscription }),
    );
  }

  async withWakeupAccount(accountId, callback) {
    await this.syncCurrentAccountFromOfficialCredentials();
    return this.#withAccountLock(accountId, async () => {
      let previousAccessToken = null;
      const getCredentials = async ({ forceRefresh = false } = {}) => {
        await this.syncCurrentAccountFromOfficialCredentials();
        let account = this.store.get(accountId);
        if (!account || account.authMode !== "oauth") throw new Error("仅支持已保存的 OAuth 账号");
        if (account.authStatus !== "active") {
          throw new Error(account.authStatus === "transferred"
            ? "账号已转出，请先恢复"
            : "登录凭据不可用于账号唤醒，请重新授权");
        }
        try {
          if (account.id === this.store.index.currentAccountId) {
            const expiration = jwtExpiration(account.tokens.accessToken);
            if ((forceRefresh && account.tokens.accessToken === previousAccessToken) ||
              (expiration != null && expiration <= Math.floor(Date.now() / 1000))) {
              throw new Error("当前账号凭据由 Codex 管理，请在客户端完成续期后重试");
            }
          } else {
            account = forceRefresh
              ? await this.#refreshStoredTokens(account)
              : await this.#ensureFreshTokens(account, { refreshIfExpirationUnknown: true });
          }
        } catch (error) {
          if (isPermanentRefreshError(error)) {
            await this.store.update(accountId, {
              authStatus: "needsReauth",
              quotaError: "登录凭据已失效，请重新授权",
            });
          }
          throw error;
        }
        if (!account.tokens.accessToken || !account.accountId) {
          throw new Error("账号缺少 Access Token 或 Account ID，请重新导入或授权");
        }
        previousAccessToken = account.tokens.accessToken;
        return {
          accessToken: account.tokens.accessToken,
          chatgptAccountId: account.accountId,
          chatgptPlanType: account.planType,
        };
      };
      return callback(getCredentials);
    });
  }

  async #withAccountLock(accountId, callback) {
    const previous = this.refreshLocks.get(accountId) ?? Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(callback);
    this.refreshLocks.set(accountId, task);
    try {
      return await task;
    } finally {
      if (this.refreshLocks.get(accountId) === task) this.refreshLocks.delete(accountId);
    }
  }

  beginOAuthLogin() {
    if (this.oauthPromise) throw new Error("已有 OAuth 添加流程正在进行");
    this.oauthPromise = this.#runOAuthLogin()
      .catch((error) => {
        if (error?.code === "CODEX_QUOTA_OAUTH_CANCELLED") {
          this.#setOperation("success", "已取消 OpenAI OAuth 授权");
          this.clearOperationAfter();
        } else {
          this.#setOperation("error", `添加失败：${error.message}`);
          this.clearOperationAfter(8_000);
        }
      })
      .finally(() => {
        this.oauthPromise = null;
      });
  }

  cancelOAuthLogin() {
    if (!this.oauthAbortController) return false;
    this.oauthAbortController.abort(createOAuthCancelledError());
    return true;
  }

  async importTokenInput(input) {
    return this.#withOperation("正在导入 Token…", async () => {
      const { tokens: candidates, apiKeys, transfer } = parseCredentialInput(input);
      if (candidates.length === 0 && apiKeys.length === 0) {
        throw new Error("没有识别到可导入的账号凭据");
      }
      if (transfer?.mode === "temporary" && apiKeys.length > 0) {
        throw new Error("临时迁移不支持 API Key");
      }
      const imported = [];
      for (const candidate of candidates) {
        let tokens = candidate;
        let options = {};
        if (transfer?.mode === "handoff") {
          if (!candidate.refreshToken) throw new Error("完整转移凭据缺少 refresh token");
          tokens = {
            ...candidate,
            ...await refreshTokens(candidate.refreshToken, candidate.idToken),
          };
        } else if (transfer?.mode === "temporary") {
          if (candidate.refreshToken) throw new Error("临时迁移文件不能包含 refresh token");
          const temporaryExpiresAt = candidate.temporaryExpiresAt ??
            jwtExpiration(candidate.accessToken);
          if (!temporaryExpiresAt || temporaryExpiresAt <= Math.floor(Date.now() / 1000)) {
            throw new Error("临时迁移凭据已经过期");
          }
          options = { authStatus: "temporary", temporaryExpiresAt };
        } else if (candidate.refreshToken && !candidate.accessToken) {
          tokens = {
            ...candidate,
            ...await refreshTokens(candidate.refreshToken, candidate.idToken),
          };
        }
        imported.push(await this.#upsertOAuthTokens(tokens, null, options));
      }
      for (const candidate of apiKeys) {
        imported.push(await this.#upsertApiKey(candidate.apiKey, candidate.name));
      }
      await Promise.allSettled(imported.map((account) => this.refreshAccount(account.id, {
        forceSubscription: true,
      })));
      if (transfer?.mode === "handoff") return `已接收 ${imported.length} 个完整转移账号`;
      if (transfer?.mode === "temporary") return `已导入 ${imported.length} 个临时账号`;
      return `已导入 ${imported.length} 个账号`;
    });
  }

  async exportAccounts({ mode, accountIds } = {}) {
    const operationText = mode === "handoff" ? "正在完整转移账号…" : "正在生成临时迁移…";
    return this.#withOperation(operationText, () => transferAccounts({ mode, accountIds }, {
      store: this.store,
      codexHome: this.codexHome,
      exportDirectory: this.exportDirectory,
      syncOfficialKeychain: this.syncOfficialKeychain,
      syncCurrentAccountFromOfficialCredentials: () => this.syncCurrentAccountFromOfficialCredentials(),
      withAccountLock: (id, callback) => this.#withAccountLock(id, callback),
      refreshStoredTokens: account => this.#refreshStoredTokens(account),
      ensureFreshTokens: (account, options) => this.#ensureFreshTokens(account, options),
    }));
  }

  async restoreTransferredAccount(accountId) {
    return this.#withOperation("正在验证并恢复已转出账号…", async () => {
      const account = this.store.get(accountId);
      if (!account) throw new Error("目标账号不存在，请刷新列表");
      if (account.authStatus !== "transferred") throw new Error("该账号不是已转出状态");
      if (account.authMode === "apiKey") {
        await this.store.update(account.id, {
          authStatus: "active",
          transferredAt: null,
          quotaError: null,
        });
        return `已恢复 ${account.email}`;
      }
      if (!account.tokens.refreshToken) {
        await this.store.update(account.id, {
          authStatus: "needsReauth",
          transferredAt: null,
          quotaError: "恢复失败，缺少 refresh token，需要重新授权",
        });
        throw new Error("恢复失败，缺少 refresh token，需要重新授权");
      }
      try {
        const tokens = await refreshTokens(account.tokens.refreshToken, account.tokens.idToken);
        await this.store.update(account.id, (latest) => ({
          tokens,
          authStatus: "active",
          transferredAt: null,
          temporaryExpiresAt: null,
          quotaError: null,
          tokenGeneration: (latest.tokenGeneration ?? 0) + 1,
        }));
      } catch (error) {
        if (isPermanentRefreshError(error)) {
          await this.store.update(account.id, {
            authStatus: "needsReauth",
            transferredAt: null,
            quotaError: `恢复失败，需要重新授权（${error.code ?? error.message}）`,
          });
        }
        throw error;
      }
      await this.refreshAccount(account.id, { forceSubscription: true }).catch(() => undefined);
      return `已验证并恢复 ${account.email}`;
    });
  }

  async importLocalAccount() {
    return this.#withOperation("正在读取本机 Codex 登录…", async () => {
      const raw = JSON.parse(await readFile(join(this.codexHome, "auth.json"), "utf8"));
      if (typeof raw.OPENAI_API_KEY === "string" && raw.OPENAI_API_KEY.trim()) {
        await this.addApiKey(raw.OPENAI_API_KEY, "Local API Key");
        return "已导入本机 API Key";
      }
      const candidates = parseTokenInput(JSON.stringify(raw));
      if (candidates.length === 0) throw new Error("本机 auth.json 中没有可导入凭据");
      const candidate = candidates[0];
      const tokens = candidate.refreshToken && !candidate.accessToken
        ? { ...candidate, ...await refreshTokens(candidate.refreshToken, candidate.idToken) }
        : candidate;
      const account = await this.#upsertOAuthTokens(tokens);
      await this.refreshAccount(account.id, { forceSubscription: true });
      return "已导入本机账号";
    });
  }

  async addApiKey(apiKey, accountName = "API Key") {
    return this.#withOperation("正在添加 API Key…", async () => {
      await this.#upsertApiKey(apiKey, accountName);
      return "API Key 已添加";
    });
  }

  async switchAccount(accountId) {
    return this.#withOperation("正在切换账号…", async () => {
      await this.syncCurrentAccountFromOfficialCredentials();
      if (accountId === this.store.index.currentAccountId) {
        const current = this.store.get(accountId);
        if (!current) throw new Error("当前账号不存在，请刷新列表");
        return `${current.email} 已是当前账号`;
      }

      let account = this.store.get(accountId);
      if (!account) throw new Error("目标账号不存在，请刷新列表");
      try {
        account = await this.#withAccountLock(account.id, async () => {
          const latest = this.store.get(account.id);
          if (!latest) throw new Error("目标账号不存在，请刷新列表");
          if (latest.authStatus === "transferred") {
            throw new Error(`${latest.email} 已转出，请先点击“已转出”恢复`);
          }
          if (latest.authStatus === "needsReauth") {
            throw new Error(`${latest.email} 的登录凭证已失效，需要重新授权后才能切换`);
          }
          return latest.authMode === "oauth"
            ? await this.#ensureFreshTokens(latest, { refreshIfExpirationUnknown: true })
            : latest;
        });
      } catch (error) {
        if (isPermanentRefreshError(error)) {
          await this.store.update(account.id, {
            authStatus: "needsReauth",
            quotaError: `登录凭证已失效，需要重新授权（${error.code ?? error.message}）`,
          });
        }
        throw error;
      }
      await writeOfficialCredentials(this.codexHome, account, {
        syncKeychain: this.syncOfficialKeychain,
      });
      await this.store.setCurrent(account.id);
      return `已切换到 ${account.email}`;
    });
  }

  async removeAccount(accountId) {
    return this.#withOperation("正在移除账号…", async () => {
      await this.syncCurrentAccountFromOfficialCredentials();
      const account = this.store.get(accountId);
      if (!account) throw new Error("目标账号不存在，请刷新列表");
      if (accountId === this.store.index.currentAccountId) {
        throw new Error("当前账号不能移除，请先切换到其他账号");
      }
      await this.#withAccountLock(accountId, () => this.store.remove(accountId));
      this.subscriptionRefreshAttempts.delete(accountId);
      return `已移除 ${account.email}`;
    });
  }

  clearOperationAfter(ms = 4_000) {
    const current = this.operation;
    if (!current) return;
    clearTimeout(this.operationClearTimer);
    this.operationClearTimer = setTimeout(() => {
      this.operationClearTimer = null;
      if (this.operation === current) this.operation = null;
    }, ms);
  }

  async #refreshAccountOnce(accountId, { forceSubscription }) {
    let account = this.store.get(accountId);
    if (!account) throw new Error(`账号不存在: ${accountId}`);
    if (account.authStatus === "transferred") {
      throw new Error(`${account.email} 已转出，本机不会刷新该账号`);
    }
    if (account.authMode !== "oauth" || !account.tokens.accessToken) return account;
    let isCurrent = account.id === this.store.index.currentAccountId;

    try {
      if (isCurrent) {
        await this.syncCurrentAccountFromOfficialCredentials();
        account = this.store.get(accountId) ?? account;
        isCurrent = account.id === this.store.index.currentAccountId;
      }
      if (!isCurrent && account.authStatus === "needsReauth") {
        throw new Error(`${account.email} 的登录凭证已失效，需要重新授权`);
      }
      if (!isCurrent) account = await this.#ensureFreshTokens(account);

      let quota;
      try {
        quota = await fetchQuota(account);
      } catch (error) {
        if (error?.status !== 401) throw error;
        if (account.authStatus === "temporary") throw createTemporaryTokenExpiredError(account);
        if (!isCurrent) {
          account = await this.#refreshStoredTokens(account);
          quota = await fetchQuota(account);
        } else {
          const previousAccessToken = account.tokens.accessToken;
          await this.syncCurrentAccountFromOfficialCredentials();
          const synced = this.store.get(accountId);
          if (!synced || synced.tokens.accessToken === previousAccessToken) {
            throw new Error(`${account.email} 的 Codex 登录尚未完成 Token 续期`);
          }
          account = synced;
          quota = await fetchQuota(account);
        }
      }
      const updates = {
        quota,
        quotaUpdatedAt: Math.floor(Date.now() / 1000),
        quotaError: null,
        authStatus: account.authStatus === "temporary" ? "temporary" : "active",
      };
      if (quota.planType) updates.planType = quota.planType;

      const subscriptionAttemptedAt = Math.max(
        account.subscriptionUpdatedAt ? account.subscriptionUpdatedAt * 1000 : 0,
        this.subscriptionRefreshAttempts.get(account.id) ?? 0,
      );
      const subscriptionStale =
        !subscriptionAttemptedAt || Date.now() - subscriptionAttemptedAt > SUBSCRIPTION_REFRESH_MS;
      if (forceSubscription || subscriptionStale) {
        const attemptedAt = Date.now();
        this.subscriptionRefreshAttempts.set(account.id, attemptedAt);
        try {
          const subscription = await fetchSubscription(account);
          if (subscription.accountId) updates.accountId = subscription.accountId;
          if (subscription.planType) updates.planType = subscription.planType;
          if (subscription.subscriptionActiveUntil) {
            updates.subscriptionActiveUntil = subscription.subscriptionActiveUntil;
          }
          updates.subscriptionUpdatedAt = Math.floor(attemptedAt / 1000);
        } catch (error) {
          console.error(`[subscription] ${account.email}: ${error.message}`);
        }
      }
      return await this.store.update(accountId, updates);
    } catch (error) {
      const updates = {};
      if ((!isCurrent || account.authStatus === "temporary") && isPermanentRefreshError(error)) {
        updates.authStatus = "needsReauth";
        updates.quotaError = `登录凭证已失效，需要重新授权（${error.code ?? error.message}）`;
      } else {
        updates.quotaError = error.message;
      }
      await this.store.update(accountId, updates);
      throw error;
    }
  }

  async #ensureFreshTokens(account, options = {}) {
    return ensureFreshTokens(this.store, account, options);
  }

  async #refreshStoredTokens(account) {
    return refreshStoredTokens(this.store, account);
  }

  async #importOfficialAccountIfStoreEmpty() {
    if (this.store.list().length > 0) return;

    let credentials;
    try {
      credentials = JSON.parse(await readFile(join(this.codexHome, "auth.json"), "utf8"));
    } catch {
      return;
    }

    try {
      const apiKey = typeof credentials.OPENAI_API_KEY === "string"
        ? credentials.OPENAI_API_KEY.trim()
        : "";
      let account;
      if (apiKey) {
        account = await this.store.upsert({
          id: `apikey_${sha256(apiKey).slice(0, 32)}`,
          email: "Local API Key",
          authMode: "apiKey",
          openaiApiKey: apiKey,
          planType: "API_KEY",
          tokens: {},
        });
      } else {
        const candidates = parseTokenInput(JSON.stringify(credentials));
        if (candidates.length === 0) return;
        const candidate = candidates[0];
        const tokens = candidate.refreshToken && !candidate.accessToken
          ? { ...candidate, ...await refreshTokens(candidate.refreshToken, candidate.idToken) }
          : candidate;
        account = await this.#upsertOAuthTokens(tokens);
      }

      await this.store.setCurrent(account.id);
      console.log(`[accounts] 已从 Codex 当前登录导入账号: ${account.email}`);
    } catch (error) {
      console.error(`[accounts] Codex 当前登录导入失败: ${error.message}`);
    }
  }

  async #syncCurrentAccountFromOfficialCredentialsOnce() {
    let credentials;
    try {
      credentials = JSON.parse(await readFile(join(this.codexHome, "auth.json"), "utf8"));
    } catch {
      return { changed: false, account: null };
    }

    const accounts = this.store.list();
    const matched = matchOfficialAccount(credentials, accounts);
    if (matched === undefined) return { changed: false, account: null };

    let account = matched;
    let credentialsChanged = false;
    const apiKey = typeof credentials.OPENAI_API_KEY === "string"
      ? credentials.OPENAI_API_KEY.trim()
      : "";
    const candidate = apiKey ? null : parseTokenInput(JSON.stringify(credentials))[0];
    if (account?.authStatus === "transferred") {
      const stillUsingTransferredCredentials = apiKey
        ? account.openaiApiKey === apiKey
        : candidate?.accessToken && sameTokens(account.tokens, candidate);
      if (stillUsingTransferredCredentials) {
        const currentChanged = this.store.index.currentAccountId === account.id;
        if (currentChanged) await this.store.setCurrent(null);
        return { changed: currentChanged, account: null };
      }
    }
    if (apiKey) {
      if (!account) {
        account = await this.#upsertApiKey(apiKey, "Local API Key");
        credentialsChanged = true;
      }
    } else {
      if (candidate?.accessToken) {
        if (!account && candidate.accountId) {
          const current = this.store.get(this.store.index.currentAccountId);
          // Follow an explicit workspace selection without duplicating the current
          // session's refresh token under a second stored account.
          if (current?.authMode === "oauth" && sameTokens(current.tokens, candidate)) {
            account = current;
          }
        }
        const nextTokens = {
          idToken: candidate.idToken || account?.tokens.idToken || "",
          accessToken: candidate.accessToken,
          refreshToken: candidate.refreshToken ?? account?.tokens.refreshToken ?? null,
          accountId: candidate.accountId,
        };
        if (
          !account ||
          !sameTokens(account.tokens, nextTokens) ||
          (candidate.accountId && candidate.accountId !== account.accountId) ||
          ["needsReauth", "transferred"].includes(account.authStatus) ||
          (account.authStatus === "temporary" && candidate.refreshToken)
        ) {
          account = await this.#upsertOAuthTokens(nextTokens, account);
          credentialsChanged = true;
        }
      }
    }

    const currentAccountId = account?.id ?? null;
    const currentChanged = currentAccountId !== this.store.index.currentAccountId;
    if (currentChanged) await this.store.setCurrent(currentAccountId);
    if (credentialsChanged || currentChanged) {
      console.log(
        account
          ? `[accounts] 已同步 Codex 当前账号凭证: ${account.email}`
          : "[accounts] Codex 当前登录未在账号库中，已清除当前账号标记",
      );
    }
    return { changed: credentialsChanged || currentChanged, account };
  }

  async #upsertOAuthTokens(tokens, existingAccount = null, options = {}) {
    return upsertOAuthTokens(this.store, tokens, existingAccount, options);
  }

  async #upsertApiKey(apiKey, accountName = "API Key") {
    return upsertApiKey(this.store, apiKey, accountName);
  }

  async #runOAuthLogin() {
    this.#setOperation("loading", "正在准备 OpenAI OAuth…", { cancellable: "oauth" });
    const abortController = new AbortController();
    this.oauthAbortController = abortController;
    const verifier = base64Url(randomBytes(32));
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    const expectedState = base64Url(randomBytes(32));
    const server = createServer();
    try {
      try {
        await listen(server, this.oauth.callbackPort);
      } catch (error) {
        if (error?.code === "EADDRINUSE") {
          throw new Error(`OAuth 回调端口 ${this.oauth.callbackPort} 已被占用，请关闭旧授权流程后重试`);
        }
        throw error;
      }
      abortController.signal.throwIfAborted();
      const redirectUri = `http://localhost:${server.address().port}/auth/callback`;
      const authUrl = new URL(AUTH_ENDPOINT);
      authUrl.search = new URLSearchParams({
        response_type: "code",
        client_id: CLIENT_ID,
        redirect_uri: redirectUri,
        scope: "openid profile email offline_access api.connectors.read api.connectors.invoke",
        code_challenge: challenge,
        code_challenge_method: "S256",
        id_token_add_organizations: "true",
        codex_cli_simplified_flow: "true",
        state: expectedState,
        originator: "codex_vscode",
      }).toString();

      const callback = waitForOAuthCallback(
        server,
        expectedState,
        this.oauth.timeoutMs,
        abortController.signal,
      );
      this.#setOperation(
        "loading",
        "请在浏览器中完成 OpenAI 授权…",
        { cancellable: "oauth" },
      );
      this.oauth.openExternal(authUrl.toString());
      const code = await callback;
      this.#setOperation("loading", "授权完成，正在保存账号…");
      const tokens = await exchangeAuthorizationCode(code, verifier, redirectUri, abortController.signal);
      abortController.signal.throwIfAborted();
      const account = await this.#upsertOAuthTokens(tokens);
      await this.refreshAccount(account.id, { forceSubscription: true });
      this.#setOperation("success", `已添加 ${account.email}`);
      this.clearOperationAfter();
    } finally {
      if (this.oauthAbortController === abortController) {
        this.oauthAbortController = null;
      }
      await closeServer(server);
    }
  }

  async #withOperation(message, callback) {
    this.#setOperation("loading", message);
    try {
      const result = await callback();
      const resultMessage = typeof result === "string" ? result : result?.message;
      this.#setOperation("success", resultMessage || "操作已完成");
      this.clearOperationAfter();
      return result;
    } catch (error) {
      this.#setOperation("error", error.message);
      this.clearOperationAfter(8_000);
      throw error;
    }
  }

  #setOperation(state, message, extra = {}) {
    this.operation = { state, message, updatedAt: Date.now(), ...extra };
  }
}

export { decodeJwt, normalizeUsageWindow, parseAccountCheck, parseTokenInput };

export { fetchQuota, fetchSubscription } from "./account-manager/api.mjs";

export { refreshTokens } from "./account-manager/tokens.mjs";

export { writeOfficialCredentials, clearOfficialCredentials } from "./account-manager/credentials.mjs";
