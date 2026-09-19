import { stat } from "node:fs/promises";
import { watch } from "node:fs";
import { basename, dirname, join } from "node:path";
import { defaultAccountDataDir } from "./platform.mjs";
import { TokenPricingManager } from "./token-pricing.mjs";
import { createToolExecutionLedger } from "./tool-executions.mjs";
import { CACHE_VERSION, MIN_SUPPORTED_CACHE_VERSION, MIN_GENERATION_METRICS_CACHE_VERSION, DISCOVERY_INTERVAL_MS, MAX_VIEW_TURNS, MAX_STORED_TURNS, MAX_TRACKED_ROLLOUT_STATES, MAX_TRACKED_TURN_STATES, MAX_HISTORICAL_THREADS, COST_CACHE_VERSION, ROLLOUT_PARSER_VERSION, MAX_SEEN_EVENT_IDS, CACHE_PERSIST_DELAY_MS, UNKNOWN_ROLLOUT_CHECK_INTERVAL_MS, UNKNOWN_ROLLOUT_RECONCILE_CONCURRENCY, ACTIVE_THREAD_HINT_TTL_MS, EVENT_WATCH_DEBOUNCE_MS, resolveCodexHome, positiveNumber, positiveInteger, nonEmptyString } from "./token-usage/contract.mjs";
import { RolloutWorkerClient } from "./token-usage/rollout-worker.mjs";
import { buildUsageViewModel } from "./token-usage/display.mjs";
import { applySubagentMetadata } from "./token-usage/subagents.mjs";
import { turnHasUnknownModel, calculateTurnCost, mergeUsageSegment, compactUsageSegments } from "./token-usage/turns.mjs";
import { normalizeCachedTurn, normalizeCachedFileState, normalizeCachedHistory, readJson, writeJsonAtomic } from "./token-usage/cache.mjs";
import { readAppendedChunks, refreshRolloutCatalogFiles } from "./token-usage/rollout-files.mjs";
import { processRolloutRecord } from "./token-usage/rollout-records.mjs";
import { processTurnUsageEvent } from "./token-usage/usage-events.mjs";
import { EXPECTED_CODEX_TURN_STATE_BYTES } from "./relay-contract.mjs";

function unknownTurnStateViewModel() {
  return {
    status: "unknown",
    expectedByteLength: EXPECTED_CODEX_TURN_STATE_BYTES,
    byteLength: null,
    model: null,
    observedAt: null,
  };
}

function normalizedTurnState(value) {
  const threadId = nonEmptyString(value?.threadId);
  const byteLength = Number(value?.byteLength);
  const observedAt = positiveNumber(value?.observedAt ?? value?.recordedAt);
  if (!threadId || !Number.isInteger(byteLength) || byteLength < 0 || !observedAt) return null;
  return {
    threadId,
    status: byteLength === EXPECTED_CODEX_TURN_STATE_BYTES ? "match" : "mismatch",
    expectedByteLength: EXPECTED_CODEX_TURN_STATE_BYTES,
    byteLength,
    model: nonEmptyString(value?.model),
    observedAt,
  };
}

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
    this.turnStates = new Map();
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
    this.rolloutReader = new RolloutWorkerClient();

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
        this.#invalidateViewModel();
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
    this.viewModelCache = buildUsageViewModel({
      historicalSegmentsByThread: this.historicalSegmentsByThread,
      historicalCostCache: this.historicalCostCache,
      turns: this.turns,
      pricingManager: this.pricingManager,
      rolloutMetadataByThread: this.rolloutMetadataByThread,
      maxViewTurns: this.maxViewTurns,
      initializing: this.initializing,
      error: this.error,
      getCachedTurnCost: turn => this.#getCachedTurnCost(turn),
    });
    this.viewModelDirty = false;
    return this.viewModelCache;
  }

  getTurnStateViewModel(threadId) {
    const normalized = nonEmptyString(threadId);
    const state = normalized ? this.turnStates.get(normalized) : null;
    if (!state) return unknownTurnStateViewModel();
    const { threadId: _threadId, ...view } = state;
    return { ...view };
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
    this.rolloutReader.closeRolloutWorker();
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
    const revision = this.cacheRevision;
    this.#startEventWatcher();
    // Exchange-rate refresh is deliberately detached from usage parsing. A
    // cached rate is sufficient for the current view; the pricing listener
    // invalidates CNY values when a newer rate arrives.
    void Promise.resolve(this.pricingManager.refreshExchangeRate()).catch((error) => {
      console.error(`[token-usage] 汇率刷新失败: ${error.message}`);
    });
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
    if (this.cacheRevision !== revision || this.error != null) this.#invalidateViewModel();
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
    for (const value of Array.isArray(cached.turnStates) ? cached.turnStates : []) {
      const state = normalizedTurnState(value);
      if (state) this.turnStates.set(state.threadId, state);
    }
    while (this.turnStates.size > MAX_TRACKED_TURN_STATES) {
      this.turnStates.delete(this.turnStates.keys().next().value);
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
    this.turnStates.clear();
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
      turnStates: [...this.turnStates.values()],
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
      this.turnStates.clear();
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

    if (event.type === "turn-state-observed") {
      const state = normalizedTurnState({ ...event, observedAt: updatedAt });
      if (!state) return;
      this.turnStates.delete(threadId);
      this.turnStates.set(threadId, state);
      while (this.turnStates.size > MAX_TRACKED_TURN_STATES) {
        this.turnStates.delete(this.turnStates.keys().next().value);
      }
      return;
    }

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

    processTurnUsageEvent(event, { turns: this.turns, rolloutFallbackThreads: this.rolloutFallbackThreads, threadId, model, updatedAt });
  }

  async #refreshRolloutCatalog() {
    const { paths, discoveredPaths, entriesByThread, latestEntries } = await refreshRolloutCatalogFiles(this.codexHome, {
      rolloutPathsByThread: this.rolloutPathsByThread,
      rolloutMetadataByPath: this.rolloutMetadataByPath,
      rolloutMetadataByThread: this.rolloutMetadataByThread,
      recentRolloutThreads: this.recentRolloutThreads,
    });
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
    return applySubagentMetadata({ rolloutMetadataByThread: this.rolloutMetadataByThread, turns: this.turns, loggedSubagentModelTransitions: this.loggedSubagentModelTransitions });
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
      result = await this.rolloutReader.readRolloutInWorker(
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
    processRolloutRecord(record, state, { turns: this.turns, markDirty: () => this.#markCacheDirty() });
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
