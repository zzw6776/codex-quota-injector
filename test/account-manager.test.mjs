import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  AccountManager,
  decodeJwt,
  fetchQuota,
  fetchSubscription,
  normalizeUsageWindow,
  parseAccountCheck,
  parseTokenInput,
  refreshTokens,
  writeOfficialCredentials,
} from "../src/account-manager.mjs";
import { AccountStore } from "../src/account-store.mjs";
import { createJwt, useTempDir } from "./helpers.mjs";

function oauthAccount(overrides = {}) {
  return {
    id: "account-1",
    email: "owner@example.com",
    authMode: "oauth",
    accountId: "workspace-1",
    planType: "plus",
    tokens: {
      idToken: "id-token",
      accessToken: "access-token",
      refreshToken: "refresh-token",
    },
    ...overrides,
  };
}

function response(value, { status = 200 } = {}) {
  return new Response(
    typeof value === "string" ? value : JSON.stringify(value),
    { status, headers: { "content-type": "application/json" } },
  );
}

async function withMockFetch(t, implementation) {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  t.after(() => { globalThis.fetch = original; });
}

test("额度窗口解析会规范化标签、百分比和两种重置时间", () => {
  const before = Math.floor(Date.now() / 1000);
  const relative = normalizeUsageWindow({
    used_percent: 101.4,
    limit_window_seconds: 18_000,
    reset_after_seconds: 120,
  });
  const after = Math.floor(Date.now() / 1000);
  assert.deepEqual(relative, {
    label: "5h",
    compactLabel: "5h",
    usedPercent: 100,
    remainingPercent: 0,
    resetsAt: relative.resetsAt,
    windowDurationMins: 300,
  });
  assert.ok(relative.resetsAt >= before + 120 && relative.resetsAt <= after + 120);

  assert.deepEqual(normalizeUsageWindow({
    used_percent: -5,
    limit_window_seconds: 604_800,
    reset_at: 2_000_000_000,
  }), {
    label: "Weekly",
    compactLabel: "Weekly",
    usedPercent: 0,
    remainingPercent: 100,
    resetsAt: 2_000_000_000,
    windowDurationMins: 10_080,
  });
});

test("账号检查解析支持数组、对象和指定工作区，且不会串用同邮箱工作区", () => {
  const payload = {
    accounts: {
      "workspace-a": {
        account: { id: "workspace-a", plan_type: "free" },
        entitlement: { expires_at: "2026-01-01T00:00:00Z" },
      },
      "workspace-b": {
        account: { id: "workspace-b" },
        entitlement: { subscription_plan: "team", expires_at: "2027-01-01T00:00:00Z" },
      },
    },
  };
  assert.deepEqual(parseAccountCheck(payload, "workspace-b"), {
    accountId: "workspace-b",
    planType: "team",
    subscriptionActiveUntil: "2027-01-01T00:00:00Z",
  });
  assert.deepEqual(parseAccountCheck({ accounts: [] }, "missing"), {
    accountId: null,
    planType: null,
    subscriptionActiveUntil: null,
  });
});

test("Token 输入解析兼容原生 auth.json、备份列表和裸 Token", () => {
  assert.deepEqual(parseTokenInput(JSON.stringify({
    tokens: {
      id_token: "id",
      access_token: "access",
      refresh_token: "refresh",
      account_id: "workspace",
    },
  })), [{
    idToken: "id",
    accessToken: "access",
    refreshToken: "refresh",
    accountId: "workspace",
  }]);
  assert.deepEqual(parseTokenInput(JSON.stringify({ accounts: [{
    auth: { tokens: { accessToken: "backup-access", refreshToken: "backup-refresh" } },
    accountId: "backup-workspace",
  }] })), [{
    idToken: "",
    accessToken: "backup-access",
    refreshToken: "backup-refresh",
    accountId: "backup-workspace",
  }]);
  assert.equal(parseTokenInput("header.payload.signature")[0].accessToken,
    "header.payload.signature");
  assert.equal(parseTokenInput("opaque-refresh-token")[0].refreshToken,
    "opaque-refresh-token");
  assert.equal(decodeJwt(createJwt({ email: "jwt@example.com" })).email, "jwt@example.com");
  assert.equal(decodeJwt("invalid"), null);
});

