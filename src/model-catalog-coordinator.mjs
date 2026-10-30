import { createHash } from "node:crypto";

import { readCodexRuntimeVersion } from "./codex-runtime/install.mjs";
import { parseCodexVersion } from "./codex-runtime/releases.mjs";
import {
  fetchOfficialModelCatalog,
  normalizeCatalogOriginator,
  resolveCatalogOriginator,
} from "./official-model-catalog.mjs";
import { resolveCodexCliExecutable } from "./platform/executables.mjs";

export const MODEL_CATALOG_REFRESH_MS = 60 * 60_000;

const BUSY_RETRY_MS = 30_000;
const CREDENTIAL_RETRY_MS = 5 * 60_000;
const FAILURE_RETRY_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000];

export class ModelCatalogCoordinator {
  constructor({
    accountManager,
    contextManager,
    fetchModelCatalog = fetchOfficialModelCatalog,
    getExecutable = resolveCodexCliExecutable,
    readRuntimeVersion = readCodexRuntimeVersion,
    getOriginator = resolveCatalogOriginator,
    canRunScheduledRefresh = async () => true,
    onResult = null,
  }) {
    if (!contextManager) throw new Error("模型目录协调器缺少上下文管理器");
    this.accountManager = accountManager;
    this.contextManager = contextManager;
    this.fetchModelCatalog = fetchModelCatalog;
    this.getExecutable = getExecutable;
    this.readRuntimeVersion = readRuntimeVersion;
    this.getOriginator = getOriginator;
    this.canRunScheduledRefresh = canRunScheduledRefresh;
    this.onResult = onResult;

    this.closed = false;
    this.schedulerStarted = false;
    this.timer = null;
    this.running = null;
    this.revision = 0;
    this.completedRevision = 0;
    this.pendingNotification = false;
    this.pendingExecutable = null;
    this.pendingClientVersion = null;
    this.pendingOriginator = null;
    this.pendingForce = false;
    this.lastResult = null;
    this.failureCount = 0;
    this.nextRefreshDelayMs = MODEL_CATALOG_REFRESH_MS;
    this.activeCatalogScopeKey = null;
  }

  get busy() {
    return this.running != null;
  }

  configure({ getExecutable, canRunScheduledRefresh, onResult } = {}) {
    if (typeof getExecutable === "function") this.getExecutable = getExecutable;
    if (typeof canRunScheduledRefresh === "function") {
      this.canRunScheduledRefresh = canRunScheduledRefresh;
    }
    if (onResult === null || typeof onResult === "function") this.onResult = onResult;
  }

  start() {
    if (this.closed || this.schedulerStarted) return;
    this.schedulerStarted = true;
    this.#schedule(this.nextRefreshDelayMs);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.schedulerStarted = false;
    clearTimeout(this.timer);
    this.timer = null;
  }

