import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { watch } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Worker } from "node:worker_threads";

import { defaultAccountDataDir } from "./platform.mjs";
import {
  accumulateTokenCost,
  resolveContextTier,
  TokenPricingManager,
} from "./token-pricing.mjs";

const CACHE_VERSION = 9;
const DISCOVERY_INTERVAL_MS = 5_000;
const MAX_VIEW_TURNS = 120;
const MAX_STORED_TURNS = 2_000;
const MAX_TRACKED_ROLLOUT_STATES = 256;
const MAX_HISTORICAL_THREADS = 2_048;
const MAX_HISTORICAL_SEGMENTS = 128;
const READ_CHUNK_BYTES = 1024 * 1024;
const COST_CACHE_VERSION = 2;
const ROLLOUT_PARSER_VERSION = 3;
const MAX_SEEN_EVENT_IDS = 50_000;
const CACHE_PERSIST_DELAY_MS = 10_000;
const UNKNOWN_ROLLOUT_CHECK_INTERVAL_MS = 10_000;
const UNKNOWN_ROLLOUT_RECONCILE_CONCURRENCY = 4;
const ACTIVE_THREAD_HINT_TTL_MS = 5 * 60 * 1000;
const MAX_ROLLOUT_METADATA_BYTES = 4 * 1024 * 1024;
const TOKEN_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
];
const TERMINAL_TURN_STATUSES = new Set(["completed", "interrupted", "failed"]);
const EVENT_WATCH_DEBOUNCE_MS = 80;
const MODEL_SOURCE_PRIORITY = Object.freeze({
  thread: 1,
  "thread-settings": 1,
  "thread-response": 1,
  "thread-request": 2,
  "turn-request": 3,
  "turn-started": 3,
  usage: 3,
  completed: 3,
  "turn-response": 5,
  "turn-context": 4,
  rerouted: 6,
});

const ROLLOUT_WORKER_SOURCE = String.raw`
const { parentPort } = require("node:worker_threads");
const { open, stat } = require("node:fs/promises");

const READ_CHUNK_BYTES = 1024 * 1024;
const ROLLOUT_RECORD_BATCH_SIZE = 256;

parentPort.on("message", async (request) => {
  try {
    const result = await readRollout(request, (records) => {
      if (records.length > 0) parentPort.postMessage({ id: request.id, type: "batch", records });
    });
    parentPort.postMessage({ id: request.id, type: "done", ok: true, ...result });
  } catch (error) {
    parentPort.postMessage({
      id: request.id,
      ok: false,
      error: error?.stack || error?.message || String(error),
    });
  }
});

async function readRollout(request, emitBatch) {
  const path = String(request.path || "");
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (error.code === "ENOENT") return { missing: true, records: [] };
    throw error;
  }

  const reconcile = Boolean(request.reconcile);
  let offset = reconcile ? 0 : positiveInteger(request.offset);
  let pending = reconcile ? "" : String(request.pending || "");
  let currentTurnId = reconcile ? null : nonEmptyString(request.currentTurnId);
  let pendingModel = reconcile ? null : nonEmptyString(request.pendingModel);
  let reset = false;
  if (info.size < offset) {
    offset = 0;
    pending = "";
    currentTurnId = null;
    pendingModel = null;
    reset = true;
    parentPort.postMessage({ id: request.id, type: "reset" });
  }
  if (info.size === offset) {
    return { offset, pending, currentTurnId, pendingModel, reset, records: [] };
  }

  let records = [];
  const handle = await open(path, "r");
  try {
    while (offset < info.size) {
      const length = Math.min(READ_CHUNK_BYTES, info.size - offset);
      const buffer = Buffer.allocUnsafe(length);
      const result = await handle.read(buffer, 0, length, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
      const lines = (pending + buffer.subarray(0, result.bytesRead).toString("utf8"))
        .split(/\r?\n/);
      pending = lines.pop() || "";
      for (const line of lines) {
        const record = parseRecord(line);
        if (!record) continue;
        const simplified = simplifyRecord(record, currentTurnId, pendingModel);
        currentTurnId = simplified.currentTurnId;
        pendingModel = simplified.pendingModel;
        if (simplified.record) {
          records.push(simplified.record);
          if (records.length >= ROLLOUT_RECORD_BATCH_SIZE) {
            emitBatch(records);
            records = [];
          }
        }
      }
    }
  } finally {
    await handle.close();
  }
  emitBatch(records);
  return { offset, pending, currentTurnId, pendingModel, reset };
}

function simplifyRecord(record, currentTurnId, pendingModel) {
  const payload = record.payload;
  if (record.type === "turn_context" && payload?.turn_id) {
    const turnId = String(payload.turn_id);
    return {
      currentTurnId: turnId,
      pendingModel,
      record: {
        timestamp: record.timestamp,
        type: "turn_context",
        payload: { turn_id: turnId, model: payload.model },
      },
    };
  }
  if (record.type === "response_item") {
    const turnId = payload?.internal_chat_message_metadata_passthrough?.turn_id;
    return {
      currentTurnId: turnId ? String(turnId) : currentTurnId,
      pendingModel,
      record: null,
    };
  }
  if (record.type !== "event_msg" || !payload) {
    return { currentTurnId, pendingModel, record: null };
  }
  if (payload.type === "thread_settings_applied") {
    const model = nonEmptyString(payload.thread_settings?.model) ?? pendingModel;
    return {
      currentTurnId,
      pendingModel: model,
      record: {
        timestamp: record.timestamp,
        type: "event_msg",
        payload: { type: "thread_settings_applied", model },
      },
    };
  }
  if (payload.type === "task_started") {
    const turnId = payload.turn_id ? String(payload.turn_id) : currentTurnId;
    const model = nonEmptyString(payload.model) ?? pendingModel;
    return {
      currentTurnId: turnId,
      pendingModel: model,
      record: turnId
        ? {
            timestamp: record.timestamp,
            type: "event_msg",
            payload: { type: "task_started", turn_id: turnId, model },
          }
        : null,
    };
  }
  if (payload.type === "turn_aborted") {
    const turnId = payload.turn_id ? String(payload.turn_id) : currentTurnId;
    return {
      currentTurnId: turnId,
      pendingModel,
      record: turnId
        ? {
            timestamp: record.timestamp,
            type: "event_msg",
            payload: { type: "turn_aborted", turn_id: turnId, reason: payload.reason },
          }
        : null,
    };
  }
  if (payload.type === "token_count" && currentTurnId) {
    return {
      currentTurnId,
      pendingModel,
      record: {
        timestamp: record.timestamp,
        type: "event_msg",
        payload: { type: "token_count", info: payload.info },
      },
    };
  }
  if (payload.type === "task_complete" && currentTurnId) {
    return {
      currentTurnId,
      pendingModel,
      record: {
        timestamp: record.timestamp,
        type: "event_msg",
        payload: { type: "task_complete" },
      },
    };
  }
  return { currentTurnId, pendingModel, record: null };
}

function parseRecord(line) {
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function nonEmptyString(value) {
  const text = String(value || "").trim();
  return text || null;
}
`;

export class TokenUsageManager {
  constructor({
    codexHome = resolveCodexHome(),
    dataDir = defaultAccountDataDir(),
    discoveryIntervalMs = DISCOVERY_INTERVAL_MS,
    maxViewTurns = MAX_VIEW_TURNS,
    pricingManager = new TokenPricingManager(),
  } = {}) {
    this.codexHome = codexHome;
    this.eventPath = join(dataDir, "token-usage-events.jsonl");
    this.cachePath = join(dataDir, "token-usage-cache.json");
    this.discoveryIntervalMs = discoveryIntervalMs;
    this.maxViewTurns = maxViewTurns;
    this.pricingManager = pricingManager;
    this.eventState = { offset: 0, pending: "" };
    this.seenEventIds = new Set();
    this.fileStates = new Map();
    this.turns = new Map();
    this.historicalSegmentsByThread = new Map();
    this.historicalCostCache = new Map();
    this.activeThreadId = null;
    this.activeThreadHint = false;
    this.activeThreadHintAt = 0;
    this.rolloutPathsByThread = new Map();
    this.rolloutMetadataByPath = new Map();
    this.rolloutMetadataByThread = new Map();
    this.rolloutReconcileRequested = false;
    this.rolloutReconcilePromise = null;
    this.rolloutReadPromises = new Map();
    this.cachePersistPromise = null;
    this.cachePersistTimer = null;
    this.cacheRevision = 0;
    this.lastCachePersistAt = 0;
    this.turnCostCache = new Map();
    this.lastDiscoveryAt = 0;
    this.refreshPromise = null;
    this.initializationPromise = null;
    this.initializing = false;
    this.initialized = false;
    this.cacheDirty = false;
    this.error = null;
    this.viewModelCache = null;
    this.viewModelDirty = true;
    this.rolloutWorker = null;
    this.rolloutWorkerRequestId = 0;
    this.rolloutWorkerRequests = new Map();
    this.eventWatcher = null;
    this.eventWatchTimer = null;
    this.unknownRolloutCheckTimer = null;
    this.lastUnknownRolloutCheckAt = 0;
    this.loggedSubagentModelTransitions = new Set();
    this.changeListeners = new Set();
    this.closed = false;
    this.removePricingListener = this.pricingManager.onChange?.(() => {
      this.#invalidateViewModel();
      if (this.initialized && !this.initializing) this.#notifyChange(this.getViewModel());
    }) ?? (() => {});
  }

