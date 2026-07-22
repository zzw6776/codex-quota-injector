import { createHash, randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { AccountStore } from "./account-store.mjs";

const execFileAsync = promisify(execFile);
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_ENDPOINT = "https://auth.openai.com/oauth/authorize";
const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const ACCOUNT_CHECK_URL = "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27";
const SUBSCRIPTIONS_URL = "https://chatgpt.com/backend-api/subscriptions";
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const SUBSCRIPTION_REFRESH_MS = 12 * 60 * 60 * 1000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

export class AccountManager {
  constructor({ store = new AccountStore(), codexHome = resolveCodexHome() } = {}) {
    this.store = store;
    this.codexHome = codexHome;
    this.operation = null;
    this.oauthPromise = null;
    this.refreshLocks = new Map();
  }

  async initialize() {
    await this.store.initialize();
    await this.#importOfficialAccountIfStoreEmpty();
    await this.#syncCurrentAccountFromOfficialCredentials();
    return this.getViewModel();
  }

  getViewModel({ fallbackQuota = null } = {}) {
    const accounts = this.store.list().map((account) => toPublicAccount(
      account,
      account.id === this.store.index.currentAccountId,
    ));
    const current = accounts.find((account) => account.current) ?? null;
    return {
      accounts,
      currentAccountId: current?.id ?? null,
      windows: current?.windows?.length ? current.windows : fallbackQuota?.windows ?? [],
      operation: this.operation,
    };
  }

  async refreshAll({ forceSubscription = false } = {}) {
    const accounts = this.store.list().filter((account) => account.authMode === "oauth");
    await Promise.allSettled(
      accounts.map((account) => this.refreshAccount(account.id, { forceSubscription })),
    );
    return this.getViewModel();
  }

  async refreshAllWithOperation() {
    return this.#withOperation("正在刷新全部账号…", async () => {
      await this.refreshAll({ forceSubscription: true });
      return "全部账号已刷新";
    });
  }

  async refreshAccount(accountId, { forceSubscription = false } = {}) {
    const previous = this.refreshLocks.get(accountId) ?? Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(() => this.#refreshAccountOnce(accountId, { forceSubscription }));
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
        this.#setOperation("error", `添加失败：${error.message}`);
        this.clearOperationAfter(8_000);
      })
      .finally(() => {
        this.oauthPromise = null;
      });
  }

  async importTokenInput(input) {
    return this.#withOperation("正在导入 Token…", async () => {
      const { tokens: candidates, apiKeys } = parseCredentialInput(input);
      if (candidates.length === 0 && apiKeys.length === 0) {
        throw new Error("没有识别到可导入的账号凭据");
      }
      const imported = [];
      for (const candidate of candidates) {
        const tokens = candidate.refreshToken && !candidate.accessToken
          ? await refreshTokens(candidate.refreshToken, candidate.idToken)
          : candidate;
        imported.push(await this.#upsertOAuthTokens(tokens));
      }
      for (const candidate of apiKeys) {
        imported.push(await this.#upsertApiKey(candidate.apiKey, candidate.name));
      }
      await Promise.allSettled(imported.map((account) => this.refreshAccount(account.id, {
        forceSubscription: true,
      })));
      return `已导入 ${imported.length} 个账号`;
    });
  }

  async exportAccounts() {
    return this.#withOperation("正在导出全部账号…", async () => {
      const accounts = this.store.list();
      if (accounts.length === 0) throw new Error("暂无可导出的账号");
      const exportedAt = new Date();
      const fileName = `codex-quota-accounts-${exportedAt.toISOString()
        .replace(/[:.]/g, "-")}.json`;
      const exportPath = join(homedir(), "Downloads", fileName);
      const payload = {
        version: 1,
        exportedAt: exportedAt.toISOString(),
        currentAccountId: this.store.index.currentAccountId,
        accounts: accounts.map(toExportAccount),
      };
      await atomicWrite(exportPath, `${JSON.stringify(payload, null, 2)}\n`);
      return `已导出 ${accounts.length} 个账号到 ${exportPath}`;
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
      const tokens = candidates[0].refreshToken && !candidates[0].accessToken
        ? await refreshTokens(candidates[0].refreshToken, candidates[0].idToken)
        : candidates[0];
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
      let account = this.store.get(accountId);
      if (!account) throw new Error("目标账号不存在，请刷新列表");
      if (account.authMode === "oauth") {
        account = await this.#ensureFreshTokens(account);
      }
      await writeOfficialCredentials(this.codexHome, account);
      await this.store.setCurrent(account.id);
      return `已切换到 ${account.email}`;
    });
  }

  clearOperationAfter(ms = 4_000) {
    const current = this.operation;
    if (!current) return;
    setTimeout(() => {
      if (this.operation === current) this.operation = null;
    }, ms);
  }

  async #refreshAccountOnce(accountId, { forceSubscription }) {
    let account = this.store.get(accountId);
    if (!account) throw new Error(`账号不存在: ${accountId}`);
    if (account.authMode !== "oauth" || !account.tokens.accessToken) return account;

    account = await this.#ensureFreshTokens(account);
    try {
      const quota = await fetchQuota(account);
      account.quota = quota;
      account.quotaUpdatedAt = Math.floor(Date.now() / 1000);
      account.quotaError = null;
      if (quota.planType) account.planType = quota.planType;

      const subscriptionStale =
        !account.subscriptionUpdatedAt ||
        Date.now() - account.subscriptionUpdatedAt * 1000 > SUBSCRIPTION_REFRESH_MS;
      if (forceSubscription || !account.subscriptionActiveUntil || subscriptionStale) {
        try {
          const subscription = await fetchSubscription(account);
          if (subscription.accountId) account.accountId = subscription.accountId;
          if (subscription.planType) account.planType = subscription.planType;
          if (subscription.subscriptionActiveUntil) {
            account.subscriptionActiveUntil = subscription.subscriptionActiveUntil;
          }
          account.subscriptionUpdatedAt = Math.floor(Date.now() / 1000);
        } catch (error) {
          console.error(`[subscription] ${account.email}: ${error.message}`);
        }
      }
      return await this.store.upsert(account);
    } catch (error) {
      account.quotaError = error.message;
      await this.store.upsert(account);
      throw error;
    }
  }

  async #ensureFreshTokens(account) {
    const expiration = jwtExpiration(account.tokens.accessToken);
    if (expiration == null || expiration > Math.floor(Date.now() / 1000) + 300) {
      return account;
    }
    if (!account.tokens.refreshToken) {
      throw new Error(`${account.email} 的登录已过期，需要重新添加或授权`);
    }
    const tokens = await refreshTokens(account.tokens.refreshToken, account.tokens.idToken);
    account.tokens = tokens;
    account.tokenGeneration = (account.tokenGeneration ?? 0) + 1;
    return this.store.upsert(account);
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
          ? await refreshTokens(candidate.refreshToken, candidate.idToken)
          : candidate;
        account = await this.#upsertOAuthTokens(tokens);
      }

      await this.store.setCurrent(account.id);
      console.log(`[accounts] 已从 Codex 当前登录导入账号: ${account.email}`);
    } catch (error) {
      console.error(`[accounts] Codex 当前登录导入失败: ${error.message}`);
    }
  }

  async #syncCurrentAccountFromOfficialCredentials() {
    let credentials;
    try {
      credentials = JSON.parse(await readFile(join(this.codexHome, "auth.json"), "utf8"));
    } catch {
      return;
    }

    const accounts = this.store.list();
    const matched = matchOfficialAccount(credentials, accounts);
    if (matched === undefined) return;
    const currentAccountId = matched?.id ?? null;
    if (currentAccountId === this.store.index.currentAccountId) return;

    await this.store.setCurrent(currentAccountId);
    console.log(
      matched
        ? `[accounts] 已识别 Codex 当前账号: ${matched.email}`
        : "[accounts] Codex 当前登录未在账号库中，已清除当前账号标记",
    );
  }

  async #upsertOAuthTokens(tokens) {
    if (!tokens.accessToken) throw new Error("OAuth 凭据缺少 access_token");
    const idClaims = decodeJwt(tokens.idToken) ?? {};
    const accessClaims = decodeJwt(tokens.accessToken) ?? {};
    const auth = idClaims["https://api.openai.com/auth"] ??
      accessClaims["https://api.openai.com/auth"] ?? {};
    const profile = accessClaims["https://api.openai.com/profile"] ?? {};
    const email = idClaims.email ?? profile.email ?? auth.email;
    if (!email) throw new Error("无法从凭据中识别账号邮箱");
    const accountId = auth.chatgpt_account_id ?? null;
    const organizationId = auth.chatgpt_organization_id ?? auth.organization_id ?? null;
    const existing = this.store.list().find((account) =>
      (accountId && account.accountId === accountId) ||
      (!accountId && account.email.toLowerCase() === String(email).toLowerCase()),
    );
    const id = existing?.id ?? `codex_${sha256(
      `${email}:${accountId ?? ""}:${organizationId ?? ""}`,
    ).slice(0, 32)}`;
    return this.store.upsert({
      id,
      email,
      authMode: "oauth",
      tokens: {
        idToken: tokens.idToken || existing?.tokens.idToken || "",
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? existing?.tokens.refreshToken ?? null,
      },
      accountId: accountId ?? existing?.accountId ?? null,
      organizationId: organizationId ?? existing?.organizationId ?? null,
      planType: auth.chatgpt_plan_type ?? existing?.planType ?? null,
      tokenGeneration: (existing?.tokenGeneration ?? 0) + 1,
    });
  }

  async #upsertApiKey(apiKey, accountName = "API Key") {
    const key = String(apiKey ?? "").trim();
    if (!key) throw new Error("API Key 不能为空");
    return this.store.upsert({
      id: `apikey_${sha256(key).slice(0, 32)}`,
      email: String(accountName ?? "API Key").trim() || "API Key",
      authMode: "apiKey",
      openaiApiKey: key,
      planType: "API_KEY",
      tokens: {},
    });
  }

  async #runOAuthLogin() {
    this.#setOperation("loading", "正在准备 OpenAI OAuth…");
    const verifier = base64Url(randomBytes(32));
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    const expectedState = base64Url(randomBytes(32));
    const server = createServer();
    await listen(server);
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : null;
    if (!port) throw new Error("无法分配 OAuth 回调端口");
    const redirectUri = `http://localhost:${port}/auth/callback`;
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

    try {
      const callback = waitForOAuthCallback(server, expectedState, OAUTH_TIMEOUT_MS);
      this.#setOperation("loading", "请在浏览器中完成 OpenAI 授权…");
      openExternal(authUrl.toString());
      const code = await callback;
      this.#setOperation("loading", "授权完成，正在保存账号…");
      const tokens = await exchangeAuthorizationCode(code, verifier, redirectUri);
      const account = await this.#upsertOAuthTokens(tokens);
      await this.refreshAccount(account.id, { forceSubscription: true });
      this.#setOperation("success", `已添加 ${account.email}`);
      this.clearOperationAfter();
    } finally {
      await closeServer(server);
    }
  }

  async #withOperation(message, callback) {
    this.#setOperation("loading", message);
    try {
      const result = await callback();
      this.#setOperation("success", result);
      this.clearOperationAfter();
      return result;
    } catch (error) {
      this.#setOperation("error", error.message);
      this.clearOperationAfter(8_000);
      throw error;
    }
  }

  #setOperation(state, message) {
    this.operation = { state, message, updatedAt: Date.now() };
  }
}