test("额度请求发送正确账号头并映射窗口、计划和 credits", async (t) => {
  let captured;
  await withMockFetch(t, async (url, options) => {
    captured = { url: String(url), options };
    return response({
      plan_type: "pro",
      rate_limit: {
        primary_window: { used_percent: 20.4, limit_window_seconds: 18_000, reset_at: 100 },
        secondary_window: { used_percent: 70, limit_window_seconds: 604_800, reset_at: 200 },
      },
      credits: { has_credits: true, balance: 25.9 },
    });
  });

  const result = await fetchQuota(oauthAccount());
  assert.equal(captured.url, "https://chatgpt.com/backend-api/wham/usage");
  assert.equal(captured.options.headers.Authorization, "Bearer access-token");
  assert.equal(captured.options.headers["ChatGPT-Account-Id"], "workspace-1");
  assert.equal(captured.options.headers["x-openai-target-path"], "/backend-api/wham/usage");
  assert.deepEqual(result.windows.map(({ label, usedPercent }) => ({ label, usedPercent })), [
    { label: "5h", usedPercent: 20 },
    { label: "Weekly", usedPercent: 70 },
  ]);
  assert.equal(result.planType, "pro");
  assert.deepEqual(result.credits, {
    hasCredits: true,
    unlimited: false,
    balance: 25.9,
    creditQuantity: 25,
    usdAmount: 1,
    formattedUsd: "US$1.00",
  });
});

test("额度接口保留 HTTP 状态，供上层区分 401 刷新与普通故障", async (t) => {
  await withMockFetch(t, async () => response({ error: "unauthorized" }, { status: 401 }));
  await assert.rejects(fetchQuota(oauthAccount()), (error) => {
    assert.equal(error.status, 401);
    assert.match(error.message, /额度接口返回 401/);
    return true;
  });
});

test("订阅请求优先账号检查，并在缺少有效期时回退 subscriptions", async (t) => {
  const calls = [];
  await withMockFetch(t, async (url, options) => {
    const parsed = new URL(url);
    calls.push({ parsed, options });
    if (parsed.pathname.includes("/accounts/check/")) {
      return response({ accounts: [{
        account: { id: "workspace-1", plan_type: "plus" },
      }] });
    }
    return response({ subscription_plan: "pro", active_until: "2028-01-01T00:00:00Z" });
  });

  assert.deepEqual(await fetchSubscription(oauthAccount()), {
    accountId: "workspace-1",
    planType: "pro",
    subscriptionActiveUntil: "2028-01-01T00:00:00Z",
  });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].parsed.searchParams.has("timezone_offset_min"));
  assert.equal(calls[1].parsed.searchParams.get("account_id"), "workspace-1");
  assert.equal(calls[0].options.headers["x-openai-target-route"], calls[0].parsed.pathname);
  assert.equal(calls[1].options.headers["x-openai-target-route"], "/backend-api/subscriptions");
});

test("Token 刷新保留服务端未轮换的 ID/Refresh Token，并暴露永久错误代码", async (t) => {
  const bodies = [];
  await withMockFetch(t, async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return response({ access_token: "new-access" });
  });
  assert.deepEqual(await refreshTokens("old-refresh", "old-id"), {
    idToken: "old-id",
    accessToken: "new-access",
    refreshToken: "old-refresh",
  });
  assert.equal(bodies[0].grant_type, "refresh_token");
  assert.equal(bodies[0].refresh_token, "old-refresh");

  globalThis.fetch = async () => response({ error: { code: "refresh_token_reused" } }, { status: 401 });
  await assert.rejects(refreshTokens("used-refresh"), (error) => {
    assert.equal(error.status, 401);
    assert.equal(error.code, "refresh_token_reused");
    return true;
  });
});

