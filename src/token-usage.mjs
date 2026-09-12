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
import { MIN_GENERATION_METRICS_VERSION } from "./relay-contract.mjs";
import { assignOutputPhaseSpeed, generationSpeedWindow, normalizeOutputPhases } from "./generation-speed.mjs";
import {
  createToolExecutionLedger,
  normalizeToolExecutionLedger,
  projectToolExecutions,
  recordToolExecution,
  simplifyToolExecutionRecord,
} from "./tool-executions.mjs";

// Version 14 discards generation metrics produced before structural tool-call
// detection, because those records can mix tool arguments into visible speed.
// Version 17 rebuilds rollout usage from response-level records so compacted
// responses are priced from their exact token breakdown, and persists the
// structural identity needed to pair exact records with legacy summaries.
// Version 18 persists per-message phases and tool preparation timings used by
// the request-stage breakdown. Version 19 stores the connection RTT sample
// associated with each model request.
// Version 20 retains sanitized, response-associated tool item lifecycles.
// Version 21 replaces inferred command purposes with argument-free commands.
// Version 22 preserves expandable file/command lists and Node entry points.
// Version 23 adds request-level output coverage and attributable phase speeds.
const CACHE_VERSION = 23;
const MIN_SUPPORTED_CACHE_VERSION = 11;
const MIN_GENERATION_METRICS_CACHE_VERSION = 14;
const DISCOVERY_INTERVAL_MS = 5_000;
const MAX_VIEW_TURNS = 120;
const MAX_STORED_TURNS = 2_000;
const MAX_TRACKED_ROLLOUT_STATES = 256;
const MAX_HISTORICAL_THREADS = 2_048;
const MAX_HISTORICAL_SEGMENTS = 128;
const READ_CHUNK_BYTES = 1024 * 1024;
const COST_CACHE_VERSION = 3;
const ROLLOUT_PARSER_VERSION = 9;
const MAX_SEEN_EVENT_IDS = 50_000;
const MAX_SEEN_USAGE_RESPONSE_IDS = 4_096;
const MAX_PENDING_USAGE_RECORDS = 512;
const MAX_PENDING_GENERATION_RECORDS = 512;
const CACHE_PERSIST_DELAY_MS = 10_000;
const UNKNOWN_ROLLOUT_CHECK_INTERVAL_MS = 10_000;
const UNKNOWN_ROLLOUT_RECONCILE_CONCURRENCY = 4;
const ACTIVE_THREAD_HINT_TTL_MS = 5 * 60 * 1000;
const RECENT_ROLLOUT_ACTIVITY_MS = 5 * 60 * 1000;
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
  generation: 3,
  "turn-response": 5,
  "turn-context": 4,
  rerouted: 6,
});

