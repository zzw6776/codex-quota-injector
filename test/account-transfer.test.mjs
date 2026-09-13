import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  AccountManager,
  writeOfficialCredentials,
} from "../src/account-manager.mjs";
import { AccountStore } from "../src/account-store.mjs";
import { createJwt, useTempDir } from "./helpers.mjs";

function oauthAccount(id, email, refreshToken, overrides = {}) {
  const claims = {
    email,
    "https://api.openai.com/auth": {
      chatgpt_account_id: `${id}-workspace`,
      chatgpt_plan_type: "plus",
    },
  };
  return {
    id,
    email,
    authMode: "oauth",
    accountId: `${id}-workspace`,
    planType: "plus",
    tokens: {
      idToken: createJwt(claims),
      accessToken: createJwt({ ...claims, exp: Math.floor(Date.now() / 1000) + 3_600 }),
      refreshToken,
    },
    ...overrides,
  };
}

async function setup(t, prefix) {
  const root = await useTempDir(t, prefix);
  const dataDir = join(root, "store");
  const cockpitDir = join(root, "empty-cockpit");
  const codexHome = join(root, "official");
  const exportDirectory = join(root, "export");
  await mkdir(codexHome, { recursive: true });
  const store = new AccountStore({ dataDir, cockpitDir });
  await store.initialize();
  const manager = new AccountManager({
    store,
    codexHome,
    exportDirectory,
    syncOfficialKeychain: false,
  });
  t.after(() => manager.close());
  return { root, dataDir, cockpitDir, codexHome, exportDirectory, store, manager };
}

async function readTransfer(directory) {
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  return JSON.parse(await readFile(join(directory, files[0]), "utf8"));
}

function quotaResponse() {
  return Response.json({
    plan_type: "plus",
    rate_limit: {
      primary_window: { used_percent: 10, limit_window_seconds: 18_000 },
    },
  });
}

function subscriptionResponse() {
  return Response.json({
    accounts: {
      unused: {
        account: { id: "unused", plan_type: "plus" },
        entitlement: { expires_at: "2028-01-01T00:00:00Z" },
      },
    },
  });
}

test("[A ACC-03] 临时迁移主动轮换两种 Token 并写回本机，但导出文件不含 refresh token", async (t) => {
  const source = await setup(t, "codex-transfer-temporary-source-");
  const original = oauthAccount("temporary", "temporary@example.invalid", "temporary-refresh-old");
  await source.store.upsert(original);
  await source.store.setCurrent(original.id);
  await writeOfficialCredentials(source.codexHome, original, { syncKeychain: false });

  const refreshedAccess = createJwt({
    email: original.email,
    exp: Math.floor(Date.now() / 1000) + 7_200,
    "https://api.openai.com/auth": { chatgpt_account_id: original.accountId },
  });
  let tokenRequests = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const target = String(url);
    if (target.endsWith("/oauth/token")) {
      tokenRequests += 1;
      assert.equal(JSON.parse(options.body).refresh_token, "temporary-refresh-old");
      return Response.json({
        access_token: refreshedAccess,
        refresh_token: "temporary-refresh-new",
      });
    }
    if (target.endsWith("/wham/usage")) return quotaResponse();
    if (target.includes("/accounts/check/")) return subscriptionResponse();
    throw new Error(`非预期网络访问 ${target}`);
  });

  const result = await source.manager.exportAccounts({
    mode: "temporary",
    accountIds: [original.id],
  });
  assert.equal(result.restartRequired, false);
  assert.equal(tokenRequests, 1);
  assert.equal(source.store.get(original.id).tokens.accessToken, refreshedAccess);
  assert.equal(source.store.get(original.id).tokens.refreshToken, "temporary-refresh-new");
  const official = JSON.parse(await readFile(join(source.codexHome, "auth.json"), "utf8"));
  assert.equal(official.tokens.access_token, refreshedAccess);
  assert.equal(official.tokens.refresh_token, "temporary-refresh-new");
  const reloadedSource = new AccountStore({
    dataDir: source.dataDir,
    cockpitDir: source.cockpitDir,
  });
  await reloadedSource.initialize();
  assert.equal(reloadedSource.get(original.id).tokens.accessToken, refreshedAccess);
  assert.equal(reloadedSource.get(original.id).tokens.refreshToken, "temporary-refresh-new");

  const transfer = await readTransfer(source.exportDirectory);
  assert.equal(transfer.version, 2);
  assert.equal(transfer.kind, "codex-account-transfer");
  assert.equal(transfer.mode, "temporary");
  assert.equal(transfer.accounts[0].tokens.access_token, refreshedAccess);
  assert.equal("refresh_token" in transfer.accounts[0].tokens, false);

  const target = await setup(t, "codex-transfer-temporary-target-");
  await target.manager.importTokenInput(JSON.stringify(transfer));
  assert.equal(tokenRequests, 1, "临时导入不能再次调用 refresh token");
  const imported = target.store.list()[0];
  assert.equal(imported.authStatus, "temporary");
  assert.equal(imported.tokens.accessToken, refreshedAccess);
  assert.equal(imported.tokens.refreshToken, null);
  assert.equal(imported.temporaryExpiresAt, transfer.accounts[0].temporary_expires_at);
});

