import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  AccountStore,
  decryptAccountFile,
  encryptAccountFile,
  normalizeWakeupTimes,
} from "../src/account-store.mjs";
import { useTempDir } from "./helpers.mjs";

function account(id, overrides = {}) {
  return {
    id,
    email: `${id}@example.com`,
    authMode: "oauth",
    tokens: { idToken: "id", accessToken: "access", refreshToken: "refresh" },
    createdAt: 100,
    lastUsed: 100,
    ...overrides,
  };
}

test("账号文件使用 AES-GCM 加密，并拒绝错误密钥或篡改密文", () => {
  const key = randomBytes(32);
  const source = account("secure", { tokens: { accessToken: "secret-token" } });
  const encrypted = encryptAccountFile(source, key);

  assert.doesNotMatch(encrypted, /secret-token/);
  assert.deepEqual(decryptAccountFile(encrypted, key), source);
  assert.throws(() => decryptAccountFile(encrypted, randomBytes(32)));

  const envelope = JSON.parse(encrypted);
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");
  ciphertext[0] ^= 1;
  envelope.ciphertext = ciphertext.toString("base64");
  assert.throws(() => decryptAccountFile(JSON.stringify(envelope), key));
});

test("账号存储可持久化、排序、切换和删除，并返回隔离副本", async (t) => {
  const dataDir = await useTempDir(t);
  const cockpitDir = await useTempDir(t, "codex-cockpit-test-");
  const store = new AccountStore({ dataDir, cockpitDir });
  await store.initialize();
  await store.upsert(account("older", { lastUsed: 10 }));
  await store.upsert(account("newer", { lastUsed: 20 }));
  await store.setCurrent("older");

  assert.equal(store.list()[0].id, "older");
  const detached = store.get("older");
  detached.email = "mutated@example.com";
  assert.equal(store.get("older").email, "older@example.com");
  await assert.rejects(store.remove("older"), /当前账号不能移除/);
  await store.remove("newer");

  const reloaded = new AccountStore({ dataDir, cockpitDir });
  const snapshot = await reloaded.initialize();
  assert.equal(snapshot.currentAccountId, "older");
  assert.deepEqual(snapshot.accounts.map(({ id }) => id), ["older"]);
  assert.doesNotMatch(
    await readFile(join(dataDir, "accounts", "older.json"), "utf8"),
    /access/,
  );
});

test("已有账号索引丢失密钥时停止启动，避免生成新密钥覆盖数据", async (t) => {
  const dataDir = await useTempDir(t);
  const cockpitDir = await useTempDir(t, "codex-cockpit-test-");
  const store = new AccountStore({ dataDir, cockpitDir });
  await store.initialize();
  await store.upsert(account("protected"));
  await unlink(join(dataDir, "account-storage.key"));

  await assert.rejects(
    new AccountStore({ dataDir, cockpitDir }).initialize(),
    /加密密钥已丢失/,
  );
});

test("可从 Cockpit 明文格式迁移账号、额度与当前账号", async (t) => {
  const dataDir = await useTempDir(t);
  const cockpitDir = await useTempDir(t, "codex-cockpit-test-");
  await mkdir(join(cockpitDir, "codex_accounts"), { recursive: true });
  await writeFile(join(cockpitDir, "codex_accounts.json"), JSON.stringify({
    current_account_id: "legacy",
    accounts: [{ id: "legacy", email: "legacy@example.com" }],
  }));
  await writeFile(join(cockpitDir, "codex_accounts", "legacy.json"), JSON.stringify({
    id: "legacy",
    email: "legacy@example.com",
    tokens: { access_token: "legacy-secret" },
    quota: {
      hourly_percentage: 75,
      hourly_window_minutes: 300,
      weekly_percentage: 40,
      weekly_window_minutes: 10_080,
    },
  }));

  const store = new AccountStore({ dataDir, cockpitDir });
  await store.initialize();
  const migrated = store.get("legacy");
  assert.equal(store.index.currentAccountId, "legacy");
  assert.deepEqual(migrated.quota.windows.map((window) => window.label), ["5h", "Weekly"]);
  assert.deepEqual(migrated.quota.windows.map((window) => window.usedPercent), [25, 60]);
  assert.doesNotMatch(
    await readFile(join(dataDir, "accounts", "legacy.json"), "utf8"),
    /legacy-secret/,
  );
});

test("唤醒时间必须合法、去重并按时间排序", () => {
  assert.deepEqual(normalizeWakeupTimes(["18:30", "08:00", "18:30"]), ["08:00", "18:30"]);
  assert.throws(() => normalizeWakeupTimes(["24:00"]), /HH:mm/);
  assert.throws(() => normalizeWakeupTimes("08:00"), /时间列表/);
});
