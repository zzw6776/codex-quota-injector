import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { defaultAccountDataDir } from "./platform.mjs";

const STORE_VERSION = 1;
const ENCRYPTION_ALGORITHM = "AES-256-GCM";

export class AccountStore {
  constructor({
    dataDir = defaultAccountDataDir(),
    cockpitDir = join(homedir(), ".antigravity_cockpit"),
  } = {}) {
    this.dataDir = dataDir;
    this.cockpitDir = cockpitDir;
    this.indexPath = join(dataDir, "accounts.json");
    this.accountsDir = join(dataDir, "accounts");
    this.keyPath = join(dataDir, "account-storage.key");
    this.index = emptyIndex();
    this.accounts = new Map();
  }

  async initialize() {
    await mkdir(this.accountsDir, { recursive: true, mode: 0o700 });
    const loaded = await this.#loadOwnData();
    if (!loaded || this.accounts.size === 0) {
      await this.#importCockpitData();
    }
    return this.snapshot();
  }

  snapshot() {
    return {
      currentAccountId: this.index.currentAccountId,
      accounts: [...this.accounts.values()].map((account) => structuredClone(account)),
    };
  }

  get(accountId) {
    const account = this.accounts.get(accountId);
    return account ? structuredClone(account) : null;
  }

  list() {
    return [...this.accounts.values()]
      .map((account) => structuredClone(account))
      .sort((left, right) => {
        if (left.id === this.index.currentAccountId) return -1;
        if (right.id === this.index.currentAccountId) return 1;
        return (right.lastUsed ?? 0) - (left.lastUsed ?? 0);
      });
  }

  async upsert(account) {
    const previous = this.accounts.get(account.id);
    const now = Math.floor(Date.now() / 1000);
    const next = normalizeAccount({
      ...previous,
      ...account,
      createdAt: previous?.createdAt ?? account.createdAt ?? now,
      lastUsed: account.lastUsed ?? previous?.lastUsed ?? now,
    });
    this.accounts.set(next.id, next);
    await this.#writeAccount(next);
    await this.#writeIndex();
    return structuredClone(next);
  }

  async setCurrent(accountId) {
    if (accountId != null && !this.accounts.has(accountId)) {
      throw new Error(`账号不存在: ${accountId}`);
    }
    this.index.currentAccountId = accountId;
    if (accountId) {
      const account = this.accounts.get(accountId);
      account.lastUsed = Math.floor(Date.now() / 1000);
      await this.#writeAccount(account);
    }
    await this.#writeIndex();
  }

