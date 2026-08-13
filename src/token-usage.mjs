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
import { accumulateTokenCost, TokenPricingManager } from "./token-pricing.mjs";

const CACHE_VERSION = 3;
const DISCOVERY_INTERVAL_MS = 5_000;
const MAX_VIEW_TURNS = 120;
const READ_CHUNK_BYTES = 1024 * 1024;
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
  rerouted: 2,
  "turn-context": 3,
});

const ROLLOUT_WORKER_SOURCE = String.raw`
const { parentPort } = require("node:worker_threads");
const { open, stat } = require("node:fs/promises");

const READ_CHUNK_BYTES = 1024 * 1024;

parentPort.on("message", async (request) => {
  try {
    const result = await readRollout(request);
    parentPort.postMessage({ id: request.id, ok: true, ...result });
  } catch (error) {
    parentPort.postMessage({
      id: request.id,
      ok: false,
      error: error?.stack || error?.message || String(error),
    });
  }
});

async function readRollout(request) {
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
  let reset = false;
  if (info.size < offset) {
    offset = 0;
    pending = "";
    currentTurnId = null;
    reset = true;
  }
  if (info.size === offset) {
    return { offset, pending, currentTurnId, reset, records: [] };
  }

  const records = [];
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
        const simplified = simplifyRecord(record, currentTurnId);
        currentTurnId = simplified.currentTurnId;
        if (simplified.record) records.push(simplified.record);
      }
    }
  } finally {
    await handle.close();
  }
  return { offset, pending, currentTurnId, reset, records };
}

function simplifyRecord(record, currentTurnId) {
  const payload = record.payload;
  if (record.type === "turn_context" && payload?.turn_id) {
    const turnId = String(payload.turn_id);
    return {
      currentTurnId: turnId,
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
      record: null,
    };
  }
  if (record.type !== "event_msg" || !payload) {
    return { currentTurnId, record: null };
  }
  if (payload.type === "turn_aborted") {
    const turnId = payload.turn_id ? String(payload.turn_id) : currentTurnId;
    return {
      currentTurnId: turnId,
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
      record: {
        timestamp: record.timestamp,
        type: "event_msg",
        payload: { type: "task_complete" },
      },
    };
  }
  return { currentTurnId, record: null };
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
    this.activeThreadId = null;
    this.rolloutPathsByThread = new Map();
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
    this.changeListeners = new Set();
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
      await this.#loadCache();
      await this.#refreshOnce({ forceDiscovery: true });
      this.#startEventWatcher();
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
    const mappedTurns = [...this.turns.values()]
      .filter((turn) => turn.totalTokens > 0 &&
        (turn.completed || turn.threadId === this.activeThreadId))
      .sort((left, right) => left.updatedAt - right.updatedAt)
      .map((turn) => {
        const rawCost = calculateTurnCost(turn, this.pricingManager);
        const cost = this.pricingManager.toViewModel(rawCost);
        const taskCost = cumulativeCosts.get(turn.taskKey) ?? {
          available: true,
          totalCny: 0,
        };
        if (cost.available) taskCost.totalCny += positiveNumber(cost.totalCny);
        else taskCost.available = false;
        cumulativeCosts.set(turn.taskKey, taskCost);
        const {
          taskKey: _taskKey,
          source: _source,
          modelSource: _modelSource,
          segments: _segments,
          rolloutPath: _rolloutPath,
          ...publicTurn
        } = turn;
        return {
          ...publicTurn,
          cost: {
            ...cost,
            cumulativeAvailable: taskCost.available,
            cumulativeCny: taskCost.available ? taskCost.totalCny : null,
          },
        };
      });
    const activeTurns = this.activeThreadId
      ? mappedTurns.filter((turn) => turn.threadId === this.activeThreadId)
      : [];
    const activeTurnIds = new Set(activeTurns.map((turn) => turn.turnId));
    const recentTurns = mappedTurns
      .filter((turn) => !activeTurnIds.has(turn.turnId))
      .slice(-this.maxViewTurns);
    this.viewModelCache = {
      status: this.initializing ? "loading" : this.error ? "error" : "ready",
      error: this.error,
      turns: [...recentTurns, ...activeTurns]
        .sort((left, right) => left.updatedAt - right.updatedAt),
    };
    this.viewModelDirty = false;
    return this.viewModelCache;
  }

  close() {
    clearTimeout(this.eventWatchTimer);
    this.eventWatchTimer = null;
    this.eventWatcher?.close();
    this.eventWatcher = null;
    this.changeListeners.clear();
    this.#closeRolloutWorker();
    this.fileStates.clear();
    this.turns.clear();
    this.seenEventIds.clear();
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
    if (this.eventWatcher) return;
    try {
      this.eventWatcher = watch(
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
      this.eventWatcher.on("error", (error) => {
        console.error(`[token-usage] Token 事件监听失败: ${error.message}`);
      });
    } catch (error) {
      console.error(`[token-usage] 无法监听 Token 事件: ${error.message}`);
    }
  }

  async #refreshOnce({ forceDiscovery }) {
    await this.pricingManager.refreshExchangeRate();
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
    if (this.cacheDirty) await this.#persistCache();
    this.error = null;
    return this.getViewModel();
  }

  async #loadCache() {
    const cached = await readJson(this.cachePath);
    if (!cached || cached.version !== CACHE_VERSION) return;
    this.eventState = {
      offset: positiveInteger(cached.eventState?.offset),
      pending: String(cached.eventState?.pending ?? ""),
    };
    this.seenEventIds = new Set(Array.isArray(cached.seenEventIds)
      ? cached.seenEventIds.map(String)
      : []);
    this.activeThreadId = nonEmptyString(cached.activeThreadId);
    for (const value of Array.isArray(cached.turns) ? cached.turns : []) {
      const turn = normalizeCachedTurn(value);
      if (turn) this.turns.set(turn.turnId, turn);
    }
    for (const value of Array.isArray(cached.fileStates) ? cached.fileStates : []) {
      const state = normalizeCachedFileState(value);
      if (state) this.fileStates.set(state.threadId, state);
    }
    this.#invalidateViewModel();
  }

  async #persistCache() {
    await writeJsonAtomic(this.cachePath, {
      version: CACHE_VERSION,
      eventState: this.eventState,
      seenEventIds: [...this.seenEventIds],
      activeThreadId: this.activeThreadId,
      fileStates: [...this.fileStates.values()],
      turns: [...this.turns.values()],
    });
    this.cacheDirty = false;
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
      this.cacheDirty = true;
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
    this.cacheDirty = true;
    this.#invalidateViewModel();
    const threadId = nonEmptyString(event.threadId);
    if (!threadId) return;
    const model = nonEmptyString(event.model);
    const updatedAt = positiveNumber(event.recordedAt) || Date.now();

    if (event.type === "thread-active") {
      this.activeThreadId = threadId;
      if (model) this.#fillThreadModel(threadId, model);
      return;
    }

    const turnId = nonEmptyString(event.turnId);
    if (!turnId) return;
    if (event.type === "usage") {
      const last = normalizeProtocolUsage(event.tokenUsage?.last);
      if (!last) return;
      let turn = this.turns.get(turnId);
      if (!turn || turn.source !== "event") {
        const previous = turn;
        turn = emptyTurn(turnId, threadId, "event");
        if (previous) {
          turn.completed = previous.completed;
          turn.status = previous.status;
          turn.model = previous.model;
          turn.modelSource = previous.modelSource;
          turn.modelContextWindow = previous.modelContextWindow;
          turn.updatedAt = previous.updatedAt;
        }
      }
      setTurnModel(turn, model, event.modelSource ?? "thread");
      addUsage(turn, last, turn.model, turn.modelSource);
      turn.cumulativeTotalTokens = positiveNumber(event.tokenUsage?.total?.totalTokens);
      const modelContextWindow = positiveNumber(event.tokenUsage?.modelContextWindow);
      if (modelContextWindow > 0) turn.modelContextWindow = modelContextWindow;
      turn.updatedAt = updatedAt;
      this.turns.set(turnId, turn);
      return;
    }

    if (event.type === "turn-completed") {
      const turn = this.turns.get(turnId);
      if (!turn) return;
      setTurnModel(turn, model, event.modelSource ?? "thread");
      turn.status = nonEmptyString(event.status);
      turn.completed = TERMINAL_TURN_STATUSES.has(turn.status);
      turn.updatedAt = updatedAt;
    }
  }

  #fillThreadModel(threadId, model) {
    for (const turn of this.turns.values()) {
      if (turn.threadId !== threadId) continue;
      setTurnModel(turn, model, "thread");
    }
    this.#invalidateViewModel();
  }

  async #refreshRolloutCatalog() {
    const paths = await collectRolloutFiles(join(this.codexHome, "sessions"), 4);
    this.rolloutPathsByThread.clear();
    for (const path of paths) {
      const threadId = threadIdFromRolloutPath(path);
      if (threadId) this.rolloutPathsByThread.set(threadId, path);
    }
    if (!this.activeThreadId && paths.length > 0) {
      const latestPath = [...paths].sort((left, right) => basename(right).localeCompare(basename(left)))[0];
      this.activeThreadId = threadIdFromRolloutPath(latestPath);
      this.cacheDirty = Boolean(this.activeThreadId);
    }
  }

  async #ensureActiveRollout() {
    const threadId = this.activeThreadId;
    if (!threadId || this.fileStates.has(threadId)) return;
    let path = this.rolloutPathsByThread.get(threadId);
    if (!path) {
      await this.#refreshRolloutCatalog();
      path = this.rolloutPathsByThread.get(threadId);
    }
    if (!path) return;
    this.fileStates.set(threadId, {
      threadId,
      path,
      offset: 0,
      pending: "",
      currentTurnId: null,
      modelReconciled: false,
    });
    this.cacheDirty = true;
  }

  async #readAppendedRollout(state) {
    const reconcile = !state.modelReconciled;
    let result;
    try {
      result = await this.#readRolloutInWorker(state, reconcile);
    } catch (error) {
      console.error(`[token-usage] Worker 解析 rollout 失败，回退到主线程：${error.message}`);
      await this.#readAppendedRolloutOnMain(state, reconcile);
      return;
    }
    if (result.missing) {
      this.fileStates.delete(state.threadId);
      this.cacheDirty = true;
      this.#invalidateViewModel();
      return;
    }
    if (result.reset) {
      this.#clearRolloutTurns(state.threadId);
      this.cacheDirty = true;
    }
    state.offset = positiveInteger(result.offset);
    state.pending = String(result.pending ?? "");
    state.currentTurnId = nonEmptyString(result.currentTurnId);
    for (const record of result.records ?? []) this.#processRolloutRecord(record, state);
    if (reconcile) state.modelReconciled = true;
    this.cacheDirty = true;
    this.#invalidateViewModel();
  }

  async #readAppendedRolloutOnMain(state, reconcile) {
    let info;
    try {
      info = await stat(state.path);
    } catch (error) {
      if (error.code === "ENOENT") {
        this.fileStates.delete(state.threadId);
        this.cacheDirty = true;
        return;
      }
      throw error;
    }
    if (reconcile) {
      state.offset = 0;
      state.pending = "";
      state.currentTurnId = null;
    }
    if (info.size < state.offset) {
      this.#clearRolloutTurns(state.threadId);
      state.offset = 0;
      state.pending = "";
      state.currentTurnId = null;
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
    if (reconcile) state.modelReconciled = true;
    this.cacheDirty = true;
    this.#invalidateViewModel();
  }

  #processRolloutRecord(record, state) {
    if (record.type === "turn_context" && record.payload?.turn_id) {
      state.currentTurnId = String(record.payload.turn_id);
      const existing = this.turns.get(state.currentTurnId);
      const turn = existing ?? emptyTurn(state.currentTurnId, state.threadId, "rollout", state.path);
      const model = nonEmptyString(record.payload.model);
      setTurnModel(turn, model, "turn-context");
      if (model) {
        for (const segment of turn.segments) {
          segment.model = model;
          segment.modelSource = "turn-context";
        }
      }
      if (turn.source === "rollout") turn.updatedAt = parseTimestamp(record.timestamp);
      this.turns.set(turn.turnId, turn);
      this.cacheDirty = true;
    }
    if (record.type === "response_item") {
      const turnId = record.payload?.internal_chat_message_metadata_passthrough?.turn_id;
      if (turnId) state.currentTurnId = String(turnId);
    }
    if (record.type !== "event_msg") return;

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
        this.cacheDirty = true;
        return;
      }
      turn.completed = true;
      turn.status = record.payload.reason === "interrupted" ? "interrupted" : "failed";
      turn.updatedAt = parseTimestamp(record.timestamp);
      this.cacheDirty = true;
      return;
    }

    if (!state.currentTurnId) return;

    if (record.payload?.type === "token_count") {
      const last = normalizeRolloutUsage(record.payload.info?.last_token_usage);
      if (!last) return;
      const existing = this.turns.get(state.currentTurnId);
      if (existing?.source === "event") {
        existing.cumulativeTotalTokens = positiveNumber(
          record.payload.info?.total_token_usage?.total_tokens,
        );
        existing.modelContextWindow = positiveNumber(record.payload.info?.model_context_window);
        this.cacheDirty = true;
        return;
      }
      const turn = existing ?? emptyTurn(
        state.currentTurnId,
        state.threadId,
        "rollout",
        state.path,
      );
      addUsage(turn, last, turn.model, turn.modelSource);
      turn.cumulativeTotalTokens = positiveNumber(
        record.payload.info?.total_token_usage?.total_tokens,
      );
      turn.modelContextWindow = positiveNumber(record.payload.info?.model_context_window);
      turn.updatedAt = parseTimestamp(record.timestamp);
      this.turns.set(turn.turnId, turn);
      this.cacheDirty = true;
      return;
    }

    if (record.payload?.type === "task_complete") {
      const turn = this.turns.get(state.currentTurnId);
      if (!turn) return;
      turn.completed = true;
      turn.status = "completed";
      turn.updatedAt = parseTimestamp(record.timestamp);
      this.cacheDirty = true;
    }
  }

  #readRolloutInWorker(state, reconcile) {
    const worker = this.#ensureRolloutWorker();
    const id = ++this.rolloutWorkerRequestId;
    return new Promise((resolve, reject) => {
      this.rolloutWorkerRequests.set(id, { resolve, reject });
      try {
        worker.postMessage({
          id,
          path: state.path,
          offset: state.offset,
          pending: state.pending,
          currentTurnId: state.currentTurnId,
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

  #clearRolloutTurns(threadId) {
    for (const [turnId, turn] of this.turns) {
      if (turn.threadId === threadId && turn.source === "rollout") this.turns.delete(turnId);
    }
    this.#invalidateViewModel();
  }
}

function emptyTurn(turnId, threadId, source, rolloutPath = "") {
  return {
    turnId,
    threadId,
    taskKey: threadId,
    source,
    rolloutPath,
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
    segments: [],
    updatedAt: 0,
  };
}

function addUsage(turn, usage, model, modelSource = turn.modelSource) {
  for (const field of TOKEN_FIELDS) turn[toCamelCase(field)] += positiveNumber(usage[field]);
  turn.segments.push({ model: model || "", modelSource: modelSource || "", usage });
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
  return true;
}

function calculateTurnCost(turn, pricingManager) {
  let cost = null;
  const tiers = new Map();
  for (const segment of turn.segments) {
    const segmentCost = pricingManager.calculate(segment.model || turn.model, segment.usage);
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
  turn.cumulativeTotalTokens = positiveNumber(value.cumulativeTotalTokens);
  turn.modelContextWindow = positiveNumber(value.modelContextWindow);
  turn.updatedAt = positiveNumber(value.updatedAt);
  turn.segments = Array.isArray(value.segments)
    ? value.segments.map((segment) => ({
        model: String(segment?.model ?? ""),
        modelSource: String(segment?.modelSource ?? (segment?.model ? "thread" : "")),
        usage: normalizeRolloutUsage(segment?.usage) ?? normalizeRolloutUsage({}),
      }))
    : [];
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
    modelReconciled: Boolean(value.modelReconciled),
  };
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
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}