export async function fetchQuota(account) {
  const response = await fetch(USAGE_URL, {
    headers: apiHeaders(account),
    signal: AbortSignal.timeout(25_000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`额度接口返回 ${response.status}`);
  const usage = JSON.parse(body);
  const windows = [
    usage.rate_limit?.primary_window,
    usage.rate_limit?.secondary_window,
  ]
    .filter(Boolean)
    .map(normalizeUsageWindow);
  return { windows, planType: usage.plan_type ?? null };
}

export async function fetchSubscription(account) {
  const timezoneOffsetMin = new Date().getTimezoneOffset();
  const checkUrl = new URL(ACCOUNT_CHECK_URL);
  checkUrl.searchParams.set("timezone_offset_min", String(timezoneOffsetMin));
  const response = await fetch(checkUrl, {
    headers: apiHeaders(account, checkUrl.pathname),
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`订阅接口返回 ${response.status}`);
  const payload = await response.json();
  let snapshot = parseAccountCheck(payload, account.accountId);
  if (snapshot.subscriptionActiveUntil || !snapshot.accountId) return snapshot;

  const subscriptions = new URL(SUBSCRIPTIONS_URL);
  subscriptions.searchParams.set("account_id", snapshot.accountId);
  const fallback = await fetch(subscriptions, {
    headers: apiHeaders(account, subscriptions.pathname),
    signal: AbortSignal.timeout(25_000),
  });
  if (!fallback.ok) return snapshot;
  const data = await fallback.json();
  return {
    accountId: snapshot.accountId,
    planType: data.subscription_plan ?? data.plan_type ?? snapshot.planType,
    subscriptionActiveUntil: data.active_until ?? data.expires_at ?? null,
  };
}

export async function refreshTokens(refreshToken, currentIdToken = "") {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    signal: AbortSignal.timeout(25_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Token 刷新失败 ${response.status}: ${body.error?.code ?? body.error ?? "unknown"}`);
  }
  if (!body.access_token) throw new Error("Token 刷新响应缺少 access_token");
  return {
    idToken: body.id_token ?? currentIdToken ?? "",
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? refreshToken,
  };
}

async function exchangeAuthorizationCode(code, verifier, redirectUri) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: CLIENT_ID,
    code_verifier: verifier,
  });
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(25_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Token 交换失败 ${response.status}`);
  return {
    idToken: data.id_token ?? "",
    accessToken: data.access_token ?? "",
    refreshToken: data.refresh_token ?? null,
  };
}

export async function writeOfficialCredentials(
  codexHome,
  account,
  { syncKeychain = process.platform === "darwin" } = {},
) {
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  const payload = account.authMode === "apiKey"
    ? { auth_mode: "apikey", OPENAI_API_KEY: account.openaiApiKey }
    : account.tokens.idToken || account.tokens.refreshToken
      ? {
          OPENAI_API_KEY: null,
          tokens: {
            id_token: account.tokens.idToken,
            access_token: account.tokens.accessToken,
            refresh_token: account.tokens.refreshToken ?? "",
            account_id: account.accountId,
          },
          last_refresh: new Date().toISOString(),
        }
      : { OPENAI_API_KEY: null, personal_access_token: account.tokens.accessToken };
  await atomicWrite(join(codexHome, "auth.json"), `${JSON.stringify(payload, null, 2)}\n`);

  if (syncKeychain && account.authMode === "oauth") {
    try {
      const resolved = await realpath(codexHome).catch(() => codexHome);
      const keychainAccount = `cli|${sha256(resolved).slice(0, 16)}`;
      await execFileAsync("/usr/bin/security", [
        "add-generic-password",
        "-U",
        "-s",
        "Codex Auth",
        "-a",
        keychainAccount,
        "-w",
        JSON.stringify(payload),
      ]);
    } catch (error) {
      console.error(`[switch] Keychain 更新失败，已保留 auth.json: ${error.message}`);
    }
  }
}

function toPublicAccount(account, current) {
  return {
    id: account.id,
    email: account.email,
    authMode: account.authMode,
    planType: account.planType,
    subscriptionActiveUntil: account.subscriptionActiveUntil,
    windows: account.quota?.windows ?? [],
    quotaUpdatedAt: account.quotaUpdatedAt,
    quotaError: account.quotaError,
    current,
  };
}

function toExportAccount(account) {
  const common = {
    id: account.id,
    email: account.email,
    authMode: account.authMode,
  };
  if (account.authMode === "apiKey") {
    return { ...common, OPENAI_API_KEY: account.openaiApiKey };
  }
  return {
    ...common,
    tokens: {
      id_token: account.tokens.idToken,
      access_token: account.tokens.accessToken,
      refresh_token: account.tokens.refreshToken ?? "",
      account_id: account.accountId,
    },
  };
}

function normalizeUsageWindow(window) {
  const used = clampPercent(window.used_percent);
  const minutes = Number.isFinite(window.limit_window_seconds)
    ? Math.ceil(window.limit_window_seconds / 60)
    : null;
  const resetsAt = Number.isFinite(window.reset_at)
    ? window.reset_at
    : Number.isFinite(window.reset_after_seconds)
      ? Math.floor(Date.now() / 1000) + window.reset_after_seconds
      : null;
  const label = formatWindow(minutes);
  return {
    label,
    compactLabel: label,
    usedPercent: used,
    remainingPercent: 100 - used,
    resetsAt,
    windowDurationMins: minutes,
  };
}

function formatWindow(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return "Usage";
  if (minutes >= 10_079) return "Weekly";
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function apiHeaders(account, targetPath = "/backend-api/wham/usage") {
  const headers = {
    Authorization: `Bearer ${account.tokens.accessToken}`,
    Accept: "application/json",
    Referer: "https://chatgpt.com/",
    "User-Agent": USER_AGENT,
    "x-openai-target-path": targetPath,
    "x-openai-target-route": targetPath,
  };
  if (account.accountId) headers["ChatGPT-Account-Id"] = account.accountId;
  return headers;
}

function parseAccountCheck(payload, preferredAccountId) {
  const source = payload?.accounts;
  const records = Array.isArray(source)
    ? source
    : source && typeof source === "object"
      ? Object.entries(source).map(([key, value]) => ({ ...value, __key: key }))
      : [];
  const selected = records.find((record) => {
    const node = record.account ?? record;
    return [node.account_id, node.id, node.chatgpt_account_id, node.workspace_id]
      .filter(Boolean)
      .includes(preferredAccountId);
  }) ?? records[0] ?? {};
  const account = selected.account ?? selected;
  const entitlement = selected.entitlement ?? {};
  return {
    accountId:
      account.account_id ?? account.id ?? account.chatgpt_account_id ?? account.workspace_id ?? null,
    planType: entitlement.subscription_plan ?? account.plan_type ?? account.planType ?? null,
    subscriptionActiveUntil: entitlement.expires_at ?? account.expires_at ?? null,
  };
}

function parseCredentialInput(rawInput) {
  const input = String(rawInput ?? "").trim();
  if (!input) return { tokens: [], apiKeys: [] };
  let value;
  try {
    value = JSON.parse(input);
  } catch {
    if (input.startsWith("at-") || input.split(".").length === 3) {
      return {
        tokens: [{ idToken: "", accessToken: input, refreshToken: null }],
        apiKeys: [],
      };
    }
    return {
      tokens: [{ idToken: "", accessToken: "", refreshToken: input }],
      apiKeys: [],
    };
  }
  const items = Array.isArray(value)
    ? value
    : Array.isArray(value?.accounts)
      ? value.accounts
      : [value];
  const parsed = { tokens: [], apiKeys: [] };
  for (const item of items) {
    const apiKey = item?.OPENAI_API_KEY ?? item?.openaiApiKey ?? item?.openai_api_key;
    if (typeof apiKey === "string" && apiKey.trim()) {
      parsed.apiKeys.push({
        apiKey: apiKey.trim(),
        name: String(item?.email ?? item?.name ?? item?.accountName ?? "API Key"),
      });
    }
    const tokens = item?.tokens ?? item?.auth?.tokens ?? item;
    const personal = item?.personal_access_token ?? item?.accessToken;
    const accessToken = tokens?.access_token ?? tokens?.accessToken ?? personal ?? "";
    const idToken = tokens?.id_token ?? tokens?.idToken ?? "";
    const refreshToken = tokens?.refresh_token ?? tokens?.refreshToken ?? null;
    if (accessToken || refreshToken) {
      parsed.tokens.push({ idToken, accessToken, refreshToken });
    }
  }
  return parsed;
}

function parseTokenInput(rawInput) {
  return parseCredentialInput(rawInput).tokens;
}

function matchOfficialAccount(credentials, accounts) {
  if (!credentials || typeof credentials !== "object") return undefined;

  const apiKey = typeof credentials.OPENAI_API_KEY === "string"
    ? credentials.OPENAI_API_KEY.trim()
    : "";
  if (apiKey) {
    return accounts.find((account) =>
      account.authMode === "apiKey" && account.openaiApiKey === apiKey
    ) ?? null;
  }

  const tokens = credentials.tokens && typeof credentials.tokens === "object"
    ? credentials.tokens
    : {};
  const idToken = tokens.id_token ?? tokens.idToken ?? "";
  const accessToken =
    tokens.access_token ?? tokens.accessToken ?? credentials.personal_access_token ?? "";
  const idClaims = decodeJwt(idToken) ?? {};
  const accessClaims = decodeJwt(accessToken) ?? {};
  const auth = idClaims["https://api.openai.com/auth"] ??
    accessClaims["https://api.openai.com/auth"] ?? {};
  const profile = accessClaims["https://api.openai.com/profile"] ?? {};
  const accountId = tokens.account_id ?? tokens.accountId ?? auth.chatgpt_account_id ?? null;
  const email = idClaims.email ?? profile.email ?? auth.email ?? null;

  if (!accountId && !email && !accessToken) return undefined;

  if (accountId) {
    const byAccountId = accounts.find((account) => account.accountId === accountId);
    if (byAccountId) return byAccountId;
  }
  if (email) {
    const normalizedEmail = String(email).trim().toLowerCase();
    const byEmail = accounts.find((account) =>
      account.email.trim().toLowerCase() === normalizedEmail
    );
    if (byEmail) return byEmail;
  }
  if (accessToken) {
    return accounts.find((account) => account.tokens.accessToken === accessToken) ?? null;
  }
  return null;
}

function decodeJwt(token) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function jwtExpiration(token) {
  const value = decodeJwt(token)?.exp;
  return Number.isFinite(value) ? value : null;
}

function waitForOAuthCallback(server, expectedState, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("OAuth 授权超时，请重试")), timeoutMs);
    const finish = (error, code) => {
      clearTimeout(timer);
      server.removeAllListeners("request");
      if (error) reject(error);
      else resolve(code);
    };
    server.on("request", (request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== "/auth/callback") {
        response.writeHead(404).end("Not found");
        return;
      }
      if (url.searchParams.get("state") !== expectedState) {
        response.writeHead(400).end("OAuth state mismatch");
        return;
      }
      const code = url.searchParams.get("code");
      const authError = url.searchParams.get("error");
      if (!code) {
        response.writeHead(400).end("Authorization failed");
        finish(new Error(authError || "OAuth 回调缺少 code"));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<!doctype html><meta charset=utf-8><title>授权成功</title><style>body{font:16px -apple-system;display:grid;place-items:center;height:100vh;margin:0;background:#18181f;color:#eee}</style><h2>授权成功，可以关闭此窗口并返回 Codex</h2>");
      finish(null, code);
    });
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function openExternal(url) {
  if (process.platform === "darwin") {
    spawn("/usr/bin/open", [url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  const command = process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(command, args, { detached: true, stdio: "ignore" }).unref();
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  await writeFile(temp, content, { mode: 0o600 });
  await rename(temp, path);
}

function base64Url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function clampPercent(value) {
  return Math.min(100, Math.max(0, Math.round(Number(value) || 0)));
}

function resolveCodexHome() {
  const configured = String(process.env.CODEX_HOME ?? "").trim().replace(/^['"]|['"]$/g, "");
  return configured || join(homedir(), ".codex");
}

export { decodeJwt, normalizeUsageWindow, parseAccountCheck, parseTokenInput };