const ROLLOUT_WORKER_SOURCE = String.raw`
const { parentPort } = require("node:worker_threads");
const { open, stat } = require("node:fs/promises");

const READ_CHUNK_BYTES = 1024 * 1024;
const ROLLOUT_RECORD_BATCH_SIZE = 256;
const simplifyToolExecutionRecord = ${simplifyToolExecutionRecord.toString()};

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
        const execution = simplifyToolExecutionRecord(record, currentTurnId);
        const simplified = simplifyRecord(record, currentTurnId, pendingModel);
        currentTurnId = simplified.currentTurnId;
        pendingModel = simplified.pendingModel;
        if (simplified.record) {
          if (execution) simplified.record.toolExecution = execution;
          records.push(simplified.record);
        } else if (execution) {
          records.push({ type: "tool_execution_record", payload: execution });
        }
        if (records.length >= ROLLOUT_RECORD_BATCH_SIZE) {
          emitBatch(records);
          records = [];
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
  if (record.type === "token_usage_record" && payload?.turn_id && payload?.response_id) {
    const turnId = String(payload.turn_id);
    return {
      currentTurnId: turnId,
      pendingModel,
      record: {
        timestamp: record.timestamp,
        type: "token_usage_record",
        payload: {
          turn_id: turnId,
          response_id: String(payload.response_id),
          usage: payload.usage,
          turn_token_usage: payload.turn_token_usage,
        },
      },
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
    this.rolloutFallbackThreads = new Map();
    this.recentRolloutThreads = new Set();
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
          rolloutUsageFallback: _rolloutUsageFallback,
          rolloutParserVersion: _rolloutParserVersion,
          rolloutTokenCountTotalTokens: _rolloutTokenCountTotalTokens,
          responseCumulativeTotalTokens: _responseCumulativeTotalTokens,
          usageResponseIds: _usageResponseIds,
          generationMetricsVersion: _generationMetricsVersion,
          generationMetricsEnabled: _generationMetricsEnabled,
          firstTokenLatencyTotalMs: _firstTokenLatencyTotalMs,
          firstTokenLatencySamples: _firstTokenLatencySamples,
          outputGenerationDurationMs: _outputGenerationDurationMs,
          outputGenerationTokens: _outputGenerationTokens,
          pendingGenerationSamples: _pendingGenerationSamples,
          pendingGenerationUsages: _pendingGenerationUsages,
          pendingToolTimings: _pendingToolTimings,
          costRevision: _costRevision,
          ...publicTurn
        } = turn;
        return {
          ...publicTurn,
          generationDetails: publicGenerationDetails(publicTurn.generationDetails, publicTurn.toolExecutionLedger),
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
    this.rolloutFallbackThreads.clear();
    this.recentRolloutThreads.clear();
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
    const rolloutThreadIds = new Set(this.rolloutFallbackThreads.keys());
    for (const threadId of this.recentRolloutThreads) rolloutThreadIds.add(threadId);
    if (this.activeThreadId) rolloutThreadIds.add(this.activeThreadId);
    for (const threadId of rolloutThreadIds) {
      const states = await this.#ensureRolloutStates(threadId);
      for (const state of states) await this.#readAppendedRollout(state);
      const latestState = states.at(-1);
      const currentTurn = latestState?.currentTurnId
        ? this.turns.get(latestState.currentTurnId)
        : null;
      if (currentTurn?.completed) this.rolloutFallbackThreads.delete(threadId);
    }
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
    if (!cached || cachedVersion < MIN_SUPPORTED_CACHE_VERSION ||
      cachedVersion > CACHE_VERSION) return;
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
      const turn = normalizeCachedTurn(value, {
        generationMetricsCompatible:
          cachedVersion >= MIN_GENERATION_METRICS_CACHE_VERSION,
      });
      if (turn) this.turns.set(turn.turnId, turn);
    }
    for (const value of Array.isArray(cached.fileStates) ? cached.fileStates : []) {
      const state = normalizeCachedFileState(value);
      if (!state) continue;
      this.fileStates.set(state.path, state);
      if (state.parserVersion !== ROLLOUT_PARSER_VERSION) {
        this.rolloutFallbackThreads.set(state.threadId, state.lastUsedAt || Date.now());
      }
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
    this.rolloutFallbackThreads.clear();
    this.recentRolloutThreads.clear();
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
      if (event.rolloutUsageFallback) {
        this.rolloutFallbackThreads.delete(threadId);
        this.rolloutFallbackThreads.set(threadId, updatedAt);
        while (this.rolloutFallbackThreads.size > MAX_TRACKED_ROLLOUT_STATES) {
          this.rolloutFallbackThreads.delete(this.rolloutFallbackThreads.keys().next().value);
        }
      }
      return;
    }

    const turnId = nonEmptyString(event.turnId);
    if (!turnId) return;
    if (event.type === "turn-started") {
      const turn = this.turns.get(turnId) ?? emptyTurn(turnId, threadId, "event");
      turn.source = "event";
      turn.rolloutUsageFallback ||= Boolean(event.rolloutUsageFallback);
      if (Object.hasOwn(event, "networkLatencySupported")) {
        const previousConnectionId = turn.networkConnectionId;
        turn.networkLatencySupported = Boolean(event.networkLatencySupported);
        turn.networkConnectionId = nonEmptyString(event.networkConnectionId);
        if (!turn.networkLatencySupported ||
          (previousConnectionId && previousConnectionId !== turn.networkConnectionId)) {
          turn.networkLatency = null;
        }
        const networkLatency = normalizeNetworkLatency(event.networkLatency);
        if (networkLatency) turn.networkLatency = networkLatency;
      }
      const generationMetricsVersion = positiveInteger(event.generationMetricsVersion);
      if (generationMetricsVersion > turn.generationMetricsVersion) {
        if (turn.generationMetricsVersion < MIN_GENERATION_METRICS_VERSION) resetGenerationMetrics(turn);
        turn.generationMetricsVersion = generationMetricsVersion;
      }
      turn.generationMetricsEnabled ||=
        generationMetricsVersion >= MIN_GENERATION_METRICS_VERSION;
      if (!turn.startedAt) turn.startedAt = updatedAt;
      if (model) {
        fillUnknownSegmentModels(turn, model, event.modelSource ?? "turn-started");
        setTurnModel(turn, model, event.modelSource ?? "turn-started");
      }
      turn.updatedAt = updatedAt;
      this.turns.set(turnId, turn);
      if (turn.rolloutUsageFallback) {
        this.rolloutFallbackThreads.delete(threadId);
        this.rolloutFallbackThreads.set(threadId, updatedAt);
      }
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
      const previousResponseTotal = positiveNumber(turn.responseCumulativeTotalTokens);
      if (model) {
        // A reroute starts a new model segment. Unknown tokens before that
        // boundary must stay unresolved instead of being relabeled with the
        // new model.
        if (modelSource !== "rerouted") {
          fillUnknownSegmentModels(turn, model, modelSource);
        }
        setTurnModel(turn, model, modelSource);
      }
      const waitForRollout = event.rolloutUsageFallback == null
        ? turn.rolloutUsageFallback
        : Boolean(event.rolloutUsageFallback);
      if (waitForRollout) {
        // Legacy official usage events and rollout records describe the same
        // upstream response. Keep rollout authoritative for these events; an
        // auxiliary event explicitly opts out when Codex may not persist it.
        const modelContextWindow = positiveNumber(event.tokenUsage?.modelContextWindow);
        if (modelContextWindow > 0) turn.modelContextWindow = modelContextWindow;
        turn.updatedAt = updatedAt;
        this.turns.set(turnId, turn);
        return;
      }
      const responseId = nonEmptyString(event.responseId);
      const isNewResponse = responseId ? markUsageResponse(turn, responseId) : true;
      const shouldAdd = responseId
        ? isNewResponse
        : incomingTotal <= 0 || incomingTotal > previousResponseTotal;
      if (shouldAdd) {
        // The event can carry a stale lower-priority model after a reroute.
        // Price the delta with the model that won the source-priority check,
        // rather than relabeling a post-reroute segment with that stale value.
        addUsage(
          turn,
          last,
          turn.model || model,
          turn.modelSource || modelSource,
        );
        recordGenerationUsage(turn, last, responseId);
      }
      turn.responseCumulativeTotalTokens = Math.max(previousResponseTotal, incomingTotal);
      turn.cumulativeTotalTokens = Math.max(
        positiveNumber(turn.cumulativeTotalTokens),
        incomingTotal,
      );
      if (responseId) turn.rolloutParserVersion = ROLLOUT_PARSER_VERSION;
      const modelContextWindow = positiveNumber(event.tokenUsage?.modelContextWindow);
      if (modelContextWindow > 0) turn.modelContextWindow = modelContextWindow;
      turn.updatedAt = updatedAt;
      this.turns.set(turnId, turn);
      return;
    }

    if (event.type === "generation") {
      const generationMetricsVersion = positiveInteger(event.generationMetricsVersion);
      if (generationMetricsVersion < MIN_GENERATION_METRICS_VERSION) return;
      const turn = this.turns.get(turnId) ?? emptyTurn(turnId, threadId, "event");
      if (generationMetricsVersion > turn.generationMetricsVersion) {
        if (turn.generationMetricsVersion < MIN_GENERATION_METRICS_VERSION) resetGenerationMetrics(turn);
        turn.generationMetricsVersion = generationMetricsVersion;
      }
      turn.source = "event";
      turn.generationMetricsEnabled = true;
      if (!turn.startedAt) turn.startedAt = updatedAt;
      if (model) {
        fillUnknownSegmentModels(turn, model, event.modelSource ?? "generation");
        setTurnModel(turn, model, event.modelSource ?? "generation");
      }
      recordGenerationSample(turn, event.generation);
      turn.updatedAt = Math.max(positiveNumber(turn.updatedAt), updatedAt);
      this.turns.set(turnId, turn);
      return;
    }

    if (event.type === "generation-tool-timing") {
      const generationMetricsVersion = positiveInteger(event.generationMetricsVersion);
      if (generationMetricsVersion < MIN_GENERATION_METRICS_VERSION) return;
      const turn = this.turns.get(turnId) ?? emptyTurn(turnId, threadId, "event");
      if (generationMetricsVersion > turn.generationMetricsVersion) {
        if (turn.generationMetricsVersion < MIN_GENERATION_METRICS_VERSION) resetGenerationMetrics(turn);
        turn.generationMetricsVersion = generationMetricsVersion;
      }
      turn.source = "event";
      turn.generationMetricsEnabled = true;
      recordGenerationToolTiming(turn, event);
      turn.updatedAt = Math.max(positiveNumber(turn.updatedAt), updatedAt);
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
      this.rolloutFallbackThreads.delete(threadId);
    }
  }

  async #refreshRolloutCatalog() {
    const paths = await collectRolloutFiles(join(this.codexHome, "sessions"), 4);
    this.rolloutPathsByThread.clear();
    this.rolloutMetadataByThread.clear();
    this.recentRolloutThreads.clear();
    const discoveredPaths = new Set(paths);
    for (const path of this.rolloutMetadataByPath.keys()) {
      if (!discoveredPaths.has(path)) this.rolloutMetadataByPath.delete(path);
    }
    const catalogEntries = (await Promise.all(paths.map(async (path) => {
      let metadata = this.rolloutMetadataByPath.get(path);
      if (!metadata) {
        metadata = await readRolloutSessionMetadata(path);
        if (metadata) this.rolloutMetadataByPath.set(path, metadata);
      }
      let modifiedAt;
      try {
        modifiedAt = (await stat(path)).mtimeMs;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return null;
      }
      const threadId = metadata?.threadId ?? threadIdFromRolloutPath(path);
      return threadId ? { path, metadata, threadId, modifiedAt } : null;
    }))).filter(Boolean);
    const entriesByThread = new Map();
    for (const entry of catalogEntries) {
      const entries = entriesByThread.get(entry.threadId) ?? [];
      entries.push(entry);
      entriesByThread.set(entry.threadId, entries);
    }
    const latestEntries = [];
    for (const [threadId, entries] of entriesByThread) {
      entries.sort((left, right) => left.modifiedAt - right.modifiedAt ||
        basename(left.path).localeCompare(basename(right.path)));
      this.rolloutPathsByThread.set(threadId, entries.map((entry) => entry.path));
      const latestEntry = entries.at(-1);
      latestEntries.push(latestEntry);
      if (latestEntry.metadata) {
        this.rolloutMetadataByThread.set(threadId, latestEntry.metadata);
      }
    }
    const recentCutoff = Date.now() - RECENT_ROLLOUT_ACTIVITY_MS;
    const recentEntries = latestEntries
      .filter((entry) => entry.modifiedAt >= recentCutoff)
      .sort((left, right) => right.modifiedAt - left.modifiedAt)
      .slice(0, MAX_TRACKED_ROLLOUT_STATES);
    for (const entry of recentEntries) {
      this.recentRolloutThreads.add(entry.threadId);
    }
    if (this.#applySubagentMetadataToTurns()) {
      this.#markCacheDirty();
      this.#invalidateViewModel();
    }
    for (const [path] of this.fileStates) {
      if (!discoveredPaths.has(path)) {
        this.fileStates.delete(path);
        this.rolloutReadPromises.delete(path);
        this.#markCacheDirty();
      }
    }
    const activeHintFresh = this.activeThreadHint &&
      Date.now() - this.activeThreadHintAt < ACTIVE_THREAD_HINT_TTL_MS;
    if (this.activeThreadId && !entriesByThread.has(this.activeThreadId) &&
      !activeHintFresh) {
      this.activeThreadId = null;
      this.activeThreadHint = false;
      this.activeThreadHintAt = 0;
      this.#markCacheDirty();
    }
    if (paths.length === 0) return;

    // 没有新鲜的活动事件时，通过最近写入的 rollout 文件跟踪活动会话。
    const latestThreadId = latestEntries
      .sort((left, right) => right.modifiedAt - left.modifiedAt ||
        basename(right.path).localeCompare(basename(left.path)))[0]?.threadId;
    if (latestThreadId &&
      (!this.activeThreadId ||
        (!activeHintFresh && this.activeThreadId !== latestThreadId))) {
      this.activeThreadId = latestThreadId;
      this.activeThreadHint = false;
      this.activeThreadHintAt = 0;
      this.#markCacheDirty();
    }
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

  async #ensureRolloutStates(threadId) {
    if (!threadId) return [];
    let paths = this.rolloutPathsByThread.get(threadId);
    if (!paths) {
      await this.#refreshRolloutCatalog();
      paths = this.rolloutPathsByThread.get(threadId);
    }
    if (!Array.isArray(paths) || paths.length === 0) return [];
    const states = [];
    for (const path of paths) {
      let state = this.fileStates.get(path);
      if (!state) {
        this.#pruneRolloutStates(threadId);
        state = {
          threadId,
          path,
          offset: 0,
          pending: "",
          currentTurnId: null,
          threadModel: null,
          pendingUsageRecords: [],
          modelReconciled: false,
          parserVersion: 0,
          unknownModelChecked: false,
          unknownModelCheckOffset: 0,
          lastUsedAt: Date.now(),
        };
        this.fileStates.set(path, state);
        this.#markCacheDirty();
      }
      state.lastUsedAt = Date.now();
      if (state.parserVersion !== ROLLOUT_PARSER_VERSION) {
        state.modelReconciled = false;
        state.pendingUsageRecords = [];
        state.unknownModelChecked = false;
        state.unknownModelCheckOffset = 0;
      }
      states.push(state);
    }
    return states;
  }

  async #readAppendedRollout(state) {
    const inFlight = this.rolloutReadPromises.get(state.path);
    if (inFlight) return inFlight;
    const task = this.#readAppendedRolloutOnce(state)
      .finally(() => {
        if (this.rolloutReadPromises.get(state.path) === task) {
          this.rolloutReadPromises.delete(state.path);
        }
      });
    this.rolloutReadPromises.set(state.path, task);
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
      this.#clearRolloutTurns(state.threadId, {
        clearHistory: true,
        rolloutPath: state.path,
      });
      state.threadModel = null;
      state.pendingUsageRecords = [];
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
          this.#clearRolloutTurns(state.threadId, {
            clearHistory: true,
            rolloutPath: state.path,
          });
          state.offset = 0;
          state.pending = "";
          state.currentTurnId = null;
          state.threadModel = null;
          state.pendingUsageRecords = [];
          state.modelReconciled = false;
        },
      );
    } catch (error) {
      if (this.closed) return;
      console.error(`[token-usage] Worker 解析 rollout 失败，回退到主线程：${error.message}`);
      // A worker may have emitted a few batches before failing. Rebuild this
      // rollout from the beginning so those partial records cannot be
      // duplicated by the main-thread fallback.
      this.#clearRolloutTurns(state.threadId, {
        clearHistory: true,
        rolloutPath: state.path,
      });
      state.offset = 0;
      state.pending = "";
      state.currentTurnId = null;
      state.threadModel = null;
      state.pendingUsageRecords = [];
      state.modelReconciled = false;
      await this.#readAppendedRolloutOnMain(state, true);
      return;
    }
    if (result.missing) {
      this.fileStates.delete(state.path);
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
        this.fileStates.delete(state.path);
        this.#markCacheDirty();
        return;
      }
      throw error;
    }
    if (reconcile) {
      this.#clearRolloutTurns(state.threadId, {
        clearHistory: true,
        rolloutPath: state.path,
      });
      state.offset = 0;
      state.pending = "";
      state.currentTurnId = null;
      state.threadModel = null;
      state.pendingUsageRecords = [];
    }
    if (info.size < state.offset) {
      this.#clearRolloutTurns(state.threadId, {
        clearHistory: true,
        rolloutPath: state.path,
      });
      state.offset = 0;
      state.pending = "";
      state.currentTurnId = null;
      state.threadModel = null;
      state.pendingUsageRecords = [];
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
    const execution = record.toolExecution ?? (record.type === "tool_execution_record"
      ? record.payload
      : simplifyToolExecutionRecord(record, state.currentTurnId));
    if (execution && (!execution.threadId || execution.threadId === state.threadId)) {
      const turn = this.turns.get(execution.turnId) ??
        emptyTurn(execution.turnId, state.threadId, "rollout", state.path);
      if (turn.threadId === state.threadId) {
        recordToolExecution(turn.toolExecutionLedger, execution);
        if (!turn.rolloutPath) turn.rolloutPath = state.path;
        this.turns.set(turn.turnId, turn);
        this.#markCacheDirty();
      }
    }
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
    if (record.type === "token_usage_record") {
      const turnId = nonEmptyString(record.payload?.turn_id);
      const responseId = nonEmptyString(record.payload?.response_id);
      const usage = normalizeRolloutUsage(record.payload?.usage);
      if (!turnId || !responseId || !usage) return;
      state.currentTurnId = turnId;
      enqueuePendingUsageRecord(state, turnId, responseId, usage);
      const existing = this.turns.get(turnId);
      const turn = existing ?? emptyTurn(turnId, state.threadId, "rollout", state.path);
      // Unkeyed app-server notifications are a provisional live view. Once an
      // exact response ledger exists, rebuild from that ledger regardless of
      // provider or model so historical notifications cannot hide compaction.
      prepareRolloutUsageTurn(turn);
      if (!turn.rolloutPath) turn.rolloutPath = state.path;
      const model = turn.model || state.threadModel;
      if (model) {
        setTurnModel(turn, model, turn.modelSource || "thread-settings");
        fillUnknownSegmentModels(turn, model, turn.modelSource || "thread-settings");
      }
      const cumulativeTotal = positiveNumber(record.payload?.turn_token_usage?.total_tokens);
      const previousResponseTotal = positiveNumber(turn.responseCumulativeTotalTokens);
      // Response identity is authoritative. The cumulative figure is only a
      // display watermark: auxiliary and rollout ledgers can use independent
      // baselines, so comparing them would discard a valid newer response.
      if (markUsageResponse(turn, responseId)) {
        addUsage(turn, usage, turn.model || model, turn.modelSource);
        recordGenerationUsage(turn, usage, responseId);
      }
      turn.responseCumulativeTotalTokens = Math.max(
        previousResponseTotal,
        cumulativeTotal,
      );
      turn.cumulativeTotalTokens = Math.max(
        positiveNumber(turn.cumulativeTotalTokens),
        cumulativeTotal,
      );
      if (!turn.startedAt) turn.startedAt = parseTimestamp(record.timestamp);
      turn.updatedAt = Math.max(
        positiveNumber(turn.updatedAt),
        parseTimestamp(record.timestamp),
      );
      this.turns.set(turnId, turn);
      this.#markCacheDirty();
      return;
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
      const incomingTotal = positiveNumber(
        record.payload.info?.total_token_usage?.total_tokens,
      );
      const pairedUsageRecord = consumePendingUsageRecord(
        state,
        state.currentTurnId,
        last,
      );
      if (pairedUsageRecord) {
        const turn = existing ?? emptyTurn(
          state.currentTurnId,
          state.threadId,
          "rollout",
          state.path,
        );
        prepareRolloutUsageTurn(turn);
        turn.rolloutTokenCountTotalTokens = Math.max(
          positiveNumber(turn.rolloutTokenCountTotalTokens),
          incomingTotal,
        );
        turn.cumulativeTotalTokens = Math.max(
          positiveNumber(turn.cumulativeTotalTokens),
          incomingTotal,
        );
        const modelContextWindow = positiveNumber(record.payload.info?.model_context_window);
        if (modelContextWindow > 0) turn.modelContextWindow = modelContextWindow;
        turn.updatedAt = Math.max(
          positiveNumber(turn.updatedAt),
          parseTimestamp(record.timestamp),
        );
        this.turns.set(turn.turnId, turn);
        this.#markCacheDirty();
        return;
      }
      if (existing?.source === "event" && !existing.rolloutUsageFallback) {
        // Relay events are buffered and can arrive after this rollout record.
        // Do not advance their deduplication watermark without adding usage:
        // the matching relay event would otherwise be discarded as a duplicate.
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
      prepareRolloutUsageTurn(turn);
      const previousRolloutTotal = positiveNumber(turn.rolloutTokenCountTotalTokens);
      if (incomingTotal > 0 && incomingTotal <= previousRolloutTotal) {
        // Rollout can repeat the same cumulative token_count record, and a
        // continued task can expose an overlapping record in another file.
        // Treat the cumulative total as the common deduplication watermark.
        const modelContextWindow = positiveNumber(record.payload.info?.model_context_window);
        if (modelContextWindow > 0) turn.modelContextWindow = modelContextWindow;
        this.turns.set(turn.turnId, turn);
        this.#markCacheDirty();
        return;
      }
      addUsage(turn, last, turn.model, turn.modelSource);
      recordGenerationUsage(turn, last);
      turn.rolloutTokenCountTotalTokens = Math.max(previousRolloutTotal, incomingTotal);
      turn.cumulativeTotalTokens = Math.max(
        positiveNumber(turn.cumulativeTotalTokens),
        incomingTotal,
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

  #clearRolloutTurns(threadId, { clearHistory = false, rolloutPath = null } = {}) {
    for (const [turnId, turn] of this.turns) {
      if (turn.threadId === threadId && (!rolloutPath || turn.rolloutPath === rolloutPath)) {
        turn.toolExecutionLedger = createToolExecutionLedger();
      }
      if (turn.threadId === threadId && turn.source === "rollout" &&
        (!rolloutPath || turn.rolloutPath === rolloutPath)) {
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
      .filter(([path, state]) => state.threadId !== protectedThreadId &&
        state.threadId !== this.activeThreadId &&
        !this.rolloutFallbackThreads.has(state.threadId) &&
        !this.recentRolloutThreads.has(state.threadId) &&
        !this.rolloutReadPromises.has(path))
      .sort(([, left], [, right]) => positiveNumber(left.lastUsedAt) - positiveNumber(right.lastUsedAt));
    while (this.fileStates.size >= MAX_TRACKED_ROLLOUT_STATES && removable.length > 0) {
      const [path] = removable.shift();
      this.fileStates.delete(path);
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
        const paths = this.rolloutPathsByThread.get(threadId) ?? [];
        const states = paths.map((path) => this.fileStates.get(path)).filter(Boolean);
        if (states.length !== paths.length || states.some((state) => !state.unknownModelChecked)) {
          return threadId;
        }
        for (const state of states) {
          try {
            const info = await stat(state.path);
            if (info.size !== state.unknownModelCheckOffset) return threadId;
          } catch (error) {
            if (error.code !== "ENOENT") {
              console.error(
                `[token-usage] 检查线程 ${threadId} rollout 变化失败: ${error.message}`,
              );
            }
          }
        }
        return null;
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
            const states = await this.#ensureRolloutStates(threadId);
            if (states.length === 0) continue;
            const revision = this.cacheRevision;
            for (const state of states) {
              await this.#readAppendedRollout(state);
              if (!state.unknownModelChecked || state.unknownModelCheckOffset !== state.offset) {
                state.unknownModelChecked = true;
                state.unknownModelCheckOffset = state.offset;
                this.#markCacheDirty();
              }
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

function publicGenerationDetails(details, ledger) {
  return (Array.isArray(details) ? details : []).map((detail) => {
    const {
      requestId: _requestId,
      responseId: _responseId,
      ...publicDetail
    } = detail;
    const executions = projectToolExecutions(ledger, detail.responseId);
    return executions ? { ...publicDetail, toolExecutions: executions } : publicDetail;
  });
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
    summary.toolExecutionLedger.calls.push(...(turn.toolExecutionLedger?.calls ?? []));
    summary.toolExecutionLedger.items.push(...(turn.toolExecutionLedger?.items ?? []));
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
  summary.firstTokenLatencyTotalMs = ordered.reduce(
    (total, turn) => total + positiveNumber(turn.firstTokenLatencyTotalMs),
    0,
  );
  summary.firstTokenLatencySamples = ordered.reduce(
    (total, turn) => total + positiveInteger(turn.firstTokenLatencySamples),
    0,
  );
  summary.firstTokenLatencyMs = summary.firstTokenLatencySamples > 0
    ? summary.firstTokenLatencyTotalMs / summary.firstTokenLatencySamples
    : null;
  summary.generationDetails = ordered.flatMap((turn) =>
    Array.isArray(turn.generationDetails) ? turn.generationDetails : [])
    .map((detail, index) => ({
      ...detail,
      sequence: index + 1,
    }));
  summary.outputGenerationDurationMs = ordered.reduce(
    (total, turn) => total + positiveNumber(turn.outputGenerationDurationMs),
    0,
  );
  summary.outputGenerationTokens = ordered.reduce(
    (total, turn) => total + positiveNumber(turn.outputGenerationTokens),
    0,
  );
  summary.outputSpeed = calculateOutputSpeed(summary);
  summary.networkLatencySupported = ordered.some((turn) => turn.networkLatencySupported);
  const latestNetworkLatency = ordered
    .map((turn) => normalizeNetworkLatency(turn.networkLatency))
    .filter(Boolean)
    .sort((left, right) => left.sampledAt - right.sampledAt)
    .at(-1) ?? null;
  summary.networkLatency = latestNetworkLatency;
  summary.networkConnectionId = latestNetworkLatency?.connectionId ?? null;
  return summary;
}

function emptyTurn(turnId, threadId, source, rolloutPath = "") {
  return {
    turnId,
    threadId,
    taskKey: threadId,
    source,
    rolloutPath,
    rolloutUsageFallback: false,
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
    rolloutTokenCountTotalTokens: 0,
    responseCumulativeTotalTokens: 0,
    rolloutParserVersion: 0,
    usageResponseIds: [],
    modelContextWindow: 0,
    model: "",
    modelSource: "",
    generationMetricsVersion: 0,
    generationMetricsEnabled: false,
    firstTokenLatencyMs: null,
    firstTokenLatencyTotalMs: 0,
    firstTokenLatencySamples: 0,
    outputSpeed: null,
    outputGenerationDurationMs: 0,
    outputGenerationTokens: 0,
    networkLatencySupported: false,
    networkConnectionId: null,
    networkLatency: null,
    generationDetails: [],
    toolExecutionLedger: createToolExecutionLedger(),
    pendingGenerationSamples: [],
    pendingGenerationUsages: [],
    pendingToolTimings: [],
    costRevision: 0,
    segments: [],
    startedAt: 0,
    updatedAt: 0,
  };
}

function prepareRolloutUsageTurn(turn) {
  if (positiveInteger(turn.rolloutParserVersion) === ROLLOUT_PARSER_VERSION) return;
  for (const field of TOKEN_FIELDS) turn[toCamelCase(field)] = 0;
  turn.cumulativeTotalTokens = 0;
  turn.rolloutTokenCountTotalTokens = 0;
  turn.responseCumulativeTotalTokens = 0;
  turn.usageResponseIds = [];
  turn.segments = [];
  turn.costRevision = positiveInteger(turn.costRevision) + 1;
  turn.rolloutParserVersion = ROLLOUT_PARSER_VERSION;
  resetGenerationUsageAttribution(turn);
}

function markUsageResponse(turn, responseId) {
  const normalized = nonEmptyString(responseId);
  if (!normalized) return false;
  if (!Array.isArray(turn.usageResponseIds)) turn.usageResponseIds = [];
  if (turn.usageResponseIds.includes(normalized)) return false;
  turn.usageResponseIds.push(normalized);
  if (turn.usageResponseIds.length > MAX_SEEN_USAGE_RESPONSE_IDS) {
    turn.usageResponseIds.splice(
      0,
      turn.usageResponseIds.length - MAX_SEEN_USAGE_RESPONSE_IDS,
    );
  }
  return true;
}

function enqueuePendingUsageRecord(state, turnId, responseId, usage) {
  if (!Array.isArray(state.pendingUsageRecords)) state.pendingUsageRecords = [];
  state.pendingUsageRecords.push({
    turnId,
    responseId,
    usage: normalizeRolloutUsage(usage),
  });
  if (state.pendingUsageRecords.length > MAX_PENDING_USAGE_RECORDS) {
    state.pendingUsageRecords.splice(
      0,
      state.pendingUsageRecords.length - MAX_PENDING_USAGE_RECORDS,
    );
  }
}

function consumePendingUsageRecord(state, turnId, summaryUsage) {
  if (!Array.isArray(state.pendingUsageRecords)) return null;
  const normalizedSummary = normalizeRolloutUsage(summaryUsage);
  let index = state.pendingUsageRecords.findIndex((record) =>
    record.turnId === turnId && usagesEqual(record.usage, normalizedSummary));
  if (index < 0 && !hasItemizedUsage(normalizedSummary)) {
    // Compaction summaries in some Codex versions expose only a thread-level
    // total. They cannot be priced independently, but a preceding exact
    // response record already contains the complete breakdown.
    index = state.pendingUsageRecords.findIndex((record) => record.turnId === turnId);
  }
  if (index < 0) return null;
  return state.pendingUsageRecords.splice(index, 1)[0] ?? null;
}

function usagesEqual(left, right) {
  if (!left || !right) return false;
  return TOKEN_FIELDS.every((field) =>
    positiveNumber(left[field]) === positiveNumber(right[field]));
}

function hasItemizedUsage(usage) {
  if (!usage) return false;
  return TOKEN_FIELDS
    .filter((field) => field !== "total_tokens")
    .some((field) => positiveNumber(usage[field]) > 0);
}

function resetGenerationUsageAttribution(turn) {
  turn.outputSpeed = null;
  turn.outputGenerationDurationMs = 0;
  turn.outputGenerationTokens = 0;
  turn.pendingGenerationUsages = [];
  turn.pendingGenerationSamples = [];
  for (const detail of Array.isArray(turn.generationDetails) ? turn.generationDetails : []) {
    const hasNonTextOutput = detail.outputSpeedUnavailableReason === "unattributed-output";
    detail.outputSpeed = null;
    detail.outputGenerationTokens = 0;
    assignOutputPhaseSpeed(detail, null);
    const sample = {
      responseId: nonEmptyString(detail.responseId),
      hasVisibleText: Boolean(detail.hasVisibleText),
      hasNonTextOutput,
      generationDurationMs: positiveNumber(detail.generationDurationMs),
      ...outputPhaseFields(detail),
      detailSequence: positiveInteger(detail.sequence),
    };
    detail.outputSpeedUnavailableReason = generationSpeedWindow(sample).reason;
    turn.pendingGenerationSamples.push(sample);
  }
  trimGenerationQueue(turn.pendingGenerationSamples);
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

function recordGenerationSample(turn, value) {
  if (!value || typeof value !== "object") return;
  const textPhases = normalizeTextPhases(value.textPhases);
  const networkLatency = normalizeNetworkLatency(value.networkLatency);
  const hasVisibleText = Boolean(value.hasVisibleText) || textPhases.length > 0;
  const hasNonTextOutput = Boolean(value.hasNonTextOutput);
  const derivedFirstTokenLatencyMs = textPhases.reduce(
    (minimum, phase) => Math.min(minimum, positiveNumber(phase.startLatencyMs) || Infinity),
    Infinity,
  );
  const firstTokenLatencyMs = positiveNumber(value.firstTokenLatencyMs) ||
    (Number.isFinite(derivedFirstTokenLatencyMs) ? derivedFirstTokenLatencyMs : 0);
  const derivedGenerationDurationMs = textPhases.reduce(
    (total, phase) => total + positiveNumber(phase.durationMs),
    0,
  );
  const generationDurationMs = positiveNumber(value.generationDurationMs) ||
    derivedGenerationDurationMs;
  const detailSequence = nextGenerationSequence(turn);
  if (hasVisibleText && firstTokenLatencyMs > 0) {
    turn.firstTokenLatencyTotalMs += firstTokenLatencyMs;
    turn.firstTokenLatencySamples += 1;
    turn.firstTokenLatencyMs = turn.firstTokenLatencyTotalMs / turn.firstTokenLatencySamples;
  }
  const detail = {
    requestId: nonEmptyString(value.requestId),
    responseId: nonEmptyString(value.responseId),
    sequence: detailSequence,
    hasVisibleText,
    followsToolResult: Boolean(value.followsToolResult),
    toolNames: Array.isArray(value.toolNames)
      ? [...new Set(value.toolNames.map(nonEmptyString).filter(Boolean))]
      : [],
    responseLatencyMs: nonNegativeNumberOrNull(value.responseLatencyMs),
    reasoningDurationMs: nonNegativeNumberOrNull(value.reasoningDurationMs),
    firstTokenLatencyMs: firstTokenLatencyMs || null,
    outputSpeed: null,
    outputGenerationTokens: 0,
    generationDurationMs: generationDurationMs || null,
    textPhases,
    ...outputPhaseFields(value),
    networkLatency,
    toolTiming: normalizeToolTiming(value.toolTiming),
    outputSpeedUnavailableReason: Array.isArray(value.outputPhases)
      ? generationSpeedWindow(value).reason
      : !hasVisibleText ? "no-visible-text" : hasNonTextOutput ? "unattributed-output" : null,
  };
  turn.generationDetails.push(detail);
  if (networkLatency) {
    turn.networkLatencySupported = true;
    turn.networkConnectionId = networkLatency.connectionId;
    turn.networkLatency = networkLatency;
  }
  applyPendingToolTimings(turn, detail);
  turn.pendingGenerationSamples.push({
    responseId: nonEmptyString(value.responseId),
    hasVisibleText,
    hasNonTextOutput,
    generationDurationMs,
    ...outputPhaseFields(value),
    detailSequence,
  });
  trimGenerationQueue(turn.pendingGenerationSamples);
  reconcileGenerationMetrics(turn);
}

function resetGenerationMetrics(turn) {
  turn.generationMetricsEnabled = false;
  turn.firstTokenLatencyMs = null;
  turn.firstTokenLatencyTotalMs = 0;
  turn.firstTokenLatencySamples = 0;
  turn.outputSpeed = null;
  turn.outputGenerationDurationMs = 0;
  turn.outputGenerationTokens = 0;
  turn.generationDetails = [];
  turn.pendingGenerationSamples = [];
  turn.pendingGenerationUsages = [];
  turn.pendingToolTimings = [];
}

function recordGenerationToolTiming(turn, event) {
  const requestId = nonEmptyString(event.requestId);
  const toolTiming = normalizeToolTiming(event.toolTiming);
  if (!requestId || !toolTiming) return;
  const detail = turn.generationDetails.find((value) => value.requestId === requestId);
  if (detail) {
    mergeToolTiming(detail, toolTiming);
    return;
  }
  turn.pendingToolTimings.push({ requestId, toolTiming });
  trimGenerationQueue(turn.pendingToolTimings);
}

function applyPendingToolTimings(turn, detail) {
  if (!detail.requestId || turn.pendingToolTimings.length === 0) return;
  const remaining = [];
  for (const pending of turn.pendingToolTimings) {
    if (pending.requestId === detail.requestId) mergeToolTiming(detail, pending.toolTiming);
    else remaining.push(pending);
  }
  turn.pendingToolTimings = remaining;
}

function mergeToolTiming(detail, toolTiming) {
  detail.toolTiming = toolTiming;
  detail.toolNames = [...new Set([
    ...(Array.isArray(detail.toolNames) ? detail.toolNames : []),
    ...toolTiming.toolNames,
  ])];
}

function normalizeToolTiming(value) {
  const durationMs = nonNegativeNumberOrNull(value?.durationMs);
  if (durationMs == null) return null;
  const calls = Array.isArray(value?.calls)
    ? value.calls.map((call) => {
      const callDurationMs = nonNegativeNumberOrNull(call?.durationMs);
      if (callDurationMs == null) return null;
      return {
        toolName: nonEmptyString(call?.toolName),
        preparationDurationMs: nonNegativeNumberOrNull(call?.preparationDurationMs),
        durationMs: callDurationMs,
      };
    }).filter(Boolean)
    : [];
  return {
    toolNames: Array.isArray(value?.toolNames)
      ? [...new Set(value.toolNames.map(nonEmptyString).filter(Boolean))]
      : [],
    toolCount: positiveInteger(value?.toolCount) || calls.length,
    readyLatencyMs: nonNegativeNumberOrNull(value?.readyLatencyMs),
    preparationStartLatencyMs: nonNegativeNumberOrNull(value?.preparationStartLatencyMs),
    preparationDurationMs: nonNegativeNumberOrNull(value?.preparationDurationMs),
    durationMs,
    calls,
  };
}

function normalizeTextPhases(value) {
  if (!Array.isArray(value)) return [];
  return value.map((phase) => {
    const startLatencyMs = nonNegativeNumberOrNull(phase?.startLatencyMs);
    if (startLatencyMs == null) return null;
    const type = ["commentary", "final_answer"].includes(phase?.phase)
      ? phase.phase
      : "unknown";
    return {
      phase: type,
      startLatencyMs,
      durationMs: nonNegativeNumberOrNull(phase?.durationMs),
    };
  }).filter(Boolean).sort((left, right) => left.startLatencyMs - right.startLatencyMs);
}

function outputPhaseFields(value) {
  const outputPhases = normalizeOutputPhases(value?.outputPhases);
  return outputPhases === null ? {} : {
    outputPhases,
    outputPhasesComplete: Boolean(value.outputPhasesComplete),
  };
}

function normalizeNetworkLatency(value) {
  if (!value || typeof value !== "object") return null;
  const status = ["stable", "fluctuating", "reconnecting", "reconnected"]
    .includes(value.status)
    ? value.status
    : null;
  const latencyMs = nonNegativeNumberOrNull(value.latencyMs);
  const sampledAt = positiveNumber(value.sampledAt) || null;
  const connectionId = nonEmptyString(value.connectionId);
  if (!status || !sampledAt || !connectionId) return null;
  return { status, latencyMs, sampledAt, connectionId };
}

function recordGenerationUsage(turn, usage, responseId = null) {
  if (!turn.generationMetricsEnabled) return;
  const normalizedResponseId = nonEmptyString(responseId);
  if (!normalizedResponseId &&
    positiveInteger(turn.generationMetricsVersion) >= MIN_GENERATION_METRICS_VERSION) return;
  const outputTokens = positiveNumber(usage?.output_tokens);
  if (outputTokens <= 0) return;
  const reasoningTokens = positiveNumber(usage?.reasoning_output_tokens);
  turn.pendingGenerationUsages.push({
    responseId: normalizedResponseId,
    // Historical field name: this includes generated tool input as well as text.
    visibleOutputTokens: Math.max(0, outputTokens - reasoningTokens),
  });
  trimGenerationQueue(turn.pendingGenerationUsages);
  reconcileGenerationMetrics(turn);
}

function reconcileGenerationMetrics(turn) {
  for (;;) {
    const pair = takeNextGenerationPair(turn);
    if (!pair) break;
    const { sample, usage } = pair;
    const nonReasoningOutputTokens = positiveNumber(usage.visibleOutputTokens);
    const detail = turn.generationDetails.find((value) =>
      value.sequence === sample.detailSequence);
    const window = generationSpeedWindow(sample);
    if (window.reason) {
      if (detail) detail.outputSpeedUnavailableReason = window.reason;
      continue;
    }
    // TPOT excludes the first output token because its delay is represented by TTFT.
    const measuredOutputTokens = Math.max(0, nonReasoningOutputTokens - 1);
    if (measuredOutputTokens <= 0) {
      if (detail) detail.outputSpeedUnavailableReason = "insufficient-data";
      continue;
    }
    turn.outputGenerationTokens += measuredOutputTokens;
    turn.outputGenerationDurationMs += window.durationMs;
    if (detail) {
      detail.outputGenerationTokens = measuredOutputTokens;
      detail.outputSpeed = measuredOutputTokens / (window.durationMs / 1_000);
      detail.outputSpeedUnavailableReason = null;
      assignOutputPhaseSpeed(detail, detail.outputSpeed);
    }
  }
  turn.outputSpeed = calculateOutputSpeed(turn);
}

function takeNextGenerationPair(turn) {
  const samples = turn.pendingGenerationSamples;
  const usages = turn.pendingGenerationUsages;
  if (!Array.isArray(samples) || !Array.isArray(usages) ||
    samples.length === 0 || usages.length === 0) return null;
  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
    const responseId = nonEmptyString(samples[sampleIndex]?.responseId);
    if (!responseId) continue;
    const usageIndex = usages.findIndex((usage) => usage?.responseId === responseId);
    if (usageIndex < 0) continue;
    return {
      sample: samples.splice(sampleIndex, 1)[0],
      usage: usages.splice(usageIndex, 1)[0],
    };
  }
  // Older app-server and rollout formats do not carry response IDs. Pair only
  // when both sides are unkeyed; mixing a keyed and an unkeyed record could
  // silently attribute compaction or tool output to the next visible answer.
  const sampleIndex = samples.findIndex((sample) => !nonEmptyString(sample?.responseId));
  const usageIndex = usages.findIndex((usage) => !nonEmptyString(usage?.responseId));
  if (sampleIndex < 0 || usageIndex < 0) return null;
  const rawUsage = usages.splice(usageIndex, 1)[0];
  return {
    sample: samples.splice(sampleIndex, 1)[0],
    usage: typeof rawUsage === "number"
      ? { responseId: null, visibleOutputTokens: positiveNumber(rawUsage) }
      : rawUsage,
  };
}

function nextGenerationSequence(turn) {
  return turn.generationDetails.reduce(
    (maximum, detail) => Math.max(maximum, positiveInteger(detail?.sequence)),
    0,
  ) + 1;
}

function calculateOutputSpeed(turn) {
  const durationMs = positiveNumber(turn.outputGenerationDurationMs);
  const tokens = positiveNumber(turn.outputGenerationTokens);
  return durationMs > 0 && tokens > 0 ? tokens / (durationMs / 1_000) : null;
}

function trimGenerationQueue(queue) {
  if (queue.length > MAX_PENDING_GENERATION_RECORDS) {
    queue.splice(0, queue.length - MAX_PENDING_GENERATION_RECORDS);
  }
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

function normalizeCachedTurn(value, { generationMetricsCompatible = false } = {}) {
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
  turn.rolloutUsageFallback = Boolean(value.rolloutUsageFallback);
  turn.toolExecutionLedger = normalizeToolExecutionLedger(value.toolExecutionLedger);
  const cachedGenerationMetricsVersion = positiveInteger(value.generationMetricsVersion);
  const keepGenerationMetrics = generationMetricsCompatible &&
    cachedGenerationMetricsVersion >= MIN_GENERATION_METRICS_VERSION;
  turn.generationMetricsVersion = keepGenerationMetrics ? cachedGenerationMetricsVersion : 0;
  turn.generationMetricsEnabled = keepGenerationMetrics && Boolean(value.generationMetricsEnabled);
  turn.firstTokenLatencyMs = keepGenerationMetrics
    ? positiveNumber(value.firstTokenLatencyMs) || null
    : null;
  turn.firstTokenLatencyTotalMs = keepGenerationMetrics
    ? positiveNumber(value.firstTokenLatencyTotalMs)
    : 0;
  turn.firstTokenLatencySamples = keepGenerationMetrics
    ? positiveInteger(value.firstTokenLatencySamples)
    : 0;
  turn.outputSpeed = keepGenerationMetrics ? positiveNumber(value.outputSpeed) || null : null;
  turn.outputGenerationDurationMs = keepGenerationMetrics
    ? positiveNumber(value.outputGenerationDurationMs)
    : 0;
  turn.outputGenerationTokens = keepGenerationMetrics
    ? positiveNumber(value.outputGenerationTokens)
    : 0;
  turn.networkLatencySupported = Boolean(value.networkLatencySupported);
  turn.networkConnectionId = nonEmptyString(value.networkConnectionId);
  turn.networkLatency = normalizeNetworkLatency(value.networkLatency);
  turn.generationDetails = keepGenerationMetrics && Array.isArray(value.generationDetails)
    ? value.generationDetails.map((detail, index) => ({
        requestId: nonEmptyString(detail?.requestId),
        responseId: nonEmptyString(detail?.responseId),
        sequence: positiveInteger(detail?.sequence) || index + 1,
        hasVisibleText: Boolean(detail?.hasVisibleText ?? detail?.firstTokenLatencyMs),
        followsToolResult: Boolean(detail?.followsToolResult),
        toolNames: Array.isArray(detail?.toolNames)
          ? [...new Set(detail.toolNames.map(nonEmptyString).filter(Boolean))]
          : [],
        responseLatencyMs: nonNegativeNumberOrNull(detail?.responseLatencyMs),
        reasoningDurationMs: nonNegativeNumberOrNull(detail?.reasoningDurationMs),
        firstTokenLatencyMs: positiveNumber(detail?.firstTokenLatencyMs) || null,
        outputSpeed: positiveNumber(detail?.outputSpeed) || null,
        outputGenerationTokens: positiveNumber(detail?.outputGenerationTokens),
        generationDurationMs: nonNegativeNumberOrNull(detail?.generationDurationMs),
        textPhases: normalizeTextPhases(detail?.textPhases),
        ...outputPhaseFields(detail),
        networkLatency: normalizeNetworkLatency(detail?.networkLatency),
        toolTiming: normalizeToolTiming(detail?.toolTiming),
        outputSpeedUnavailableReason: [
          "unattributed-output",
          "insufficient-data",
          "no-visible-text",
        ]
          .includes(detail?.outputSpeedUnavailableReason)
          ? detail.outputSpeedUnavailableReason
          : null,
      }))
    : [];
  turn.pendingGenerationSamples = keepGenerationMetrics && Array.isArray(value.pendingGenerationSamples)
    ? value.pendingGenerationSamples.slice(-MAX_PENDING_GENERATION_RECORDS).map((sample) => ({
        responseId: nonEmptyString(sample?.responseId),
        hasVisibleText: Boolean(sample?.hasVisibleText),
        hasNonTextOutput: Boolean(sample?.hasNonTextOutput),
        generationDurationMs: positiveNumber(sample?.generationDurationMs),
        ...outputPhaseFields(sample),
        detailSequence: positiveInteger(sample?.detailSequence),
      }))
    : [];
  turn.pendingGenerationUsages = keepGenerationMetrics && Array.isArray(value.pendingGenerationUsages)
    ? value.pendingGenerationUsages
        .slice(-MAX_PENDING_GENERATION_RECORDS)
        .map((usage) => typeof usage === "number"
          ? { responseId: null, visibleOutputTokens: positiveNumber(usage) }
          : {
              responseId: nonEmptyString(usage?.responseId),
              visibleOutputTokens: positiveNumber(usage?.visibleOutputTokens),
            })
    : [];
  turn.pendingToolTimings = keepGenerationMetrics && Array.isArray(value.pendingToolTimings)
    ? value.pendingToolTimings.slice(-MAX_PENDING_GENERATION_RECORDS)
        .map((pending) => ({
          requestId: nonEmptyString(pending?.requestId),
          toolTiming: normalizeToolTiming(pending?.toolTiming),
        }))
        .filter((pending) => pending.requestId && pending.toolTiming)
    : [];
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
  turn.rolloutTokenCountTotalTokens = positiveNumber(value.rolloutTokenCountTotalTokens);
  turn.responseCumulativeTotalTokens = positiveNumber(value.responseCumulativeTotalTokens) ||
    (turn.source === "event" && !turn.rolloutUsageFallback
      ? turn.cumulativeTotalTokens
      : 0);
  turn.rolloutParserVersion = positiveInteger(value.rolloutParserVersion);
  turn.usageResponseIds = Array.isArray(value.usageResponseIds)
    ? [...new Set(value.usageResponseIds.map(nonEmptyString).filter(Boolean))]
        .slice(-MAX_SEEN_USAGE_RESPONSE_IDS)
    : [];
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
    pendingUsageRecords: Array.isArray(value.pendingUsageRecords)
      ? value.pendingUsageRecords
          .map((record) => ({
            turnId: nonEmptyString(record?.turnId),
            responseId: nonEmptyString(record?.responseId),
            usage: normalizeRolloutUsage(record?.usage),
          }))
          .filter((record) => record.turnId && record.responseId && record.usage)
          .slice(-MAX_PENDING_USAGE_RECORDS)
      : [],
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

function threadIdFromRolloutPath(path) {
  const match = basename(path).match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/i);
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

function nonNegativeNumberOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
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