  onChange(listener) {
    if (typeof listener !== "function") return () => {};
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  initialize() {
    if (this.initializationPromise) return this.initializationPromise;
    this.initializing = true;
    const task = (async () => {
      await this.pricingManager.initialize();
      try {
        await this.#loadCache();
      } catch (error) {
        this.#discardLoadedCache();
        console.error(
          `[token-usage] Token 缓存恢复失败，已忽略缓存并继续实时监听：${error?.stack || error}`,
        );
      }
      if (this.closed) return this.getViewModel();
      this.#startEventWatcher();
      await this.#refreshOnce({ forceDiscovery: true });
      this.initialized = true;
      const viewModel = this.getViewModel();
      this.#notifyChange(viewModel);
      return viewModel;
    })()
      .catch((error) => {
        this.error = error.message;
        this.#invalidateViewModel();
        console.error(`[token-usage] 初始化失败: ${error.message}`);
        return this.getViewModel();
      })
      .finally(() => {
        this.initializing = false;
        this.#invalidateViewModel();
        if (this.initializationPromise === task) this.initializationPromise = null;
      });
    this.initializationPromise = task;
    return task;
  }

  async refresh({ forceDiscovery = false, notify = false } = {}) {
    if (this.closed) return this.getViewModel();
    if (this.initializing) {
      const viewModel = await this.initializationPromise;
      if (notify) this.#notifyChange(viewModel);
      return viewModel;
    }
    if (this.refreshPromise) {
      const viewModel = await this.refreshPromise;
      if (notify) this.#notifyChange(viewModel);
      return viewModel;
    }
    const task = this.#refreshOnce({ forceDiscovery })
      .catch((error) => {
        this.error = error.message;
        console.error(`[token-usage] ${error.message}`);
        return this.getViewModel();
      })
      .then((viewModel) => {
        if (notify) this.#notifyChange(viewModel);
        return viewModel;
      })
      .finally(() => {
        if (this.refreshPromise === task) this.refreshPromise = null;
      });
    this.refreshPromise = task;
    return task;
  }

  getViewModel() {
    if (!this.viewModelDirty && this.viewModelCache) return this.viewModelCache;
    const cumulativeCosts = new Map();
    for (const [threadId, history] of this.historicalSegmentsByThread) {
      const revision = positiveInteger(history.costRevision);
      const cached = this.historicalCostCache.get(threadId);
      const historyCost = cached?.revision === revision
        ? cached.cost
        : history.segments.length > 0
          ? calculateTurnCost({ segments: history.segments }, this.pricingManager)
          : null;
      this.historicalCostCache.set(threadId, { revision, cost: historyCost });
      const viewCost = this.pricingManager.toViewModel(historyCost);
      const historyPendingTurns = positiveInteger(history.pendingTurns) +
        (history.segments.length > 0 && !historyCost?.available ? 1 : 0);
      cumulativeCosts.set(threadId, {
        totalCny: historyCost?.available ? positiveNumber(viewCost.totalCny) : 0,
        pendingTurns: historyPendingTurns,
      });
    }
    const mappedTurns = buildDisplayTurns([...this.turns.values()])
      // `activeThreadId` identifies the rollout file currently being tailed;
      // it is not a single-session view of the app. Multiple threads can be
      // running at the same time, so every live turn, including a turn still
      // waiting for its first usage event, must remain
      // available to the widget regardless of which thread was started last.
      .filter((turn) => turn.totalTokens > 0 ||
        (["event", "subagent"].includes(turn.source) && turn.updatedAt > 0))
      .sort((left, right) => left.updatedAt - right.updatedAt)
      .map((turn) => {
        const hasUsage = turn.totalTokens > 0;
        const rawCost = hasUsage ? this.#getCachedTurnCost(turn) : null;
        const cost = this.pricingManager.toViewModel(rawCost);
        const taskCost = cumulativeCosts.get(turn.taskKey) ?? {
          totalCny: 0,
          pendingTurns: 0,
        };
        if (hasUsage && cost.available) taskCost.totalCny += positiveNumber(cost.totalCny);
        else if ((hasUsage && !cost.available) || turn.completed) taskCost.pendingTurns += 1;
        cumulativeCosts.set(turn.taskKey, taskCost);
        const {
          taskKey: _taskKey,
          source: _source,
          modelSource: _modelSource,
          segments: _segments,
          rolloutPath: _rolloutPath,
          generationStartAt: _generationStartAt,
          costRevision: _costRevision,
          ...publicTurn
        } = turn;
        return {
          ...publicTurn,
          cost: {
            ...cost,
            cumulativeAvailable: taskCost.pendingTurns === 0,
            cumulativeCny: taskCost.totalCny,
            cumulativePendingTurns: taskCost.pendingTurns,
          },
        };
      });
    const subagentRootByThread = new Map();
    for (const metadata of this.rolloutMetadataByThread.values()) {
      if (metadata.isSubagent && metadata.threadId && metadata.rootThreadId) {
        subagentRootByThread.set(metadata.threadId, metadata.rootThreadId);
      }
    }
    for (const turn of this.turns.values()) {
      if (turn.isSubagent && turn.threadId && turn.rootThreadId) {
        subagentRootByThread.set(turn.threadId, turn.rootThreadId);
      }
    }
    const subagentCumulativeByRoot = new Map();
    for (const [threadId, rootThreadId] of subagentRootByThread) {
      const subagentCost = cumulativeCosts.get(threadId);
      if (!subagentCost) continue;
      const rootCost = subagentCumulativeByRoot.get(rootThreadId) ?? {
        totalCny: 0,
        pendingTurns: 0,
      };
      rootCost.totalCny += positiveNumber(subagentCost.totalCny);
      rootCost.pendingTurns += positiveInteger(subagentCost.pendingTurns);
      subagentCumulativeByRoot.set(rootThreadId, rootCost);
    }
    for (const turn of mappedTurns) {
      let cumulativeCost = null;
      if (turn.isSubagentSummary) {
        cumulativeCost = cumulativeCosts.get(turn.threadId) ?? null;
      } else if (!turn.isSubagent) {
        const subagentCost = subagentCumulativeByRoot.get(turn.rootThreadId || turn.threadId);
        if (subagentCost) {
          cumulativeCost = {
            totalCny: positiveNumber(turn.cost.cumulativeCny) +
              positiveNumber(subagentCost.totalCny),
            pendingTurns: positiveInteger(turn.cost.cumulativePendingTurns) +
              positiveInteger(subagentCost.pendingTurns),
          };
        }
      }
      if (!cumulativeCost) continue;
      turn.cost.cumulativeAvailable = positiveInteger(cumulativeCost.pendingTurns) === 0;
      turn.cost.cumulativeCny = positiveNumber(cumulativeCost.totalCny);
      turn.cost.cumulativePendingTurns = positiveInteger(cumulativeCost.pendingTurns);
    }
    // Keep simultaneous in-progress turns, but cap both live and completed
    // views so a missed completion event cannot grow the UI forever.
    const liveTurns = mappedTurns
      .filter((turn) => !turn.completed)
      .slice(-this.maxViewTurns);
    const recentTurns = mappedTurns
      .filter((turn) => turn.completed)
      .slice(-this.maxViewTurns);
    this.viewModelCache = {
      status: this.initializing ? "loading" : this.error ? "error" : "ready",
      error: this.error,
      turns: [...recentTurns, ...liveTurns]
        .sort((left, right) => left.updatedAt - right.updatedAt),
    };
    this.viewModelDirty = false;
    return this.viewModelCache;
  }

  close() {
    this.closed = true;
    clearTimeout(this.eventWatchTimer);
    clearTimeout(this.cachePersistTimer);
    clearTimeout(this.unknownRolloutCheckTimer);
    this.eventWatchTimer = null;
    this.cachePersistTimer = null;
    this.unknownRolloutCheckTimer = null;
    this.eventWatcher?.close();
    this.eventWatcher = null;
    this.removePricingListener();
    this.removePricingListener = () => {};
    this.changeListeners.clear();
    this.#closeRolloutWorker();
    this.rolloutReconcileRequested = false;
    this.rolloutReadPromises.clear();
    this.rolloutMetadataByPath.clear();
    this.rolloutMetadataByThread.clear();
    this.loggedSubagentModelTransitions.clear();
    this.historicalCostCache.clear();
    // Keep cache state alive until an in-flight asynchronous persistence has
    // finished; clearing these maps here could make that write serialize an
    // empty cache during injector shutdown.
    this.#invalidateViewModel();
  }

  #invalidateViewModel() {
    this.viewModelDirty = true;
  }

