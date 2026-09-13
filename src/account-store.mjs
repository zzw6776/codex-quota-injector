import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { defaultAccountDataDir } from "./platform.mjs";

const STORE_VERSION = 3;
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
    this.encryptionKey = null;
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await mkdir(this.accountsDir, { recursive: true, mode: 0o700 });
    const loaded = await this.#loadOwnData();
    if (!loaded || (this.accounts.size === 0 && this.index.accounts.length > 0)) {
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
    return this.#enqueueWrite(() => this.#upsertOnce(account));
  }

  async update(accountId, patch) {
    return this.#enqueueWrite(() => {
      const previous = this.accounts.get(accountId);
      if (!previous) throw new Error(`账号不存在: ${accountId}`);
      const changes = typeof patch === "function"
        ? patch(structuredClone(previous))
        : patch;
      return this.#upsertOnce({
        ...previous,
        ...changes,
        id: accountId,
      });
    });
  }

  async remove(accountId) {
    return this.#enqueueWrite(() => this.#removeOnce(accountId));
  }

  async #removeOnce(accountId) {
    const account = this.accounts.get(accountId);
    if (!account) throw new Error(`账号不存在: ${accountId}`);
    if (accountId === this.index.currentAccountId) {
      throw new Error("当前账号不能移除，请先切换到其他账号");
    }

    this.accounts.delete(accountId);
    try {
      await this.#writeIndex();
      await removeFile(join(this.accountsDir, `${safeFileId(accountId)}.json`));
    } catch (error) {
      this.accounts.set(accountId, account);
      try {
        await this.#writeIndex();
      } catch (rollbackError) {
        error.message = `${error.message}（回滚失败：${rollbackError.message}）`;
      }
      throw error;
    }
    return structuredClone(account);
  }

  async #upsertOnce(account) {
    const previous = this.accounts.get(account.id);
    const now = Math.floor(Date.now() / 1000);
    const next = normalizeAccount({
      ...previous,
      ...account,
      createdAt: previous?.createdAt ?? account.createdAt ?? now,
      lastUsed: account.lastUsed ?? previous?.lastUsed ?? now,
    });
    await this.#writeAccount(next);
    this.accounts.set(next.id, next);
    try {
      await this.#writeIndex();
    } catch (error) {
      if (previous) this.accounts.set(next.id, previous);
      else this.accounts.delete(next.id);
      try {
        if (previous) await this.#writeAccount(previous);
        else await removeFile(join(this.accountsDir, `${safeFileId(next.id)}.json`));
      } catch (rollbackError) {
        error.message += `（账号文件回滚失败：${rollbackError.message}）`;
      }
      throw error;
    }
    return structuredClone(next);
  }

  async setCurrent(accountId) {
    return this.#enqueueWrite(() => this.#setCurrentOnce(accountId));
  }

  async #setCurrentOnce(accountId) {
    if (accountId != null && !this.accounts.has(accountId)) {
      throw new Error(`账号不存在: ${accountId}`);
    }
    if (accountId != null && this.accounts.get(accountId)?.authStatus === "transferred") {
      throw new Error("已转出的账号不能设为当前账号，请先恢复");
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
    let index;
    try {
      index = JSON.parse(await readFile(this.indexPath, "utf8"));
      if (!Array.isArray(index?.accounts)) throw new Error("账号索引格式损坏");
      assertReadableVersion(index.version);
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw new Error(`无法读取账号索引，已停止启动以保护现有数据：${error.message}`);
    }
    const loadedIndex = {
      version: index.version ?? 1,
      currentAccountId: index.currentAccountId ?? null,
      accounts: index.accounts,
    };
    const key = await this.#readOrCreateKey({ allowCreate: index.accounts.length === 0 });
    const loadedAccounts = new Map();
    for (const summary of index.accounts) {
      const path = join(this.accountsDir, `${safeFileId(summary.id)}.json`);
      try {
        const content = await readFile(path, "utf8");
        assertReadableVersion(JSON.parse(content).version);
        const account = normalizeAccount(decryptAccountFile(content, key));
        if (account.id !== summary.id || loadedAccounts.has(account.id)) throw new Error("账号 ID 与索引不一致或重复");
        loadedAccounts.set(account.id, account);
      } catch (error) {
        throw new Error(`无法读取账号 ${summary.id}，已停止启动以保护现有数据：${error.message}`);
      }
    }
    this.index = loadedIndex;
    this.accounts = loadedAccounts;
    if (
      !this.accounts.has(this.index.currentAccountId) ||
      this.accounts.get(this.index.currentAccountId)?.authStatus === "transferred"
    ) {
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
    const index = { ...this.index, version: STORE_VERSION, accounts: [...this.accounts.values()].map((account) => ({
      id: account.id,
      email: account.email,
      authMode: account.authMode,
      planType: account.planType ?? null,
      subscriptionActiveUntil: account.subscriptionActiveUntil ?? null,
      createdAt: account.createdAt,
      lastUsed: account.lastUsed,
    })) };
    await atomicWrite(this.indexPath, `${JSON.stringify(index, null, 2)}\n`, 0o600);
    this.index = index;
  }

  async #readOrCreateKey({ allowCreate = true } = {}) {
    if (this.encryptionKey) return this.encryptionKey;
    try {
      this.encryptionKey = decodeKey(await readFile(this.keyPath, "utf8"));
      return this.encryptionKey;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new Error(`账号加密密钥无效，已停止读取以保护现有账号数据：${error.message}`);
      }
      if (!allowCreate) {
        throw new Error("账号加密密钥已丢失，已停止启动以避免用新密钥覆盖现有账号数据");
      }
      const key = randomBytes(32);
      await atomicWrite(this.keyPath, `${key.toString("base64")}\n`, 0o600);
      this.encryptionKey = key;
      return key;
    }
  }

  async #enqueueWrite(callback) {
    const task = this.writeQueue
      .catch(() => undefined)
      .then(callback);
    this.writeQueue = task;
    return task;
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
  const quotaError = raw.quotaError ?? raw.quota_error?.message ?? null;
  const authStatus = raw.authStatus ?? raw.auth_status ??
    (String(quotaError ?? "").includes("refresh_token_reused") ? "needsReauth" : "active");
  const normalizedAuthStatus = ["active", "needsReauth", "temporary", "transferred"]
    .includes(authStatus) ? authStatus : "active";
  const wakeup = normalizeWakeup(raw.wakeup);
  if (normalizedAuthStatus === "transferred") wakeup.enabled = false;
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
    quotaError,
    authStatus: normalizedAuthStatus,
    transferredAt: Number(raw.transferredAt ?? raw.transferred_at) || null,
    temporaryExpiresAt: Number(raw.temporaryExpiresAt ?? raw.temporary_expires_at) || null,
    wakeup,
    tokenGeneration: Number(raw.tokenGeneration ?? raw.token_generation) || 0,
    createdAt: Number(raw.createdAt ?? raw.created_at) || Math.floor(Date.now() / 1000),
    lastUsed: Number(raw.lastUsed ?? raw.last_used) || Math.floor(Date.now() / 1000),
  };
}