  async #loadOwnData() {
    const index = await readJson(this.indexPath);
    if (!index || !Array.isArray(index.accounts)) return false;
    this.index = {
      version: Number(index.version) || STORE_VERSION,
      currentAccountId: index.currentAccountId ?? null,
      accounts: index.accounts,
    };
    const key = await this.#readOrCreateKey();
    for (const summary of index.accounts) {
      const path = join(this.accountsDir, `${safeFileId(summary.id)}.json`);
      try {
        const content = await readFile(path, "utf8");
        const account = normalizeAccount(decryptAccountFile(content, key));
        this.accounts.set(account.id, account);
      } catch (error) {
        console.error(`[accounts] 无法读取 ${summary.id}: ${error.message}`);
      }
    }
    if (!this.accounts.has(this.index.currentAccountId)) {
      this.index.currentAccountId = null;
    }
    return true;
  }

  async #importCockpitData() {
    const cockpitIndexPath = join(this.cockpitDir, "codex_accounts.json");
    const cockpitIndex = await readJson(cockpitIndexPath);
    if (!cockpitIndex || !Array.isArray(cockpitIndex.accounts)) return false;

    let cockpitKey = null;
    try {
      cockpitKey = decodeKey(await readFile(join(this.cockpitDir, "secure-account-storage.key"), "utf8"));
    } catch {
      // Legacy Cockpit account files can be plaintext.
    }

    let imported = 0;
    for (const summary of cockpitIndex.accounts) {
      const path = join(this.cockpitDir, "codex_accounts", `${safeFileId(summary.id)}.json`);
      try {
        const content = await readFile(path, "utf8");
        const raw = parseCompatibleAccountFile(content, cockpitKey);
        const account = normalizeAccount({
          ...raw,
          id: raw.id ?? summary.id,
          email: raw.email ?? summary.email,
          authMode: normalizeAuthMode(raw.auth_mode ?? raw.authMode),
          openaiApiKey: raw.openai_api_key ?? raw.openaiApiKey,
          apiBaseUrl: raw.api_base_url ?? raw.apiBaseUrl,
          accountId: raw.account_id ?? raw.accountId,
          organizationId: raw.organization_id ?? raw.organizationId,
          planType: raw.plan_type ?? raw.planType ?? summary.plan_type,
          subscriptionActiveUntil:
            raw.subscription_active_until ??
            raw.subscriptionActiveUntil ??
            summary.subscription_active_until,
          quota: normalizeQuota(raw.quota),
          quotaUpdatedAt: raw.usage_updated_at ?? raw.quotaUpdatedAt,
          createdAt: raw.created_at ?? raw.createdAt ?? summary.created_at,
          lastUsed: raw.last_used ?? raw.lastUsed ?? summary.last_used,
          tokenGeneration: raw.token_generation ?? raw.tokenGeneration ?? 0,
        });
        this.accounts.set(account.id, account);
        await this.#writeAccount(account);
        imported += 1;
      } catch (error) {
        console.error(`[accounts] Cockpit 账号 ${summary.id} 导入失败: ${error.message}`);
      }
    }

    if (imported > 0) {
      this.index.currentAccountId = this.accounts.has(cockpitIndex.current_account_id)
        ? cockpitIndex.current_account_id
        : null;
      await this.#writeIndex();
      console.log(`[accounts] 已从 Cockpit 独立迁移 ${imported} 个账号`);
      return true;
    }
    return false;
  }

  async #writeAccount(account) {
    const key = await this.#readOrCreateKey();
    const content = encryptAccountFile(account, key);
    const path = join(this.accountsDir, `${safeFileId(account.id)}.json`);
    await atomicWrite(path, content, 0o600);
  }

  async #writeIndex() {
    this.index.accounts = [...this.accounts.values()].map((account) => ({
      id: account.id,
      email: account.email,
      authMode: account.authMode,
      planType: account.planType ?? null,
      subscriptionActiveUntil: account.subscriptionActiveUntil ?? null,
      createdAt: account.createdAt,
      lastUsed: account.lastUsed,
    }));
    await atomicWrite(this.indexPath, `${JSON.stringify(this.index, null, 2)}\n`, 0o600);
  }

  async #readOrCreateKey() {
    try {
      return decodeKey(await readFile(this.keyPath, "utf8"));
    } catch {
      const key = randomBytes(32);
      await atomicWrite(this.keyPath, `${key.toString("base64")}\n`, 0o600);
      return key;
    }
  }
}

export function encryptAccountFile(account, key) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(account), "utf8"),
    cipher.final(),
  ]);
  const combined = Buffer.concat([ciphertext, cipher.getAuthTag()]);
  return `${JSON.stringify(
    {
      version: STORE_VERSION,
      kind: "codex",
      algorithm: ENCRYPTION_ALGORITHM,
      key_id: "codex-quota-injector-v1",
      nonce: nonce.toString("base64"),
      ciphertext: combined.toString("base64"),
      encrypted_at: Math.floor(Date.now() / 1000),
    },
    null,
    2,
  )}\n`;
}

export function decryptAccountFile(content, key) {
  const value = JSON.parse(content);
  if (value?.algorithm !== ENCRYPTION_ALGORITHM) return value;
  const nonce = Buffer.from(value.nonce, "base64");
  const combined = Buffer.from(value.ciphertext, "base64");
  if (combined.length < 17) throw new Error("账号密文长度无效");
  const ciphertext = combined.subarray(0, -16);
  const tag = combined.subarray(-16);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"),
  );
}

function parseCompatibleAccountFile(content, key) {
  const value = JSON.parse(content);
  if (value?.algorithm !== ENCRYPTION_ALGORITHM) return value;
  if (!key) throw new Error("缺少 Cockpit 账号解密密钥");
  return decryptAccountFile(content, key);
}