test("写入官方凭据兼容 OAuth、Personal Token 和 API Key 三种原生格式", async (t) => {
  const codexHome = await useTempDir(t, "codex-auth-test-");
  await writeOfficialCredentials(codexHome, oauthAccount(), { syncKeychain: false });
  let written = JSON.parse(await readFile(join(codexHome, "auth.json"), "utf8"));
  assert.equal(written.OPENAI_API_KEY, null);
  assert.deepEqual(written.tokens, {
    id_token: "id-token",
    access_token: "access-token",
    refresh_token: "refresh-token",
    account_id: "workspace-1",
  });
  assert.ok(Number.isFinite(Date.parse(written.last_refresh)));

  await writeOfficialCredentials(codexHome, oauthAccount({
    tokens: { idToken: "", accessToken: "personal", refreshToken: null },
  }), { syncKeychain: false });
  written = JSON.parse(await readFile(join(codexHome, "auth.json"), "utf8"));
  assert.deepEqual(written, { OPENAI_API_KEY: null, personal_access_token: "personal" });

  await writeOfficialCredentials(codexHome, {
    authMode: "apiKey",
    openaiApiKey: "sk-test",
  }, { syncKeychain: false });
  written = JSON.parse(await readFile(join(codexHome, "auth.json"), "utf8"));
  assert.deepEqual(written, { auth_mode: "apikey", OPENAI_API_KEY: "sk-test" });
});

test("首次启动从当前原生 auth.json 导入账号，并同步当前选择", async (t) => {
  const dataDir = await useTempDir(t, "codex-account-data-");
  const cockpitDir = await useTempDir(t, "codex-account-cockpit-");
  const codexHome = await useTempDir(t, "codex-account-home-");
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(codexHome, "auth.json"), JSON.stringify({
    auth_mode: "apikey",
    OPENAI_API_KEY: "sk-local-test",
  }));
  const store = new AccountStore({ dataDir, cockpitDir });
  const manager = new AccountManager({ store, codexHome });
  t.after(() => manager.close());

  const view = await manager.initialize();
  assert.equal(view.accounts.length, 1);
  assert.equal(view.currentAccountId, view.accounts[0].id);
  assert.equal(view.currentAccountId.startsWith("apikey_"), true);
  assert.equal(store.get(view.currentAccountId).openaiApiKey, "sk-local-test");
});

test("原生 OAuth Token 轮换只更新匹配工作区，不会借用同邮箱其他工作区", async (t) => {
  const dataDir = await useTempDir(t, "codex-account-sync-");
  const cockpitDir = await useTempDir(t, "codex-account-cockpit-");
  const codexHome = await useTempDir(t, "codex-account-home-");
  const store = new AccountStore({ dataDir, cockpitDir });
  await store.initialize();
  const authClaims = (workspace) => ({
    email: "same@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: workspace,
      chatgpt_plan_type: "plus",
    },
  });
  await store.upsert(oauthAccount({
    id: "workspace-a-record",
    email: "same@example.com",
    accountId: "workspace-a",
    tokens: {
      idToken: createJwt(authClaims("workspace-a")),
      accessToken: createJwt({ ...authClaims("workspace-a"), exp: 2_000_000_000 }),
      refreshToken: "refresh-a",
    },
  }));
  await store.upsert(oauthAccount({
    id: "workspace-b-record",
    email: "same@example.com",
    accountId: "workspace-b",
    tokens: {
      idToken: createJwt(authClaims("workspace-b")),
      accessToken: createJwt({ ...authClaims("workspace-b"), exp: 2_000_000_000 }),
      refreshToken: "refresh-b",
    },
  }));
  await store.setCurrent("workspace-a-record");
  const rotatedAccess = createJwt({ ...authClaims("workspace-b"), exp: 2_100_000_000 });
  await writeFile(join(codexHome, "auth.json"), JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      id_token: createJwt(authClaims("workspace-b")),
      access_token: rotatedAccess,
      refresh_token: "refresh-b-rotated",
      account_id: "workspace-b",
    },
  }));
  const manager = new AccountManager({ store, codexHome });
  t.after(() => manager.close());

  const result = await manager.syncCurrentAccountFromOfficialCredentials();
  assert.equal(result.changed, true);
  assert.equal(store.index.currentAccountId, "workspace-b-record");
  assert.equal(store.get("workspace-b-record").tokens.accessToken, rotatedAccess);
  assert.equal(store.get("workspace-b-record").tokens.refreshToken, "refresh-b-rotated");
  assert.equal(store.get("workspace-a-record").tokens.refreshToken, "refresh-a");
});