test("[A ACC-01 ACC-03] 临时迁移不会覆盖目标设备已有的同账号完整凭据", async (t) => {
  const target = await setup(t, "codex-transfer-temporary-existing-");
  const existing = oauthAccount("existing", "existing@example.invalid", "existing-refresh");
  await target.store.upsert(existing);
  const temporaryAccess = createJwt({
    email: existing.email,
    exp: Math.floor(Date.now() / 1000) + 7_200,
    "https://api.openai.com/auth": { chatgpt_account_id: existing.accountId },
  });
  let tokenRequests = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    const targetUrl = String(url);
    if (targetUrl.endsWith("/oauth/token")) {
      tokenRequests += 1;
      throw new Error("已有完整账号不应因临时导入刷新 Token");
    }
    if (targetUrl.endsWith("/wham/usage")) return quotaResponse();
    if (targetUrl.includes("/accounts/check/")) return subscriptionResponse();
    throw new Error(`非预期网络访问 ${targetUrl}`);
  });

  await target.manager.importTokenInput(JSON.stringify({
    version: 2,
    kind: "codex-account-transfer",
    mode: "temporary",
    exportedAt: new Date().toISOString(),
    accounts: [{
      email: existing.email,
      authMode: "oauth",
      temporary_expires_at: Math.floor(Date.now() / 1000) + 7_200,
      tokens: {
        id_token: existing.tokens.idToken,
        access_token: temporaryAccess,
        account_id: existing.accountId,
      },
    }],
  }));

  const preserved = target.store.get(existing.id);
  assert.equal(tokenRequests, 0);
  assert.equal(preserved.authStatus, "active");
  assert.equal(preserved.tokens.accessToken, existing.tokens.accessToken);
  assert.equal(preserved.tokens.refreshToken, "existing-refresh");
});