  request({
    reason = "launch",
    executable = null,
    clientVersion = null,
    originator = null,
    force = false,
  } = {}) {
    if (this.closed) return Promise.reject(new Error("模型目录协调器已关闭"));
    this.#invalidate(reason, { executable, clientVersion, originator, force });
    if (reason !== "periodic") {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.#ensureDrain();
    return this.whenIdle();
  }

  async whenIdle() {
    while (this.running) await this.running;
    if (this.closed) throw new Error("模型目录协调器已关闭");
    return this.lastResult;
  }

  #invalidate(reason, {
    executable = null,
    clientVersion = null,
    originator = null,
    force = false,
  } = {}) {
    this.revision++;
    if (reason === "periodic" || reason === "credentials") {
      this.pendingNotification = true;
    }
    if (executable) this.pendingExecutable = executable;
    if (clientVersion) this.pendingClientVersion = clientVersion;
    if (originator) this.pendingOriginator = originator;
    if (force) this.pendingForce = true;
  }

  #ensureDrain() {
    if (this.closed || this.running || this.completedRevision === this.revision) return;
    const task = this.#drain();
    const settled = task.finally(() => {
      if (this.running === settled) this.running = null;
      if (!this.closed && this.completedRevision !== this.revision) this.#ensureDrain();
      else this.#schedule(this.nextRefreshDelayMs);
    });
    this.running = settled;
  }

  async #drain() {
    while (!this.closed && this.completedRevision !== this.revision) {
      const revision = this.revision;
      const notify = this.pendingNotification;
      const executable = this.pendingExecutable;
      const clientVersion = this.pendingClientVersion;
      const originator = this.pendingOriginator;
      const force = this.pendingForce;
      this.pendingNotification = false;
      this.pendingExecutable = null;
      this.pendingClientVersion = null;
      this.pendingOriginator = null;
      this.pendingForce = false;

      const outcome = await this.#refresh(revision, {
        executable,
        clientVersion,
        originator,
        force,
      });
      if (outcome.stale || revision !== this.revision) continue;

      this.completedRevision = revision;
      this.lastResult = outcome.result;
      this.nextRefreshDelayMs = this.#record(outcome.result);
      if (notify) {
        try {
          await this.onResult?.(outcome.result);
        } catch (error) {
          console.error(`[models] 模型目录刷新回调失败: ${error.message}`);
        }
      }
    }
  }

  async #refresh(revision, {
    executable: requestedExecutable,
    clientVersion: requestedClientVersion,
    originator: requestedOriginator,
    force,
  }) {
    let account = null;
    let credentialKey = null;
    try {
      account = await this.#currentAccount();
      credentialKey = credentialSignature(account);
      let executable = requestedExecutable ?? await this.getExecutable?.() ?? null;
      if (!executable) executable = await resolveCodexCliExecutable();
      const identity = await this.#catalogIdentity({
        account,
        executable,
        clientVersion: requestedClientVersion,
        originator: requestedOriginator,
      });
      await this.#applyCatalogScope(account, identity);
      const refresh = await this.fetchModelCatalog({
        executable,
        clientVersion: identity.clientVersion,
        originator: identity.originator,
        force,
        account,
        dataDir: this.contextManager.dataDir,
      });
      if (await this.#stale(revision, credentialKey)) return { stale: true };

      const changed = refresh.catalog
        ? (await this.contextManager.useOfficialCatalog(refresh.catalog, {
            source: refresh.source === "bundled"
              ? "official-bundled"
              : refresh.source === "cache" ? "official-cache" : "official-online",
          })).changed
        : false;
      if (await this.#stale(revision, credentialKey)) return { stale: true };
      return { stale: false, result: catalogResult({ refresh, account, changed }) };
    } catch (error) {
      if (credentialKey && await this.#stale(revision, credentialKey)) {
        return { stale: true };
      }
      const result = await this.#failureResult(error, account);
      return await this.#stale(revision, credentialKey)
        ? { stale: true }
        : { stale: false, result };
    }
  }

  async #catalogIdentity({ account, executable, clientVersion, originator }) {
    if (account?.authMode !== "oauth" && account?.authMode !== "apiKey") {
      return { clientVersion: null, originator: null };
    }
    const requestedVersion = parseCodexVersion(clientVersion)?.raw ?? null;
    const resolvedOriginator = account.authMode === "oauth"
      ? normalizeCatalogOriginator(originator ?? this.getOriginator())
      : null;
    if (requestedVersion) {
      return { clientVersion: requestedVersion, originator: resolvedOriginator };
    }
    try {
      return {
        clientVersion: await this.readRuntimeVersion(executable),
        originator: resolvedOriginator,
      };
    } catch (error) {
      await this.#applyCatalogScope(account, {
        clientVersion: `unresolved:${hash(executable)}`,
        originator: resolvedOriginator,
      });
      throw error;
    }
  }

  async #applyCatalogScope(account, identity) {
    const scopeKey = catalogScopeSignature(account, identity);
    await this.contextManager.setModelCatalogScope({
      allowNativeCatalog: account == null,
      resetTransient: scopeKey !== this.activeCatalogScopeKey,
    });
    this.activeCatalogScopeKey = scopeKey;
  }

  async #stale(revision, credentialKey) {
    if (this.closed || revision !== this.revision) return true;
    let current;
    try {
      current = await this.#currentAccount();
    } catch {
      return false;
    }
    if (credentialSignature(current) === credentialKey) return false;
    this.#invalidate("credentials");
    return true;
  }

  #currentAccount() {
    return this.accountManager?.getCurrentModelCatalogAccount?.() ?? Promise.resolve(null);
  }

  async #failureResult(error, account) {
    const fallback = account?.authMode === "oauth"
      ? error.catalogFallbackCatalog
      : null;
    const message = error?.message ?? String(error);
    console.warn(fallback || account?.authMode !== "oauth"
      ? `[models] 官方模型目录刷新失败，继续使用上次可用目录：${message}`
      : `[models] 官方模型目录刷新失败，未使用其他账号的共享目录：${message}`);
    if (fallback) {
      try {
        await this.contextManager.useOfficialCatalog(fallback, {
          source: "official-cache",
        });
      } catch (applyError) {
        console.error(`[models] 保留现有模型目录失败: ${applyError.message}`);
      }
    }
    return catalogResult({ error, account, source: fallback ? "cache" : null });
  }

  #record(result) {
    if (result?.officialCatalogDeferred) {
      this.failureCount = 0;
      return Number.isFinite(result.officialCatalogRetryAfterMs) &&
        result.officialCatalogRetryAfterMs >= 0
        ? result.officialCatalogRetryAfterMs
        : CREDENTIAL_RETRY_MS;
    }
    if (!result?.officialCatalogError) {
      this.failureCount = 0;
      return MODEL_CATALOG_REFRESH_MS;
    }
    this.failureCount++;
    return nextModelCatalogRefreshDelay({
      failureCount: this.failureCount,
      retryable: result.officialCatalogRetryable !== false,
      retryAfterMs: result.officialCatalogRetryAfterMs,
    });
  }

  #schedule(delayMs) {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.closed || !this.schedulerStarted || this.busy || delayMs == null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.#runScheduledRefresh();
    }, delayMs);
    this.timer?.unref?.();
  }

  async #runScheduledRefresh() {
    if (this.closed || !this.schedulerStarted) return;
    try {
      if (!(await this.canRunScheduledRefresh())) {
        this.#schedule(BUSY_RETRY_MS);
        return;
      }
      await this.request({ reason: "periodic" });
    } catch (error) {
      if (!this.closed) {
        console.error(`[models] 官方模型目录刷新失败: ${error.message}`);
        this.#schedule(BUSY_RETRY_MS);
      }
    }
  }
}