function normalizeAccount(raw) {
  const id = String(raw.id ?? "").trim();
  if (!id) throw new Error("账号缺少 id");
  const tokens = raw.tokens && typeof raw.tokens === "object" ? raw.tokens : {};
  return {
    id,
    email: String(raw.email ?? raw.accountName ?? id),
    authMode: normalizeAuthMode(raw.authMode ?? raw.auth_mode),
    openaiApiKey: raw.openaiApiKey ?? raw.openai_api_key ?? null,
    apiBaseUrl: raw.apiBaseUrl ?? raw.api_base_url ?? null,
    tokens: {
      idToken: String(tokens.idToken ?? tokens.id_token ?? ""),
      accessToken: String(tokens.accessToken ?? tokens.access_token ?? ""),
      refreshToken: tokens.refreshToken ?? tokens.refresh_token ?? null,
    },
    accountId: raw.accountId ?? raw.account_id ?? null,
    organizationId: raw.organizationId ?? raw.organization_id ?? null,
    planType: raw.planType ?? raw.plan_type ?? null,
    subscriptionActiveUntil:
      raw.subscriptionActiveUntil ?? raw.subscription_active_until ?? null,
    subscriptionUpdatedAt:
      Number(raw.subscriptionUpdatedAt ?? raw.subscription_query_last_success_at) || null,
    quota: normalizeQuota(raw.quota),
    quotaUpdatedAt: Number(raw.quotaUpdatedAt ?? raw.usage_updated_at) || null,
    quotaError: raw.quotaError ?? raw.quota_error?.message ?? null,
    tokenGeneration: Number(raw.tokenGeneration ?? raw.token_generation) || 0,
    createdAt: Number(raw.createdAt ?? raw.created_at) || Math.floor(Date.now() / 1000),
    lastUsed: Number(raw.lastUsed ?? raw.last_used) || Math.floor(Date.now() / 1000),
  };
}

function normalizeQuota(quota) {
  if (!quota || typeof quota !== "object") return null;
  if (Array.isArray(quota.windows)) {
    return { windows: quota.windows.filter(Boolean) };
  }
  const windows = [];
  const hasFlags =
    quota.hourly_window_present !== undefined || quota.weekly_window_present !== undefined;
  if (!hasFlags || quota.hourly_window_present === true) {
    windows.push(cockpitWindow(quota, "hourly"));
  }
  if (!hasFlags || quota.weekly_window_present === true) {
    windows.push(cockpitWindow(quota, "weekly"));
  }
  return { windows: windows.filter(Boolean) };
}

function cockpitWindow(quota, prefix) {
  const remaining = Number(quota[`${prefix}_percentage`]);
  if (!Number.isFinite(remaining)) return null;
  const minutes = Number(quota[`${prefix}_window_minutes`]);
  const resetsAt = Number(quota[`${prefix}_reset_time`]);
  return {
    label: formatWindowLabel(minutes, prefix),
    compactLabel: formatWindowLabel(minutes, prefix),
    remainingPercent: clampPercent(remaining),
    usedPercent: 100 - clampPercent(remaining),
    resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
    windowDurationMins: Number.isFinite(minutes) ? minutes : null,
  };
}

function formatWindowLabel(minutes, fallback) {
  if (Number.isFinite(minutes) && minutes > 0) {
    if (minutes >= 10_079) return "Weekly";
    if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
    if (minutes % 60 === 0) return `${minutes / 60}h`;
    return `${minutes}m`;
  }
  return fallback === "weekly" ? "Weekly" : "5h";
}

function normalizeAuthMode(value) {
  return String(value ?? "oauth").toLowerCase().includes("api") ? "apiKey" : "oauth";
}

function clampPercent(value) {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function emptyIndex() {
  return { version: STORE_VERSION, currentAccountId: null, accounts: [] };
}

function safeFileId(value) {
  const id = String(value);
  if (!/^[a-zA-Z0-9_.-]+$/.test(id)) throw new Error(`非法账号 ID: ${id}`);
  return id;
}

function decodeKey(value) {
  const key = Buffer.from(String(value).trim(), "base64");
  if (key.length !== 32) throw new Error("账号加密密钥长度无效");
  return key;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function atomicWrite(path, content, mode) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp.${process.pid}.${randomBytes(5).toString("hex")}`;
  await writeFile(temp, content, { mode });
  await rename(temp, path);
  try {
    const info = await stat(path);
    if ((info.mode & 0o777) !== mode) {
      const { chmod } = await import("node:fs/promises");
      await chmod(path, mode);
    }
  } catch {
    // Best effort permission tightening.
  }
}