  #notifyChange(viewModel) {
    for (const listener of this.changeListeners) {
      try {
        listener(viewModel);
      } catch (error) {
        console.error(`[token-usage] 变更监听器失败: ${error.message}`);
      }
    }
  }

  #startEventWatcher() {
    if (this.closed || this.eventWatcher) return;
    try {
      const watcher = watch(
        dirname(this.eventPath),
        { persistent: false },
        (_eventType, fileName) => {
          if (fileName && String(fileName) !== basename(this.eventPath)) return;
          clearTimeout(this.eventWatchTimer);
          this.eventWatchTimer = setTimeout(() => {
            this.eventWatchTimer = null;
            void this.refresh({ notify: true }).catch((error) => {
              console.error(`[token-usage] 事件驱动刷新失败: ${error.message}`);
            });
          }, EVENT_WATCH_DEBOUNCE_MS);
        },
      );
      this.eventWatcher = watcher;
      watcher.on("error", (error) => {
        if (this.eventWatcher === watcher) {
          this.eventWatcher = null;
          clearTimeout(this.eventWatchTimer);
          this.eventWatchTimer = null;
          watcher.close();
        }
        console.error(`[token-usage] Token 事件监听失败: ${error?.stack || error}`);
      });
    } catch (error) {
      console.error(`[token-usage] 无法监听 Token 事件: ${error?.stack || error}`);
    }
  }

  async #refreshOnce({ forceDiscovery }) {
    this.#startEventWatcher();
    // Exchange-rate refresh is deliberately detached from usage parsing. A
    // cached rate is sufficient for the current view; the pricing listener
    // invalidates CNY values when a newer rate arrives.
    void Promise.resolve(this.pricingManager.refreshExchangeRate()).catch((error) => {
      console.error(`[token-usage] 汇率刷新失败: ${error.message}`);
    });
    this.#invalidateViewModel();
    await this.#readUsageEvents();
    const now = Date.now();
    if (forceDiscovery || now - this.lastDiscoveryAt >= this.discoveryIntervalMs) {
      await this.#refreshRolloutCatalog();
      this.lastDiscoveryAt = now;
    }
    await this.#ensureActiveRollout();
    const activeState = this.activeThreadId
      ? this.fileStates.get(this.activeThreadId)
      : null;
    if (activeState) await this.#readAppendedRollout(activeState);
    if (this.#applySubagentMetadataToTurns()) {
      this.#markCacheDirty();
      this.#invalidateViewModel();
    }
    this.#pruneCompletedTurns();
    this.#queueCachePersist();
    this.error = null;
    const viewModel = this.getViewModel();
    if (!this.closed) this.#scheduleUnknownRolloutReconciliation();
    return viewModel;
  }

  async #loadCache() {
    const cached = await readJson(this.cachePath);
    const cachedVersion = positiveInteger(cached?.version);
    if (!cached || cachedVersion !== CACHE_VERSION) return;
    this.eventState = {
      offset: positiveInteger(cached.eventState?.offset),
      pending: String(cached.eventState?.pending ?? ""),
    };
    this.seenEventIds = new Set(Array.isArray(cached.seenEventIds)
      ? cached.seenEventIds.map(String).slice(-MAX_SEEN_EVENT_IDS)
      : []);
    this.activeThreadId = nonEmptyString(cached.activeThreadId);
    this.activeThreadHint = Boolean(cached.activeThreadHint);
    this.activeThreadHintAt = positiveNumber(cached.activeThreadHintAt);
    for (const value of Array.isArray(cached.turns) ? cached.turns : []) {
      const turn = normalizeCachedTurn(value);
      if (turn) this.turns.set(turn.turnId, turn);
    }
    for (const value of Array.isArray(cached.fileStates) ? cached.fileStates : []) {
      const state = normalizeCachedFileState(value);
      if (state) this.fileStates.set(state.threadId, state);
    }
    if (this.fileStates.size > MAX_TRACKED_ROLLOUT_STATES) {
      this.#pruneRolloutStates(null);
      this.#markCacheDirty();
    }
    for (const value of Array.isArray(cached.historicalSegmentsByThread)
      ? cached.historicalSegmentsByThread
      : []) {
      const history = normalizeCachedHistory(value);
      if (history) this.historicalSegmentsByThread.set(history.threadId, history);
    }
    if (this.#pruneHistoricalThreads()) this.#markCacheDirty();
    if (cachedVersion !== CACHE_VERSION) this.#markCacheDirty();
    this.#invalidateViewModel();
  }

  #discardLoadedCache() {
    this.eventState = { offset: 0, pending: "" };
    this.seenEventIds.clear();
    this.fileStates.clear();
    this.turns.clear();
    this.historicalSegmentsByThread.clear();
    this.historicalCostCache.clear();
    this.turnCostCache.clear();
    this.activeThreadId = null;
    this.activeThreadHint = false;
    this.activeThreadHintAt = 0;
    this.#markCacheDirty();
    this.#invalidateViewModel();
  }

  #getCachedTurnCost(turn) {
    const revision = positiveInteger(turn.costRevision);
    const cached = this.turnCostCache.get(turn.turnId);
    if (cached?.version === COST_CACHE_VERSION && cached.revision === revision) {
      return cached.cost;
    }
    const cost = calculateTurnCost(turn, this.pricingManager);
    this.turnCostCache.set(turn.turnId, {
      version: COST_CACHE_VERSION,
      revision,
      cost,
    });
    return cost;
  }

  async #persistCache() {
    if (this.cachePersistPromise) return this.cachePersistPromise;
    const task = (async () => {
      if (!this.cacheDirty) return;
      const revision = this.cacheRevision;
      await writeJsonAtomic(this.cachePath, this.#cacheSnapshot());
      this.lastCachePersistAt = Date.now();
      if (this.cacheRevision === revision) this.cacheDirty = false;
    })().finally(() => {
      if (this.cachePersistPromise === task) this.cachePersistPromise = null;
      if (this.cacheDirty && !this.closed) this.#queueCachePersist();
    });
    this.cachePersistPromise = task;
    return task;
  }

  #queueCachePersist() {
    if (!this.cacheDirty || this.cachePersistTimer || this.closed) return;
    if (this.cachePersistPromise) return;
    const delay = Math.max(
      0,
      CACHE_PERSIST_DELAY_MS - (Date.now() - this.lastCachePersistAt),
    );
    this.cachePersistTimer = setTimeout(() => {
      this.cachePersistTimer = null;
      void this.#persistCache().catch((error) => {
        console.error(`[token-usage] 保存 Token 缓存失败: ${error.message}`);
      });
    }, delay);
  }

  async flush() {
    clearTimeout(this.cachePersistTimer);
    this.cachePersistTimer = null;
    while (this.initializationPromise || this.refreshPromise || this.rolloutReconcilePromise ||
      this.cachePersistPromise || this.cacheDirty) {
      const inFlight = [
        this.initializationPromise,
        this.refreshPromise,
        this.rolloutReconcilePromise,
      ].filter(Boolean);
      if (inFlight.length > 0) {
        await Promise.allSettled(inFlight);
        continue;
      }
      if (this.cachePersistPromise) {
        await this.cachePersistPromise;
      } else {
        await this.#persistCache();
      }
    }
  }

  #cacheSnapshot() {
    return {
      version: CACHE_VERSION,
      eventState: this.eventState,
      seenEventIds: [...this.seenEventIds],
      activeThreadId: this.activeThreadId,
      activeThreadHint: this.activeThreadHint,
      activeThreadHintAt: this.activeThreadHintAt,
      fileStates: [...this.fileStates.values()],
      historicalSegmentsByThread: [...this.historicalSegmentsByThread.values()],
      turns: [...this.turns.values()].filter((turn) => turn.totalTokens > 0),
    };
  }

  #markCacheDirty() {
    this.cacheDirty = true;
    this.cacheRevision += 1;
  }

  async #readUsageEvents() {
    let info;
    try {
      info = await stat(this.eventPath);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (info.size < this.eventState.offset) {
      this.eventState = { offset: 0, pending: "" };
      this.seenEventIds.clear();
      for (const [turnId, turn] of this.turns) {
        if (turn.source === "event") {
          this.turns.delete(turnId);
          this.turnCostCache.delete(turnId);
        }
      }
      this.#markCacheDirty();
      this.#invalidateViewModel();
    }
    await readAppendedChunks(this.eventPath, this.eventState, (line) => {
      if (!line) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      this.#processUsageEvent(event);
    });
  }

  #processUsageEvent(event) {
    const eventId = nonEmptyString(event?.eventId);
    if (!eventId || this.seenEventIds.has(eventId)) return;
    this.seenEventIds.add(eventId);
    while (this.seenEventIds.size > MAX_SEEN_EVENT_IDS) {
      const oldest = this.seenEventIds.values().next().value;
      if (oldest == null) break;
      this.seenEventIds.delete(oldest);
    }
    this.#markCacheDirty();
    this.#invalidateViewModel();
    const threadId = nonEmptyString(event.threadId);
    if (!threadId) return;
    const model = nonEmptyString(event.model);
    const updatedAt = positiveNumber(event.recordedAt) || Date.now();

    if (event.type === "thread-active") {
      this.activeThreadId = threadId;
      this.activeThreadHint = true;
      this.activeThreadHintAt = Date.now();
      return;
    }

    const turnId = nonEmptyString(event.turnId);
    if (!turnId) return;
    if (event.type === "turn-started") {
      const turn = this.turns.get(turnId) ?? emptyTurn(turnId, threadId, "event");
      turn.source = "event";
      if (!turn.startedAt) turn.startedAt = updatedAt;
      if (model) {
        fillUnknownSegmentModels(turn, model, event.modelSource ?? "turn-started");
        setTurnModel(turn, model, event.modelSource ?? "turn-started");
      }
      turn.updatedAt = updatedAt;
      this.turns.set(turnId, turn);
      return;
    }
    if (event.type === "usage") {
      const last = normalizeProtocolUsage(event.tokenUsage?.last);
      if (!last) return;
      let turn = this.turns.get(turnId);
      if (!turn) turn = emptyTurn(turnId, threadId, "event");
      // Relay events are authoritative for live turns, but a rollout record
      // may have been loaded first. Preserve its counters and append only a
      // genuinely newer event delta instead of replacing the whole turn.
      turn.source = "event";
      if (!turn.startedAt) turn.startedAt = updatedAt;
      const modelSource = event.modelSource ?? "thread";
      const incomingTotal = positiveNumber(event.tokenUsage?.total?.totalTokens);
      const previousTotal = positiveNumber(turn.cumulativeTotalTokens);
      const previousOutputTokens = positiveNumber(turn.outputTokens);
      if (model) {
        // A reroute starts a new model segment. Unknown tokens before that
        // boundary must stay unresolved instead of being relabeled with the
        // new model.
        if (modelSource !== "rerouted") {
          fillUnknownSegmentModels(turn, model, modelSource);
        }
        setTurnModel(turn, model, modelSource);
      }
      if (incomingTotal <= 0 || incomingTotal > previousTotal) {
        // The event can carry a stale lower-priority model after a reroute.
        // Price the delta with the model that won the source-priority check,
        // rather than relabeling a post-reroute segment with that stale value.
        addUsage(
          turn,
          last,
          turn.model || model,
          turn.modelSource || modelSource,
        );
        if (turn.outputTokens > previousOutputTokens) {
          updateTotalGenerationRate(turn, updatedAt);
        }
      }
      turn.cumulativeTotalTokens = Math.max(previousTotal, incomingTotal);
      const modelContextWindow = positiveNumber(event.tokenUsage?.modelContextWindow);
      if (modelContextWindow > 0) turn.modelContextWindow = modelContextWindow;
      turn.updatedAt = updatedAt;
      this.turns.set(turnId, turn);
      return;
    }

    if (event.type === "turn-completed") {
      const turn = this.turns.get(turnId) ?? emptyTurn(turnId, threadId, "event");
      turn.source = "event";
      if (!turn.startedAt) turn.startedAt = updatedAt;
      if (model && event.modelSource !== "rerouted") {
        fillUnknownSegmentModels(turn, model, event.modelSource ?? "completed");
      }
      setTurnModel(turn, model, event.modelSource ?? "thread");
      turn.status = nonEmptyString(event.status);
      turn.completed = TERMINAL_TURN_STATUSES.has(turn.status);
      turn.updatedAt = updatedAt;
      this.turns.set(turnId, turn);
    }
  }

  async #refreshRolloutCatalog() {
    const paths = await collectRolloutFiles(join(this.codexHome, "sessions"), 4);
    this.rolloutPathsByThread.clear();
    const discoveredPaths = new Set(paths);
    for (const path of this.rolloutMetadataByPath.keys()) {
      if (!discoveredPaths.has(path)) this.rolloutMetadataByPath.delete(path);
    }
    const metadataEntries = await Promise.all(paths.map(async (path) => {
      let metadata = this.rolloutMetadataByPath.get(path);
      if (!metadata) {
        metadata = await readRolloutSessionMetadata(path);
        if (metadata) this.rolloutMetadataByPath.set(path, metadata);
      }
      return { path, metadata };
    }));
    this.rolloutMetadataByThread.clear();
    const discoveredThreadIds = new Set();
    for (const { path, metadata } of metadataEntries) {
      const threadId = metadata?.threadId ?? threadIdFromRolloutPath(path);
      if (threadId) {
        discoveredThreadIds.add(threadId);
        this.rolloutPathsByThread.set(threadId, path);
        if (metadata) this.rolloutMetadataByThread.set(threadId, metadata);
      }
    }
    if (this.#applySubagentMetadataToTurns()) {
      this.#markCacheDirty();
      this.#invalidateViewModel();
    }
    for (const [threadId] of this.fileStates) {
      if (!discoveredThreadIds.has(threadId)) {
        this.fileStates.delete(threadId);
        this.rolloutReadPromises.delete(threadId);
        this.#markCacheDirty();
      }
    }
    const activeHintFresh = this.activeThreadHint &&
      Date.now() - this.activeThreadHintAt < ACTIVE_THREAD_HINT_TTL_MS;
    if (this.activeThreadId && !discoveredThreadIds.has(this.activeThreadId) &&
      !activeHintFresh) {
      this.activeThreadId = null;
      this.activeThreadHint = false;
      this.activeThreadHintAt = 0;
      this.#markCacheDirty();
    }
    if (paths.length === 0) return;

    // Windows 在没有可用 App Server relay 活动事件时，通过最近写入的 rollout 文件跟踪活动会话。
    const latestPath = process.platform === "win32"
      ? await findLatestRolloutPath(paths)
      : [...paths].sort((left, right) => basename(right).localeCompare(basename(left)))[0];
    const latestThreadId = threadIdFromRolloutPath(latestPath);
    if (latestThreadId &&
      (!this.activeThreadId ||
        (process.platform === "win32" && !activeHintFresh &&
          this.activeThreadId !== latestThreadId))) {
      this.activeThreadId = latestThreadId;
      this.activeThreadHint = false;
      this.activeThreadHintAt = 0;
      this.#markCacheDirty();
    }
  }

  async #ensureActiveRollout() {
    const threadId = this.activeThreadId;
    return this.#ensureRolloutState(threadId);
  }

  #applySubagentMetadataToTurns() {
    let changed = false;
    const metadataItems = [...this.rolloutMetadataByThread.values()]
      .filter((metadata) => metadata.isSubagent)
      .sort((left, right) => left.agentDepth - right.agentDepth);
    for (const metadata of metadataItems) {
      const agentTurns = [...this.turns.values()]
        .filter((turn) => turn.threadId === metadata.threadId)
        .sort((left, right) =>
          positiveNumber(left.startedAt) - positiveNumber(right.startedAt) ||
          positiveNumber(left.updatedAt) - positiveNumber(right.updatedAt));
      if (agentTurns.length === 0) continue;
      for (let index = 1; index < agentTurns.length; index += 1) {
        const previousTurn = agentTurns[index - 1];
        const turn = agentTurns[index];
        const previousModel = nonEmptyString(previousTurn.model);
        const model = nonEmptyString(turn.model);
        if (!previousModel || !model || previousModel === model) continue;
        const transitionKey = `${metadata.threadId}\u0000${previousTurn.turnId}\u0000${turn.turnId}`;
        if (this.loggedSubagentModelTransitions.has(transitionKey)) continue;
        this.loggedSubagentModelTransitions.add(transitionKey);
        console.warn(
          `[token-usage] 子智能体模型发生变化：thread=${metadata.threadId}，` +
          `previousTurn=${previousTurn.turnId}，previousModel=${previousModel}，` +
          `turn=${turn.turnId}，model=${model}`,
        );
      }
      for (const turn of agentTurns) {
        const previousParentTurnId = nonEmptyString(turn.parentTurnId);
        const parentTurnId = this.#resolveSubagentParentTurnId(metadata, turn);
        const nextValues = {
          taskKey: metadata.threadId,
          isSubagent: true,
          rootThreadId: metadata.rootThreadId,
          parentThreadId: metadata.parentThreadId,
          parentTurnId: parentTurnId ?? "",
          agentPath: metadata.agentPath,
          agentNickname: metadata.agentNickname,
          agentDepth: metadata.agentDepth,
        };
        for (const [key, value] of Object.entries(nextValues)) {
          if (turn[key] === value) continue;
          turn[key] = value;
          changed = true;
        }
        if (parentTurnId && previousParentTurnId !== parentTurnId) {
          console.log(
            `[token-usage] 子智能体 turn 归属${previousParentTurnId ? "已修正" : "已确认"}：` +
            `thread=${metadata.threadId}，turn=${turn.turnId}，` +
            `parentTurn=${parentTurnId}，model=${nonEmptyString(turn.model) ?? "unknown"}` +
            `${previousParentTurnId ? `，previousParentTurn=${previousParentTurnId}` : ""}`,
          );
        }
      }
    }
    return changed;
  }

  #resolveSubagentParentTurnId(metadata, agentTurn) {
    const startedAt = positiveNumber(agentTurn.startedAt) || positiveNumber(agentTurn.updatedAt);
    const parentMetadata = this.rolloutMetadataByThread.get(metadata.parentThreadId);
    if (parentMetadata?.isSubagent) {
      const parentAgentTurns = [...this.turns.values()]
        .filter((turn) => turn.threadId === parentMetadata.threadId)
        .sort((left, right) =>
          (positiveNumber(right.startedAt) || positiveNumber(right.updatedAt)) -
          (positiveNumber(left.startedAt) || positiveNumber(left.updatedAt)));
      const parentAgentTurn = findTurnAtTimestamp(parentAgentTurns, startedAt);
      const inheritedParentTurnId = nonEmptyString(parentAgentTurn?.parentTurnId);
      if (inheritedParentTurnId) return inheritedParentTurnId;
    }
    const rootTurns = [...this.turns.values()]
      .filter((turn) => turn.threadId === metadata.rootThreadId && !turn.isSubagent)
      .sort((left, right) =>
        (positiveNumber(right.startedAt) || positiveNumber(right.updatedAt)) -
        (positiveNumber(left.startedAt) || positiveNumber(left.updatedAt)));
    return findTurnAtTimestamp(rootTurns, startedAt)?.turnId ?? null;
  }

  async #ensureRolloutState(threadId) {
    if (!threadId) return null;
    const existing = this.fileStates.get(threadId);
    if (existing) {
      const currentPath = this.rolloutPathsByThread.get(threadId);
      if (currentPath && existing.path !== currentPath) {
        existing.path = currentPath;
        existing.offset = 0;
        existing.pending = "";
        existing.currentTurnId = null;
        existing.threadModel = null;
        existing.modelReconciled = false;
        existing.unknownModelChecked = false;
        existing.unknownModelCheckOffset = 0;
        this.#markCacheDirty();
      }
      existing.lastUsedAt = Date.now();
      if (existing.parserVersion !== ROLLOUT_PARSER_VERSION) {
        existing.modelReconciled = false;
        existing.unknownModelChecked = false;
        existing.unknownModelCheckOffset = 0;
      }
      return existing;
    }
    let path = this.rolloutPathsByThread.get(threadId);
    if (!path) {
      await this.#refreshRolloutCatalog();
      path = this.rolloutPathsByThread.get(threadId);
    }
    if (!path) return;
    this.#pruneRolloutStates(threadId);
    const state = {
      threadId,
      path,
      offset: 0,
      pending: "",
      currentTurnId: null,
      threadModel: null,
      modelReconciled: false,
      parserVersion: 0,
      unknownModelChecked: false,
      unknownModelCheckOffset: 0,
      lastUsedAt: Date.now(),
    };
    this.fileStates.set(threadId, state);
    this.#markCacheDirty();
    return state;
  }

  async #readAppendedRollout(state) {
    const inFlight = this.rolloutReadPromises.get(state.threadId);
    if (inFlight) return inFlight;
    const task = this.#readAppendedRolloutOnce(state)
      .finally(() => {
        if (this.rolloutReadPromises.get(state.threadId) === task) {
          this.rolloutReadPromises.delete(state.threadId);
        }
      });
    this.rolloutReadPromises.set(state.threadId, task);
    return task;
  }

  async #readAppendedRolloutOnce(state) {
    state.lastUsedAt = Date.now();
    const reconcile = !state.modelReconciled;
    const previousState = {
      offset: state.offset,
      pending: state.pending,
      currentTurnId: state.currentTurnId,
      threadModel: state.threadModel,
      modelReconciled: state.modelReconciled,
      parserVersion: state.parserVersion,
    };
    if (reconcile) {
      this.#clearRolloutTurns(state.threadId, { clearHistory: true });
      state.threadModel = null;
    }
    let result;
    try {
      result = await this.#readRolloutInWorker(
        state,
        reconcile,
        (records) => {
          for (const record of records) this.#processRolloutRecord(record, state);
        },
        () => {
          // The worker announces truncation before it emits the rebuilt
          // records. Clear the old projection first so the new batches are
          // not discarded after parsing completes.
          this.#clearRolloutTurns(state.threadId, { clearHistory: true });
          state.offset = 0;
          state.pending = "";
          state.currentTurnId = null;
          state.threadModel = null;
          state.modelReconciled = false;
        },
      );
    } catch (error) {
      if (this.closed) return;
      console.error(`[token-usage] Worker 解析 rollout 失败，回退到主线程：${error.message}`);
      // A worker may have emitted a few batches before failing. Rebuild this
      // rollout from the beginning so those partial records cannot be
      // duplicated by the main-thread fallback.
      this.#clearRolloutTurns(state.threadId, { clearHistory: true });
      state.offset = 0;
      state.pending = "";
      state.currentTurnId = null;
      state.threadModel = null;
      state.modelReconciled = false;
      await this.#readAppendedRolloutOnMain(state, true);
      return;
    }
    if (result.missing) {
      this.fileStates.delete(state.threadId);
      this.#markCacheDirty();
      this.#invalidateViewModel();
      return;
    }
    state.offset = positiveInteger(result.offset);
    state.pending = String(result.pending ?? "");
    state.currentTurnId = nonEmptyString(result.currentTurnId);
    state.threadModel = nonEmptyString(result.pendingModel);
    if (reconcile || result.reset) {
      state.modelReconciled = true;
      state.parserVersion = ROLLOUT_PARSER_VERSION;
    }
    const stateChanged = previousState.offset !== state.offset ||
      previousState.pending !== state.pending ||
      previousState.currentTurnId !== state.currentTurnId ||
      previousState.threadModel !== state.threadModel ||
      previousState.modelReconciled !== state.modelReconciled ||
      previousState.parserVersion !== state.parserVersion;
    if (stateChanged) this.#markCacheDirty();
    if (stateChanged) this.#invalidateViewModel();
  }

  async #readAppendedRolloutOnMain(state, reconcile) {
    const previousCacheRevision = this.cacheRevision;
    const previousState = {
      offset: state.offset,
      pending: state.pending,
      currentTurnId: state.currentTurnId,
      threadModel: state.threadModel,
      modelReconciled: state.modelReconciled,
      parserVersion: state.parserVersion,
    };
    let info;
    try {
      info = await stat(state.path);
    } catch (error) {
      if (error.code === "ENOENT") {
        this.fileStates.delete(state.threadId);
        this.#markCacheDirty();
        return;
      }
      throw error;
    }
    if (reconcile) {
      this.#clearRolloutTurns(state.threadId, { clearHistory: true });
      state.offset = 0;
      state.pending = "";
      state.currentTurnId = null;
      state.threadModel = null;
    }
    if (info.size < state.offset) {
      this.#clearRolloutTurns(state.threadId, { clearHistory: true });
      state.offset = 0;
      state.pending = "";
      state.currentTurnId = null;
      state.threadModel = null;
      state.modelReconciled = false;
    }
    await readAppendedChunks(state.path, state, (line) => {
      if (!line) return;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        return;
      }
      this.#processRolloutRecord(record, state);
    });
    if (reconcile) {
      state.modelReconciled = true;
      state.parserVersion = ROLLOUT_PARSER_VERSION;
    }
    const stateChanged = previousState.offset !== state.offset ||
      previousState.pending !== state.pending ||
      previousState.currentTurnId !== state.currentTurnId ||
      previousState.threadModel !== state.threadModel ||
      previousState.modelReconciled !== state.modelReconciled ||
      previousState.parserVersion !== state.parserVersion;
    if (stateChanged) this.#markCacheDirty();
    if (stateChanged || this.cacheRevision !== previousCacheRevision) {
      this.#invalidateViewModel();
    }
  }

  #processRolloutRecord(record, state) {
    if (record.type === "turn_context" && record.payload?.turn_id) {
      state.currentTurnId = String(record.payload.turn_id);
      const existing = this.turns.get(state.currentTurnId);
      const turn = existing ?? emptyTurn(state.currentTurnId, state.threadId, "rollout", state.path);
      const model = nonEmptyString(record.payload.model);
      if (!turn.startedAt) turn.startedAt = parseTimestamp(record.timestamp);
      if (model) state.threadModel = model;
      setTurnModel(turn, model, "turn-context");
      fillUnknownSegmentModels(turn, model, "turn-context");
      if (turn.source === "rollout") turn.updatedAt = parseTimestamp(record.timestamp);
      this.turns.set(turn.turnId, turn);
      this.#markCacheDirty();
    }
    if (record.type === "response_item") {
      const turnId = record.payload?.internal_chat_message_metadata_passthrough?.turn_id;
      if (turnId) state.currentTurnId = String(turnId);
    }
    if (record.type !== "event_msg") return;

    if (record.payload?.type === "thread_settings_applied") {
      const model = nonEmptyString(record.payload.model) ??
        nonEmptyString(record.payload.thread_settings?.model);
      if (!model) return;
      state.threadModel = model;
      const currentTurn = state.currentTurnId ? this.turns.get(state.currentTurnId) : null;
      if (currentTurn && !currentTurn.completed) {
        setTurnModel(currentTurn, model, "thread-settings");
        fillUnknownSegmentModels(currentTurn, model, "thread-settings");
        this.#markCacheDirty();
      }
      return;
    }

    if (record.payload?.type === "task_started") {
      const turnId = nonEmptyString(record.payload.turn_id);
      if (!turnId) return;
      state.currentTurnId = turnId;
      const turn = this.turns.get(turnId) ?? emptyTurn(
        turnId,
        state.threadId,
        "rollout",
        state.path,
      );
      if (!turn.startedAt) turn.startedAt = parseTimestamp(record.timestamp);
      const model = nonEmptyString(record.payload.model) ?? state.threadModel;
      setTurnModel(turn, model, "thread-settings");
      fillUnknownSegmentModels(turn, model, "thread-settings");
      this.turns.set(turnId, turn);
      this.#markCacheDirty();
      return;
    }

    if (record.payload?.type === "turn_aborted") {
      const turnId = nonEmptyString(record.payload.turn_id) ?? state.currentTurnId;
      if (!turnId) return;
      state.currentTurnId = turnId;
      const turn = this.turns.get(turnId);
      if (!turn) return;
      if (turn.source === "event") {
        turn.status = record.payload.reason === "interrupted" ? "interrupted" : "failed";
        turn.completed = true;
        turn.updatedAt = parseTimestamp(record.timestamp);
        this.#markCacheDirty();
        return;
      }
      turn.completed = true;
      turn.status = record.payload.reason === "interrupted" ? "interrupted" : "failed";
      turn.updatedAt = parseTimestamp(record.timestamp);
      this.#markCacheDirty();
      return;
    }

    if (!state.currentTurnId) return;

    if (record.payload?.type === "token_count") {
      const last = normalizeRolloutUsage(record.payload.info?.last_token_usage);
      if (!last) return;
      const existing = this.turns.get(state.currentTurnId);
      if (existing?.source === "event") {
        existing.cumulativeTotalTokens = Math.max(
          positiveNumber(existing.cumulativeTotalTokens),
          positiveNumber(record.payload.info?.total_token_usage?.total_tokens),
        );
        const modelContextWindow = positiveNumber(record.payload.info?.model_context_window);
        if (modelContextWindow > 0) existing.modelContextWindow = modelContextWindow;
        this.#markCacheDirty();
        return;
      }
      const turn = existing ?? emptyTurn(
        state.currentTurnId,
        state.threadId,
        "rollout",
        state.path,
      );
      const previousOutputTokens = positiveNumber(turn.outputTokens);
      addUsage(turn, last, turn.model, turn.modelSource);
      if (turn.outputTokens > previousOutputTokens) {
        updateTotalGenerationRate(turn, parseTimestamp(record.timestamp));
      }
      turn.cumulativeTotalTokens = positiveNumber(
        record.payload.info?.total_token_usage?.total_tokens,
      );
      turn.modelContextWindow = positiveNumber(record.payload.info?.model_context_window);
      turn.updatedAt = parseTimestamp(record.timestamp);
      this.turns.set(turn.turnId, turn);
      this.#markCacheDirty();
      return;
    }

    if (record.payload?.type === "task_complete") {
      const turn = this.turns.get(state.currentTurnId);
      if (!turn) return;
      turn.completed = true;
      turn.status = "completed";
      turn.updatedAt = parseTimestamp(record.timestamp);
      this.#markCacheDirty();
    }
  }

  #readRolloutInWorker(state, reconcile, onBatch, onReset) {
    const worker = this.#ensureRolloutWorker();
    const id = ++this.rolloutWorkerRequestId;
    return new Promise((resolve, reject) => {
      this.rolloutWorkerRequests.set(id, { resolve, reject, onBatch, onReset });
      try {
        worker.postMessage({
          id,
          path: state.path,
          offset: state.offset,
          pending: state.pending,
          currentTurnId: state.currentTurnId,
          pendingModel: state.threadModel,
          reconcile,
        });
      } catch (error) {
        this.rolloutWorkerRequests.delete(id);
        reject(error);
      }
    });
  }

  #ensureRolloutWorker() {
    if (this.rolloutWorker) return this.rolloutWorker;
    const worker = new Worker(ROLLOUT_WORKER_SOURCE, { eval: true });
    worker.on("message", (message) => {
      const pending = this.rolloutWorkerRequests.get(message?.id);
      if (!pending) return;
      if (message?.type === "batch") {
        try {
          pending.onBatch?.(message.records ?? []);
        } catch (error) {
          this.rolloutWorkerRequests.delete(message.id);
          pending.reject(error);
        }
        return;
      }
      if (message?.type === "reset") {
        try {
          pending.onReset?.();
        } catch (error) {
          this.rolloutWorkerRequests.delete(message.id);
          pending.reject(error);
        }
        return;
      }
      this.rolloutWorkerRequests.delete(message.id);
      if (message.ok) pending.resolve(message);
      else pending.reject(new Error(message.error || "rollout Worker 解析失败"));
    });
    worker.on("error", (error) => {
      this.rolloutWorker = null;
      for (const pending of this.rolloutWorkerRequests.values()) pending.reject(error);
      this.rolloutWorkerRequests.clear();
    });
    worker.on("exit", (code) => {
      if (this.rolloutWorker !== worker) return;
      this.rolloutWorker = null;
      if (code !== 0) {
        const error = new Error(`rollout Worker 异常退出（${code}）`);
        for (const pending of this.rolloutWorkerRequests.values()) pending.reject(error);
        this.rolloutWorkerRequests.clear();
      }
    });
    this.rolloutWorker = worker;
    return worker;
  }

  #closeRolloutWorker() {
    const worker = this.rolloutWorker;
    this.rolloutWorker = null;
    if (!worker) return;
    const error = new Error("TokenUsageManager 已关闭");
    for (const pending of this.rolloutWorkerRequests.values()) pending.reject(error);
    this.rolloutWorkerRequests.clear();
    void worker.terminate();
  }

  #clearRolloutTurns(threadId, { clearHistory = false } = {}) {
    for (const [turnId, turn] of this.turns) {
      if (turn.threadId === threadId && turn.source === "rollout") {
        this.turns.delete(turnId);
        this.turnCostCache.delete(turnId);
      }
    }
    if (clearHistory) {
      this.historicalSegmentsByThread.delete(threadId);
      this.historicalCostCache.delete(threadId);
    }
    this.#invalidateViewModel();
  }

  #pruneRolloutStates(protectedThreadId) {
    if (this.fileStates.size < MAX_TRACKED_ROLLOUT_STATES) return;
    const removable = [...this.fileStates.entries()]
      .filter(([threadId]) => threadId !== protectedThreadId &&
        threadId !== this.activeThreadId && !this.rolloutReadPromises.has(threadId))
      .sort(([, left], [, right]) => positiveNumber(left.lastUsedAt) - positiveNumber(right.lastUsedAt));
    while (this.fileStates.size >= MAX_TRACKED_ROLLOUT_STATES && removable.length > 0) {
      const [threadId] = removable.shift();
      this.fileStates.delete(threadId);
      this.#markCacheDirty();
    }
  }

  #pruneCompletedTurns() {
    if (this.turns.size <= MAX_STORED_TURNS) return;
    const removable = [...this.turns.values()]
      .filter((turn) => turn.completed)
      .sort((left, right) => left.updatedAt - right.updatedAt);
    const target = this.turns.size - MAX_STORED_TURNS;
    let pruned = 0;
    for (const turn of removable) {
      if (pruned >= target) break;
      if (turn.totalTokens > 0) {
        const cost = calculateTurnCost(turn, this.pricingManager);
        let history = this.historicalSegmentsByThread.get(turn.taskKey);
        if (!history) {
          history = {
            threadId: turn.taskKey,
            segments: [],
            pendingTurns: 0,
            pendingTokens: 0,
            costRevision: 0,
            updatedAt: 0,
          };
          this.historicalSegmentsByThread.set(turn.taskKey, history);
        }
        if (cost?.available) {
          for (const segment of turn.segments) mergeUsageSegment(history.segments, segment);
          compactUsageSegments(history.segments);
        } else {
          history.pendingTurns = positiveInteger(history.pendingTurns) + 1;
          history.pendingTokens = positiveNumber(history.pendingTokens) + positiveNumber(turn.totalTokens);
        }
        history.costRevision = positiveInteger(history.costRevision) + 1;
        history.updatedAt = Date.now();
        this.historicalCostCache.delete(turn.taskKey);
      }
      this.turns.delete(turn.turnId);
      this.turnCostCache.delete(turn.turnId);
      pruned += 1;
    }
    const historiesPruned = this.#pruneHistoricalThreads();
    if (pruned > 0 || historiesPruned) {
      this.#markCacheDirty();
      this.#invalidateViewModel();
    }
  }

  #pruneHistoricalThreads() {
    if (this.historicalSegmentsByThread.size <= MAX_HISTORICAL_THREADS) return false;
    const threadsWithTurns = new Set([...this.turns.values()].map((turn) => turn.taskKey));
    const removable = [...this.historicalSegmentsByThread.values()]
      .filter((history) => !threadsWithTurns.has(history.threadId))
      .sort((left, right) => positiveNumber(left.updatedAt) - positiveNumber(right.updatedAt));
    let pruned = false;
    while (this.historicalSegmentsByThread.size > MAX_HISTORICAL_THREADS && removable.length > 0) {
      const history = removable.shift();
      this.historicalSegmentsByThread.delete(history.threadId);
      this.historicalCostCache.delete(history.threadId);
      pruned = true;
    }
    return pruned;
  }

  #scheduleUnknownRolloutReconciliation() {
    if (this.rolloutReconcilePromise) {
      this.rolloutReconcileRequested = true;
      return;
    }
    if (this.rolloutPathsByThread.size === 0) return;
    const elapsed = Date.now() - this.lastUnknownRolloutCheckAt;
    if (elapsed < UNKNOWN_ROLLOUT_CHECK_INTERVAL_MS) {
      if (!this.unknownRolloutCheckTimer) {
        this.unknownRolloutCheckTimer = setTimeout(() => {
          this.unknownRolloutCheckTimer = null;
          if (!this.closed) this.#scheduleUnknownRolloutReconciliation();
        }, UNKNOWN_ROLLOUT_CHECK_INTERVAL_MS - elapsed);
      }
      return;
    }
    this.lastUnknownRolloutCheckAt = Date.now();
    const possibleThreads = [...new Set([...this.turns.values()]
      .filter((turn) => turn.totalTokens > 0 && turnHasUnknownModel(turn))
      .map((turn) => turn.threadId)
      .filter((threadId) => threadId && this.rolloutPathsByThread.has(threadId)))].slice(
        -MAX_TRACKED_ROLLOUT_STATES,
      );
    if (possibleThreads.length === 0) return;
    this.rolloutReconcilePromise = (async () => {
      const candidates = (await Promise.all(possibleThreads.map(async (threadId) => {
        const state = this.fileStates.get(threadId);
        if (!state || !state.unknownModelChecked) return threadId;
        try {
          const info = await stat(state.path);
          return info.size !== state.unknownModelCheckOffset ? threadId : null;
        } catch (error) {
          if (error.code !== "ENOENT") {
            console.error(`[token-usage] 检查线程 ${threadId} rollout 变化失败: ${error.message}`);
          }
          return null;
        }
      }))).filter(Boolean);
      if (candidates.length === 0) return;
      let changed = false;
      let nextCandidate = 0;
      const reconcileWorker = async () => {
        for (;;) {
          const candidateIndex = nextCandidate++;
          if (candidateIndex >= candidates.length) return;
          const threadId = candidates[candidateIndex];
          try {
            const state = await this.#ensureRolloutState(threadId);
            if (!state) continue;
            const revision = this.cacheRevision;
            await this.#readAppendedRollout(state);
            if (!state.unknownModelChecked || state.unknownModelCheckOffset !== state.offset) {
              state.unknownModelChecked = true;
              state.unknownModelCheckOffset = state.offset;
              this.#markCacheDirty();
            }
            changed ||= this.cacheRevision !== revision;
          } catch (error) {
            console.error(`[token-usage] 后台补全线程 ${threadId} 失败: ${error.message}`);
          }
        }
      };
      await Promise.all(Array.from({
        length: Math.min(UNKNOWN_ROLLOUT_RECONCILE_CONCURRENCY, candidates.length),
      }, () => reconcileWorker()));
      this.#queueCachePersist();
      if (changed) this.#notifyChange(this.getViewModel());
    })().finally(() => {
      const rerun = this.rolloutReconcileRequested;
      this.rolloutReconcileRequested = false;
      this.rolloutReconcilePromise = null;
      if (rerun && !this.closed) this.#scheduleUnknownRolloutReconciliation();
    });
  }
}