export function normalizeWakeupTimes(values) {
  if (!Array.isArray(values)) throw new Error("唤醒时间必须是时间列表");
  const times = values.map((value) => String(value).trim());
  if (times.some((value) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(value))) {
    throw new Error("请使用 24 小时时间，格式为 HH:mm，例如 08:00");
  }
  return [...new Set(times)].sort();
}

function normalizeWakeup(value) {
  let times = [];
  try { times = normalizeWakeupTimes(value?.times ?? []); } catch { /* Disable invalid schedules. */ }
  return {
    enabled: value?.enabled === true && times.length > 0,
    times,
    updatedAt: Number(value?.updatedAt) || 0,
    scheduledDate: typeof value?.scheduledDate === "string" ? value.scheduledDate : null,
    scheduledTimes: Array.isArray(value?.scheduledTimes) ? value.scheduledTimes : [],
    lastRun: value?.lastRun && typeof value.lastRun === "object" ? value.lastRun : null,
  };
}

function normalizeQuota(quota) {
  if (!quota || typeof quota !== "object") return null;
  const credits = normalizeCredits(quota.credits);
  if (Array.isArray(quota.windows)) {
    return {
      windows: quota.windows.filter(Boolean),
      ...(credits ? { credits } : {}),
    };
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
  return {
    windows: windows.filter(Boolean),
    ...(credits ? { credits } : {}),
  };
}

function normalizeCredits(credits) {
  if (!credits || typeof credits !== "object") return null;
  const hasCredits = Boolean(credits.has_credits || credits.hasCredits);
  const unlimited = Boolean(credits.unlimited);
  const rawBalance = credits.balance != null ? Number(credits.balance) : null;
  const balance = Number.isFinite(rawBalance) ? rawBalance : null;
  const creditQuantity = balance != null ? Math.floor(balance) : null;
  const usdAmount = creditQuantity != null ? Number((creditQuantity * 0.04).toFixed(2)) : null;
  const formattedUsd = usdAmount != null ? `US$${usdAmount.toFixed(2)}` : null;
  return {
    hasCredits,
    unlimited,
    balance,
    creditQuantity,
    usdAmount,
    formattedUsd,
  };
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

function assertReadableVersion(version = 1) {
  if (!Number.isInteger(version) || version < 1 || version > STORE_VERSION) {
    throw new Error(`不支持的账号存储版本 ${version}`);
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function removeFile(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function atomicWrite(path, content, mode) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp.${process.pid}.${randomBytes(5).toString("hex")}`;
  try {
    await writeFile(temp, content, { mode });
    await rename(temp, path);
  } finally {
    await removeFile(temp).catch(() => undefined);
  }
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