test("切换 API Key 账号会原子写入官方 auth.json，再更新当前账号", async (t) => {
  const dataDir = await useTempDir(t, "codex-account-switch-");
  const cockpitDir = await useTempDir(t, "codex-account-cockpit-");
  const codexHome = await useTempDir(t, "codex-account-home-");
  const store = new AccountStore({ dataDir, cockpitDir });
  await store.initialize();
  await store.upsert({
    id: "old-key",
    email: "Old Key",
    authMode: "apiKey",
    openaiApiKey: "sk-old",
    tokens: {},
  });
  await store.upsert({
    id: "new-key",
    email: "New Key",
    authMode: "apiKey",
    openaiApiKey: "sk-new",
    tokens: {},
  });
  await store.setCurrent("old-key");
  await writeFile(join(codexHome, "auth.json"), JSON.stringify({
    auth_mode: "apikey",
    OPENAI_API_KEY: "sk-old",
  }));
  const manager = new AccountManager({ store, codexHome });
  t.after(() => manager.close());

  assert.equal(await manager.switchAccount("new-key"), "已切换到 New Key");
  assert.equal(store.index.currentAccountId, "new-key");
  assert.deepEqual(JSON.parse(await readFile(join(codexHome, "auth.json"), "utf8")), {
    auth_mode: "apikey",
    OPENAI_API_KEY: "sk-new",
  });
});

test("非当前 OAuth 账号遇到过期 Token 会先刷新，再读取额度", async (t) => {
  const dataDir = await useTempDir(t, "codex-account-refresh-");
  const cockpitDir = await useTempDir(t, "codex-account-cockpit-");
  const codexHome = await useTempDir(t, "codex-account-home-");
  const store = new AccountStore({ dataDir, cockpitDir });
  await store.initialize();
  await store.upsert(oauthAccount({
    id: "refresh-me",
    subscriptionUpdatedAt: Math.floor(Date.now() / 1000),
    tokens: {
      idToken: createJwt({ email: "owner@example.com" }),
      accessToken: createJwt({ exp: 1 }),
      refreshToken: "refresh-once",
    },
  }));
  const calls = [];
  await withMockFetch(t, async (url, options) => {
    calls.push({ url: String(url), authorization: options.headers?.Authorization });
    if (String(url).includes("auth.openai.com/oauth/token")) {
      return response({ access_token: createJwt({ exp: 2_100_000_000 }) });
    }
    return response({
      plan_type: "plus",
      rate_limit: {
        primary_window: { used_percent: 10, limit_window_seconds: 18_000, reset_at: 100 },
      },
    });
  });
  const manager = new AccountManager({ store, codexHome });
  t.after(() => manager.close());

  const refreshed = await manager.refreshAccount("refresh-me");
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /auth\.openai\.com\/oauth\/token/);
  assert.match(calls[1].authorization, /^Bearer /);
  assert.notEqual(refreshed.tokens.accessToken, createJwt({ exp: 1 }));
  assert.equal(refreshed.tokens.refreshToken, "refresh-once");
  assert.equal(refreshed.quota.windows[0].remainingPercent, 90);
});