function buildDisplayTurns(turns) {
  const subagentGroups = new Map();
  for (const turn of turns) {
    if (!turn.isSubagent) continue;
    const key = `${turn.threadId}\u0000${turn.parentTurnId || ""}`;
    const group = subagentGroups.get(key) ?? [];
    group.push(turn);
    subagentGroups.set(key, group);
  }
  return [
    ...turns,
    ...[...subagentGroups.values()].map(summarizeSubagentTurns),
  ];
}

function findTurnAtTimestamp(turns, timestamp) {
  const enclosing = turns.find((turn) => {
    const turnStartedAt = positiveNumber(turn.startedAt) || positiveNumber(turn.updatedAt);
    return turnStartedAt <= timestamp &&
      (!turn.completed || positiveNumber(turn.updatedAt) >= timestamp);
  });
  return enclosing ??
    turns.find((turn) =>
      (positiveNumber(turn.startedAt) || positiveNumber(turn.updatedAt)) <= timestamp) ??
    turns[0] ?? null;
}

function summarizeSubagentTurns(turns) {
  const ordered = [...turns].sort((left, right) =>
    positiveNumber(left.startedAt) - positiveNumber(right.startedAt) ||
    positiveNumber(left.updatedAt) - positiveNumber(right.updatedAt));
  const first = ordered[0];
  const summary = emptyTurn(
    `subagent:${first.threadId}:${first.parentTurnId || "unassigned"}`,
    first.threadId,
    "subagent",
  );
  summary.taskKey = summary.turnId;
  summary.isSubagent = true;
  summary.isSubagentSummary = true;
  summary.parentThreadId = first.parentThreadId;
  summary.parentTurnId = first.parentTurnId;
  summary.agentPath = first.agentPath;
  summary.agentNickname = first.agentNickname;
  summary.agentDepth = first.agentDepth;
  summary.startedAt = ordered
    .map((turn) => positiveNumber(turn.startedAt) || positiveNumber(turn.updatedAt))
    .filter(Boolean)
    .sort((left, right) => left - right)[0] ?? 0;
  summary.updatedAt = Math.max(...ordered.map((turn) => positiveNumber(turn.updatedAt)), 0);
  summary.completed = ordered.every((turn) => turn.completed);
  summary.status = summary.completed
    ? ordered.some((turn) => turn.status === "failed")
      ? "failed"
      : ordered.some((turn) => turn.status === "interrupted")
        ? "interrupted"
        : "completed"
    : null;
  for (const turn of ordered) {
    for (const field of TOKEN_FIELDS) {
      const publicField = toCamelCase(field);
      summary[publicField] += positiveNumber(turn[publicField]);
    }
    for (const segment of turn.segments) mergeUsageSegment(summary.segments, segment);
    summary.costRevision += positiveInteger(turn.costRevision);
    summary.modelContextWindow = Math.max(
      summary.modelContextWindow,
      positiveNumber(turn.modelContextWindow),
    );
  }
  summary.cumulativeTotalTokens = summary.totalTokens;
  const models = [...new Set(ordered.map((turn) => nonEmptyString(turn.model)).filter(Boolean))];
  summary.model = models.length === 1 ? models[0] : models.length > 1 ? "multiple" : "";
  summary.modelSource = "subagent";
  const activeTurn = [...ordered].reverse().find((turn) => !turn.completed) ?? ordered.at(-1);
  summary.totalGenerationRate = positiveNumber(activeTurn?.totalGenerationRate) || null;
  return summary;
}