test("[A ACC-03] 完整转移写回最新 Token、停用源账号并切换当前账号，目标接管后旧设备恢复会安全失败", async (t) => {
  const source = await setup(t, "codex-transfer-handoff-source-");
  const account = oauthAccount("handoff", "handoff@example.invalid", "handoff-refresh-old", {
    wakeup: { enabled: true, times: ["08:00"], updatedAt: 1 },
  });
  const fallback = oauthAccount("fallback", "fallback@example.invalid", "fallback-refresh");
  await source.store.upsert(account);
  await source.store.upsert(fallback);
  await source.store.setCurrent(account.id);
  await writeOfficialCredentials(source.codexHome, account, { syncKeychain: false });

  const exportedAccess = createJwt({
    email: account.email,
    exp: Math.floor(Date.now() / 1000) + 7_200,
    "https://api.openai.com/auth": { chatgpt_account_id: account.accountId },
  });
  const targetAccess = createJwt({
    email: account.email,
    exp: Math.floor(Date.now() / 1000) + 10_800,
    "https://api.openai.com/auth": { chatgpt_account_id: account.accountId },
  });
  let handoffRefreshUses = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const target = String(url);
    if (target.endsWith("/oauth/token")) {
      const refreshToken = JSON.parse(options.body).refresh_token;
      if (refreshToken === "handoff-refresh-old") {
        return Response.json({
          access_token: exportedAccess,
          refresh_token: "handoff-refresh-exported",
        });
      }
      if (refreshToken === "handoff-refresh-exported") {
        handoffRefreshUses += 1;
        if (handoffRefreshUses === 1) {
          return Response.json({
            access_token: targetAccess,
            refresh_token: "handoff-refresh-target",
          });
        }
        return Response.json({ error: { code: "refresh_token_reused" } }, { status: 401 });
      }
      throw new Error(`非预期 refresh token ${refreshToken}`);
    }
    if (target.endsWith("/wham/usage")) return quotaResponse();
    if (target.includes("/accounts/check/")) return subscriptionResponse();
    throw new Error(`非预期网络访问 ${target}`);
  });

  const result = await source.manager.exportAccounts({
    mode: "handoff",
    accountIds: [account.id],
  });
  assert.equal(result.restartRequired, true);
  const transferred = source.store.get(account.id);
  assert.equal(transferred.authStatus, "transferred");
  assert.equal(transferred.tokens.accessToken, exportedAccess);
  assert.equal(transferred.tokens.refreshToken, "handoff-refresh-exported");
  assert.equal(transferred.wakeup.enabled, false);
  assert.ok(transferred.transferredAt > 0);
  assert.equal(source.store.index.currentAccountId, fallback.id);
  const official = JSON.parse(await readFile(join(source.codexHome, "auth.json"), "utf8"));
  assert.equal(official.tokens.refresh_token, "fallback-refresh");

  const transfer = await readTransfer(source.exportDirectory);
  assert.equal(transfer.mode, "handoff");
  assert.equal(transfer.accounts[0].tokens.access_token, exportedAccess);
  assert.equal(transfer.accounts[0].tokens.refresh_token, "handoff-refresh-exported");

  const reloaded = new AccountStore({ dataDir: source.dataDir, cockpitDir: source.cockpitDir });
  await reloaded.initialize();
  assert.equal(reloaded.get(account.id).authStatus, "transferred");
  assert.equal(reloaded.get(account.id).tokens.accessToken, exportedAccess);
  assert.equal(reloaded.get(account.id).tokens.refreshToken, "handoff-refresh-exported");
  assert.equal(reloaded.index.currentAccountId, fallback.id);

  const target = await setup(t, "codex-transfer-handoff-target-");
  await target.manager.importTokenInput(JSON.stringify(transfer));
  const received = target.store.list()[0];
  assert.equal(received.authStatus, "active");
  assert.equal(received.tokens.accessToken, targetAccess);
  assert.equal(received.tokens.refreshToken, "handoff-refresh-target");

  await assert.rejects(
    source.manager.restoreTransferredAccount(account.id),
    /refresh_token_reused/,
  );
  assert.equal(source.store.get(account.id).authStatus, "needsReauth");
  assert.match(source.store.get(account.id).quotaError, /需要重新授权/);
});

test("[A ACC-03] 迁移文件尚未接收时，点击恢复会先刷新保留凭据，成功后才重新启用", async (t) => {
  const source = await setup(t, "codex-transfer-restore-");
  const account = oauthAccount("restore", "restore@example.invalid", "restore-refresh-old", {
    wakeup: { enabled: true, times: ["08:00"], updatedAt: 1 },
  });
  await source.store.upsert(account);
  const restoredAccess = createJwt({
    email: account.email,
    exp: Math.floor(Date.now() / 1000) + 10_800,
    "https://api.openai.com/auth": { chatgpt_account_id: account.accountId },
  });
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const target = String(url);
    if (target.endsWith("/oauth/token")) {
      const refreshToken = JSON.parse(options.body).refresh_token;
      if (refreshToken === "restore-refresh-old") {
        return Response.json({ access_token: restoredAccess, refresh_token: "restore-refresh-exported" });
      }
      if (refreshToken === "restore-refresh-exported") {
        return Response.json({ access_token: restoredAccess, refresh_token: "restore-refresh-latest" });
      }
    }
    if (target.endsWith("/wham/usage")) return quotaResponse();
    if (target.includes("/accounts/check/")) return subscriptionResponse();
    throw new Error(`非预期网络访问 ${target}`);
  });

  await source.manager.exportAccounts({ mode: "handoff", accountIds: [account.id] });
  assert.equal(source.store.get(account.id).authStatus, "transferred");
  await source.manager.restoreTransferredAccount(account.id);
  const restored = source.store.get(account.id);
  assert.equal(restored.authStatus, "active");
  assert.equal(restored.tokens.refreshToken, "restore-refresh-latest");
  assert.equal(restored.transferredAt, null);
  assert.equal(restored.wakeup.enabled, false, "恢复后不应静默重新开启付费唤醒任务");
});