export function nextModelCatalogRefreshDelay({
  failureCount = 0,
  retryable = true,
  retryAfterMs = null,
} = {}) {
  if (!retryable) return null;
  if (failureCount <= 0) return MODEL_CATALOG_REFRESH_MS;
  const backoff = FAILURE_RETRY_MS[
    Math.min(failureCount - 1, FAILURE_RETRY_MS.length - 1)
  ];
  return Number.isFinite(retryAfterMs) && retryAfterMs >= 0
    ? Math.max(backoff, retryAfterMs)
    : backoff;
}

function catalogResult({ refresh = null, error = null, account = null,
  changed = false, source = refresh?.source ?? null }) {
  const retryAfterMs = error?.catalogRetryAfterMs ?? refresh?.retryAfterMs;
  return {
    officialCatalogChanged: error ? false : changed,
    officialCatalogChecked: !error && refresh?.source === "online",
    officialCatalogSource: source,
    officialCatalogError: error ? error.message ?? String(error) : null,
    officialCatalogDeferred: !error && refresh?.deferred === true,
    officialCatalogRetryable: error?.catalogRetryable !== false,
    officialCatalogRetryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : null,
    officialAuthMode: account?.authMode ?? null,
  };
}

function accountScopeSignature(account) {
  if (account?.authMode === "apiKey") {
    return `api-key:${hash(account.openaiApiKey ?? "")}`;
  }
  if (account?.authMode !== "oauth") return "none";
  const recordId = String(account.id ?? "").trim();
  const workspaceId = String(account.accountId ?? "").trim();
  if (recordId || workspaceId) {
    return JSON.stringify(["oauth", recordId || null, workspaceId || null]);
  }
  return `oauth-token:${hash(account.tokens?.idToken || account.tokens?.accessToken || "")}`;
}

function catalogScopeSignature(account, identity = {}) {
  return JSON.stringify([
    accountScopeSignature(account),
    identity.clientVersion ?? null,
    identity.originator ?? null,
  ]);
}

function credentialSignature(account) {
  if (account?.authMode === "apiKey") return `api-key:${hash(account.openaiApiKey ?? "")}`;
  if (account?.authMode !== "oauth") return "none";
  return `${accountScopeSignature(account)}:${hash(account.tokens?.accessToken ?? "")}`;
}

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}