function emptyTurn(turnId, threadId, source, rolloutPath = "") {
  return {
    turnId,
    threadId,
    taskKey: threadId,
    source,
    rolloutPath,
    isSubagent: false,
    isSubagentSummary: false,
    rootThreadId: threadId,
    parentThreadId: "",
    parentTurnId: "",
    agentPath: "",
    agentNickname: "",
    agentDepth: 0,
    completed: false,
    status: null,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    cumulativeTotalTokens: 0,
    modelContextWindow: 0,
    model: "",
    modelSource: "",
    generationStartAt: 0,
    totalGenerationRate: null,
    costRevision: 0,
    segments: [],
    startedAt: 0,
    updatedAt: 0,
  };
}

function addUsage(turn, usage, model, modelSource = turn.modelSource) {
  const normalizedUsage = Object.fromEntries(
    TOKEN_FIELDS.map((field) => [field, positiveNumber(usage?.[field])]),
  );
  for (const field of TOKEN_FIELDS) turn[toCamelCase(field)] += normalizedUsage[field];
  const segmentModel = model || "";
  const segmentSource = modelSource || "";
  const rawInput = positiveNumber(normalizedUsage.input_tokens);
  const contextTier = resolveContextTier(segmentModel || turn.model, rawInput);
  const lastSegment = turn.segments.at(-1);
  if (
    lastSegment &&
    lastSegment.model === segmentModel &&
    lastSegment.modelSource === segmentSource &&
    (lastSegment.contextTier ?? "short") === contextTier
  ) {
    for (const field of TOKEN_FIELDS) {
      lastSegment.usage[field] = positiveNumber(lastSegment.usage[field]) + normalizedUsage[field];
    }
  } else {
    turn.segments.push({
      model: segmentModel,
      modelSource: segmentSource,
      contextTier,
      usage: normalizedUsage,
    });
  }
  turn.costRevision = positiveInteger(turn.costRevision) + 1;
}