test("[A ACC-01 ACC-03] API Key 只允许完整转移，源端退出登录后仍可确认恢复", async (t) => {
  const source = await setup(t, "codex-transfer-api-key-");
  const account = {
    id: "api-key",
    email: "API Key 工作账号",
    authMode: "apiKey",
    openaiApiKey: "sk-offline-transfer",
    planType: "API_KEY",
    tokens: {},
  };
  await source.store.upsert(account);
  await source.store.setCurrent(account.id);
  await writeOfficialCredentials(source.codexHome, account, { syncKeychain: false });

  await assert.rejects(
    source.manager.exportAccounts({ mode: "temporary", accountIds: [account.id] }),
    /当前不能用于临时迁移/,
  );
  const result = await source.manager.exportAccounts({ mode: "handoff", accountIds: [account.id] });
  assert.equal(result.restartRequired, true);
  assert.equal(source.store.get(account.id).authStatus, "transferred");
  assert.equal(source.store.get(account.id).openaiApiKey, "sk-offline-transfer");
  assert.equal(source.store.index.currentAccountId, null);
  assert.deepEqual(JSON.parse(await readFile(join(source.codexHome, "auth.json"), "utf8")), {
    OPENAI_API_KEY: null,
  });

  const transfer = await readTransfer(source.exportDirectory);
  assert.equal(transfer.accounts[0].OPENAI_API_KEY, "sk-offline-transfer");
  const target = await setup(t, "codex-transfer-api-key-target-");
  await target.manager.importTokenInput(JSON.stringify(transfer));
  assert.equal(target.store.list()[0].authStatus, "active");
  assert.equal(target.store.list()[0].openaiApiKey, "sk-offline-transfer");

  await source.manager.restoreTransferredAccount(account.id);
  assert.equal(source.store.get(account.id).authStatus, "active");
});

test("[A ACC-03] 迁移前主动刷新失败时不生成文件，并把永久失效标记为需要重新授权", async (t) => {
  const source = await setup(t, "codex-transfer-refresh-failure-");
  const account = oauthAccount("failure", "failure@example.invalid", "failure-refresh");
  await source.store.upsert(account);
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: { code: "invalid_grant" } }, { status: 401 }));

  await assert.rejects(
    source.manager.exportAccounts({ mode: "temporary", accountIds: [account.id] }),
    /invalid_grant/,
  );
  await assert.rejects(readdir(source.exportDirectory), { code: "ENOENT" });
  assert.equal(source.store.get(account.id).authStatus, "needsReauth");
});

test("[A ACC-03 ACC-06] 完整转移文件写入失败会恢复源账号与官方登录", async (t) => {
  const source = await setup(t, "codex-transfer-write-failure-");
  const account = oauthAccount("write-failure", "write-failure@example.invalid", "write-refresh-old");
  await source.store.upsert(account);
  await source.store.setCurrent(account.id);
  await writeOfficialCredentials(source.codexHome, account, { syncKeychain: false });
  await writeFile(source.exportDirectory, "阻止创建迁移目录");
  const refreshedAccess = createJwt({
    email: account.email,
    exp: Math.floor(Date.now() / 1000) + 7_200,
    "https://api.openai.com/auth": { chatgpt_account_id: account.accountId },
  });
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith("/oauth/token")) {
      return Response.json({ access_token: refreshedAccess, refresh_token: "write-refresh-new" });
    }
    throw new Error(`非预期网络访问 ${url}`);
  });

  await assert.rejects(
    source.manager.exportAccounts({ mode: "handoff", accountIds: [account.id] }),
    /EEXIST|ENOTDIR|not a directory/i,
  );
  const restored = source.store.get(account.id);
  assert.equal(restored.authStatus, "active");
  assert.equal(restored.tokens.accessToken, refreshedAccess);
  assert.equal(restored.tokens.refreshToken, "write-refresh-new");
  assert.equal(source.store.index.currentAccountId, account.id);
  const official = JSON.parse(await readFile(join(source.codexHome, "auth.json"), "utf8"));
  assert.equal(official.tokens.access_token, refreshedAccess);
  assert.equal(official.tokens.refresh_token, "write-refresh-new");
});