function updateTotalGenerationRate(turn, updatedAt) {
  // outputTokens is the total generated-token counter, including reasoning
  // tokens. Keep this separate from the visible-text counter in the UI.
  const timestamp = positiveNumber(updatedAt);
  if (!timestamp || positiveNumber(turn.outputTokens) <= 0) return;
  if (!positiveNumber(turn.generationStartAt)) {
    turn.generationStartAt = timestamp;
    return;
  }
  const elapsedSeconds = (timestamp - turn.generationStartAt) / 1_000;
  if (elapsedSeconds <= 0) return;
  turn.totalGenerationRate = turn.outputTokens / elapsedSeconds;
}

function turnHasUnknownModel(turn) {
  return !nonEmptyString(turn?.model) ||
    (Array.isArray(turn?.segments) && turn.segments.some((segment) => !nonEmptyString(segment?.model)));
}

function fillUnknownSegmentModels(turn, model, modelSource) {
  const nextModel = nonEmptyString(model);
  if (!nextModel) return;
  if (turn.segments.some((segment) => segment.modelSource === "rerouted")) return;
  let changed = false;
  for (const segment of turn.segments) {
    if (segment.model) continue;
    segment.model = nextModel;
    segment.modelSource = modelSource || segment.modelSource || "thread";
    changed = true;
  }
  if (changed) turn.costRevision = positiveInteger(turn.costRevision) + 1;
}

function setTurnModel(turn, model, source = "thread") {
  const nextModel = nonEmptyString(model);
  if (!nextModel) return false;
  const currentSource = turn.modelSource || (turn.model ? "thread" : "");
  const currentPriority = MODEL_SOURCE_PRIORITY[currentSource] ?? 0;
  const nextPriority = MODEL_SOURCE_PRIORITY[source] ?? 0;
  if (turn.model && nextPriority < currentPriority) return false;
  if (turn.model === nextModel && currentSource === source) return false;
  turn.model = nextModel;
  turn.modelSource = source;
  turn.costRevision = positiveInteger(turn.costRevision) + 1;
  return true;
}

function calculateTurnCost(turn, pricingManager) {
  let cost = null;
  const tiers = new Map();
  const hasReroute = turn.segments.some((segment) => segment.modelSource === "rerouted");
  for (const segment of turn.segments) {
    const segmentModel = segment.model || (hasReroute ? "" : turn.model);
    const segmentCost = pricingManager.calculate(segmentModel, segment.usage, {
      contextTier: segment.contextTier,
    });
    cost = accumulateTokenCost(cost, segmentCost);
    if (!segmentCost.available) continue;
    const tierKey = JSON.stringify([
      segmentCost.normalizedModel,
      segmentCost.provider,
      segmentCost.currency,
      segmentCost.contextTier,
      segmentCost.rates,
    ]);
    tiers.set(tierKey, accumulateTokenCost(tiers.get(tierKey), segmentCost));
  }
  if (cost?.available) cost.tiers = [...tiers.values()];
  return cost;
}

function normalizeProtocolUsage(value) {
  if (!value || typeof value !== "object") return null;
  return {
    input_tokens: positiveNumber(value.inputTokens),
    cached_input_tokens: positiveNumber(value.cachedInputTokens),
    cache_write_input_tokens: positiveNumber(value.cacheWriteInputTokens),
    output_tokens: positiveNumber(value.outputTokens),
    reasoning_output_tokens: positiveNumber(value.reasoningOutputTokens),
    total_tokens: positiveNumber(value.totalTokens),
  };
}

function normalizeRolloutUsage(value) {
  if (!value || typeof value !== "object") return null;
  return Object.fromEntries(TOKEN_FIELDS.map((field) => [field, positiveNumber(value[field])]));
}

function normalizeCachedTurn(value) {
  const turnId = nonEmptyString(value?.turnId);
  const threadId = nonEmptyString(value?.threadId ?? value?.taskKey);
  if (!turnId || !threadId) return null;
  const turn = emptyTurn(
    turnId,
    threadId,
    value.source === "event" ? "event" : "rollout",
    String(value.rolloutPath ?? ""),
  );
  turn.completed = Boolean(value.completed);
  turn.status = nonEmptyString(value.status);
  turn.model = String(value.model ?? "");
  turn.modelSource = String(value.modelSource ?? (turn.model ? "thread" : ""));
  turn.generationStartAt = positiveNumber(value.generationStartAt);
  turn.totalGenerationRate = positiveNumber(value.totalGenerationRate) || null;
  turn.costRevision = positiveInteger(value.costRevision);
  turn.isSubagent = Boolean(value.isSubagent);
  turn.isSubagentSummary = false;
  turn.rootThreadId = String(value.rootThreadId ?? threadId);
  turn.parentThreadId = String(value.parentThreadId ?? "");
  turn.parentTurnId = String(value.parentTurnId ?? "");
  turn.agentPath = String(value.agentPath ?? "");
  turn.agentNickname = String(value.agentNickname ?? "");
  turn.agentDepth = positiveInteger(value.agentDepth);
  turn.taskKey = nonEmptyString(value.taskKey) ?? threadId;
  turn.startedAt = positiveNumber(value.startedAt);
  turn.cumulativeTotalTokens = positiveNumber(value.cumulativeTotalTokens);
  turn.modelContextWindow = positiveNumber(value.modelContextWindow);
  turn.updatedAt = positiveNumber(value.updatedAt);
  turn.segments = Array.isArray(value.segments)
    ? value.segments.map((segment) => {
        const model = String(segment?.model ?? "");
        const modelSource = String(segment?.modelSource ?? (model ? "thread" : ""));
        const usage = normalizeRolloutUsage(segment?.usage) ?? normalizeRolloutUsage({});
        const modelContextWindow = positiveNumber(value?.modelContextWindow);
        const contextTier = segment?.contextTier ||
          (modelContextWindow > 0 && modelContextWindow <= 272_000
            ? "short"
            : resolveContextTier(model, usage.input_tokens));
        return {
          model,
          modelSource,
          contextTier,
          usage,
        };
      })
    : [];
  if (turn.costRevision === 0 && (turn.model || turn.segments.length > 0)) turn.costRevision = 1;
  for (const field of TOKEN_FIELDS) {
    turn[toCamelCase(field)] = positiveNumber(value[toCamelCase(field)]);
  }
  return turn;
}

function normalizeCachedFileState(value) {
  const threadId = nonEmptyString(value?.threadId);
  const path = nonEmptyString(value?.path);
  if (!threadId || !path) return null;
  return {
    threadId,
    path,
    offset: positiveInteger(value.offset),
    pending: String(value.pending ?? ""),
    currentTurnId: nonEmptyString(value.currentTurnId),
    threadModel: nonEmptyString(value.threadModel),
    modelReconciled: Boolean(value.modelReconciled),
    parserVersion: positiveInteger(value.parserVersion),
    unknownModelChecked: Boolean(value.unknownModelChecked),
    unknownModelCheckOffset: positiveInteger(value.unknownModelCheckOffset),
    lastUsedAt: positiveNumber(value.lastUsedAt),
  };
}

function normalizeCachedHistory(value) {
  const threadId = nonEmptyString(value?.threadId);
  if (!threadId || !Array.isArray(value?.segments)) return null;
  const pendingTurns = positiveInteger(value.pendingTurns);
  const segments = value.segments.map((segment) => {
    const model = String(segment?.model ?? "");
    const modelSource = String(segment?.modelSource ?? (model ? "thread" : ""));
    const usage = normalizeRolloutUsage(segment?.usage) ?? normalizeRolloutUsage({});
    const contextTier = segment?.contextTier || resolveContextTier(model, usage.input_tokens);
    return {
      model,
      modelSource,
      contextTier,
      usage,
    };
  });
  if (segments.length === 0 && pendingTurns === 0) return null;
  return {
    threadId,
    segments,
    pendingTurns,
    pendingTokens: positiveNumber(value.pendingTokens),
    costRevision: positiveInteger(value.costRevision),
    updatedAt: positiveNumber(value.updatedAt),
  };
}

function mergeUsageSegment(segments, segment) {
  const model = String(segment?.model ?? "");
  const modelSource = String(segment?.modelSource ?? (model ? "thread" : ""));
  const usage = normalizeRolloutUsage(segment?.usage) ?? normalizeRolloutUsage({});
  const rawInput = positiveNumber(usage.input_tokens);
  const contextTier = segment?.contextTier || resolveContextTier(model, rawInput);
  const last = segments.at(-1);
  if (
    last &&
    last.model === model &&
    last.modelSource === modelSource &&
    (last.contextTier ?? "short") === contextTier
  ) {
    for (const field of TOKEN_FIELDS) {
      last.usage[field] = positiveNumber(last.usage[field]) + usage[field];
    }
    return;
  }
  segments.push({ model, modelSource, contextTier, usage });
}

function compactUsageSegments(segments) {
  if (segments.length <= MAX_HISTORICAL_SEGMENTS) return;
  const grouped = new Map();
  for (const segment of segments) {
    const model = String(segment?.model ?? "");
    const modelSource = String(segment?.modelSource ?? (model ? "thread" : ""));
    const usage = normalizeRolloutUsage(segment?.usage) ?? normalizeRolloutUsage({});
    const contextTier = segment?.contextTier || resolveContextTier(model, usage.input_tokens);
    const key = `${model}\u0000${modelSource}\u0000${contextTier}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        model,
        modelSource,
        contextTier,
        usage,
      });
      continue;
    }
    for (const field of TOKEN_FIELDS) existing.usage[field] += usage[field];
  }
  segments.splice(0, segments.length, ...grouped.values());
}

async function readAppendedChunks(path, state, onLine) {
  const info = await stat(path);
  if (info.size === state.offset) return;
  const handle = await open(path, "r");
  try {
    while (state.offset < info.size) {
      const length = Math.min(READ_CHUNK_BYTES, info.size - state.offset);
      const buffer = Buffer.allocUnsafe(length);
      const result = await handle.read(buffer, 0, length, state.offset);
      if (result.bytesRead === 0) break;
      state.offset += result.bytesRead;
      const lines = `${state.pending}${buffer.subarray(0, result.bytesRead).toString("utf8")}`
        .split(/\r?\n/);
      state.pending = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    }
  } finally {
    await handle.close();
  }
}

async function collectRolloutFiles(root, depth) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const paths = [];
  await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
      paths.push(path);
    } else if (entry.isDirectory() && depth > 0) {
      paths.push(...await collectRolloutFiles(path, depth - 1));
    }
  }));
  return paths;
}

async function readRolloutSessionMetadata(path) {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const length = Math.min(info.size, MAX_ROLLOUT_METADATA_BYTES);
  if (length <= 0) return null;
  const handle = await open(path, "r");
  let content = "";
  try {
    let offset = 0;
    while (offset < length) {
      const chunkLength = Math.min(READ_CHUNK_BYTES, length - offset);
      const buffer = Buffer.allocUnsafe(chunkLength);
      const result = await handle.read(buffer, 0, chunkLength, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
      content += buffer.subarray(0, result.bytesRead).toString("utf8");
      const newline = content.indexOf("\n");
      if (newline >= 0) {
        content = content.slice(0, newline).replace(/\r$/, "");
        break;
      }
    }
  } finally {
    await handle.close();
  }
  if (!content) return null;
  let record;
  try {
    record = JSON.parse(content);
  } catch {
    return null;
  }
  if (record?.type !== "session_meta" || !record.payload) return null;
  const payload = record.payload;
  const threadId = nonEmptyString(payload.id) ?? threadIdFromRolloutPath(path);
  if (!threadId) return null;
  const spawn = payload.source?.subagent?.thread_spawn;
  const isSubagent = payload.thread_source === "subagent" && Boolean(spawn);
  const parentThreadId = isSubagent ? nonEmptyString(spawn.parent_thread_id) : null;
  const rootThreadId = isSubagent
    ? nonEmptyString(payload.session_id) ?? parentThreadId ?? threadId
    : threadId;
  return {
    threadId,
    rootThreadId,
    isSubagent,
    parentThreadId: parentThreadId ?? "",
    agentPath: isSubagent ? String(spawn.agent_path ?? "") : "",
    agentNickname: isSubagent ? String(spawn.agent_nickname ?? "") : "",
    agentDepth: isSubagent ? Math.max(1, positiveInteger(spawn.depth)) : 0,
  };
}

async function findLatestRolloutPath(paths) {
  const fallback = [...paths].sort((left, right) => basename(right).localeCompare(basename(left)))[0];
  const candidates = await Promise.all(paths.map(async (path) => {
    try {
      const info = await stat(path);
      return { path, modifiedAt: info.mtimeMs };
    } catch {
      return null;
    }
  }));
  return candidates
    .filter(Boolean)
    .sort((left, right) =>
      right.modifiedAt - left.modifiedAt ||
      basename(right.path).localeCompare(basename(left.path))
    )[0]?.path ?? fallback;
}

function threadIdFromRolloutPath(path) {
  const match = basename(path).match(/-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i);
  return match?.[1] ?? null;
}

function resolveCodexHome() {
  const configured = String(process.env.CODEX_HOME ?? "").trim().replace(/^['"]|['"]$/g, "");
  return configured || join(homedir(), ".codex");
}

function toCamelCase(value) {
  return value.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function nonEmptyString(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function parseTimestamp(value) {
  const number = Date.parse(value);
  return Number.isFinite(number) ? number : Date.now();
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writeJsonAtomic(path, value) {
  const content = `${JSON.stringify(value)}\n`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, content, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}
