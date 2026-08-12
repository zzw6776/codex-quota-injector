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
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { defaultAccountDataDir } from "./platform.mjs";
import { accumulateTokenCost, TokenPricingManager } from "./token-pricing.mjs";

const CACHE_VERSION = 2;
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
    this.cacheDirty = false;
    this.error = null;
  }

  async initialize() {
    await this.pricingManager.initialize();
    await this.#loadCache();
    await this.refresh({ forceDiscovery: true });
    return this.getViewModel();
  }

  async refresh({ forceDiscovery = false } = {}) {
    if (this.refreshPromise) return this.refreshPromise;
    const task = this.#refreshOnce({ forceDiscovery })
      .catch((error) => {
        this.error = error.message;
        console.error(`[token-usage] ${error.message}`);
        return this.getViewModel();
      })
      .finally(() => {
        if (this.refreshPromise === task) this.refreshPromise = null;
      });
    this.refreshPromise = task;
    return task;
  }

  getViewModel() {
    const cumulativeCosts = new Map();
    const mappedTurns = [...this.turns.values()]
      .filter((turn) => turn.completed && turn.totalTokens > 0)
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
    return {
      status: this.error ? "error" : "ready",
      error: this.error,
      turns: [...recentTurns, ...activeTurns]
        .sort((left, right) => left.updatedAt - right.updatedAt),
    };
  }

  close() {
    this.fileStates.clear();
    this.turns.clear();
    this.seenEventIds.clear();
  }

  async #refreshOnce({ forceDiscovery }) {
    await this.pricingManager.refreshExchangeRate();
    await this.#readUsageEvents();
    const now = Date.now();
    if (forceDiscovery || now - this.lastDiscoveryAt >= this.discoveryIntervalMs) {
      await this.#refreshRolloutCatalog();
      this.lastDiscoveryAt = now;
    }
    await this.#ensureActiveRollout();
    for (const state of this.fileStates.values()) {
      await this.#readAppendedRollout(state);
    }
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
          turn.modelContextWindow = previous.modelContextWindow;
          turn.updatedAt = previous.updatedAt;
        }
      }
      if (model) turn.model = model;
      addUsage(turn, last, turn.model);
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
      if (model && !turn.model) turn.model = model;
      turn.status = nonEmptyString(event.status);
      turn.completed = TERMINAL_TURN_STATUSES.has(turn.status);
      turn.updatedAt = updatedAt;
    }
  }

  #fillThreadModel(threadId, model) {
    for (const turn of this.turns.values()) {
      if (turn.threadId !== threadId || turn.model) continue;
      turn.model = model;
      for (const segment of turn.segments) {
        if (!segment.model) segment.model = model;
      }
    }
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
    });
    this.cacheDirty = true;
  }

  async #readAppendedRollout(state) {
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
    if (info.size < state.offset) {
      this.#clearRolloutTurns(state.threadId);
      state.offset = 0;
      state.pending = "";
      state.currentTurnId = null;
      this.cacheDirty = true;
    }
    await readAppendedChunks(state.path, state, (line) => this.#processRolloutLine(line, state));
  }

  #processRolloutLine(line, state) {
    if (!line) return;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }

    if (record.type === "turn_context" && record.payload?.turn_id) {
      state.currentTurnId = String(record.payload.turn_id);
      const existing = this.turns.get(state.currentTurnId);
      const turn = existing ?? emptyTurn(state.currentTurnId, state.threadId, "rollout", state.path);
      const model = nonEmptyString(record.payload.model);
      if (model && !turn.model) turn.model = model;
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
      if (!turn || turn.source === "event") return;
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
      if (existing?.source === "event") return;
      const turn = existing ?? emptyTurn(
        state.currentTurnId,
        state.threadId,
        "rollout",
        state.path,
      );
      addUsage(turn, last, turn.model);
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
      if (!turn || turn.source === "event") return;
      turn.completed = true;
      turn.status = "completed";
      turn.updatedAt = parseTimestamp(record.timestamp);
      this.cacheDirty = true;
    }
  }

  #clearRolloutTurns(threadId) {
    for (const [turnId, turn] of this.turns) {
      if (turn.threadId === threadId && turn.source === "rollout") this.turns.delete(turnId);
    }
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
    segments: [],
    updatedAt: 0,
  };
}

function addUsage(turn, usage, model) {
  for (const field of TOKEN_FIELDS) turn[toCamelCase(field)] += positiveNumber(usage[field]);
  turn.segments.push({ model: model || "", usage });
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
  turn.cumulativeTotalTokens = positiveNumber(value.cumulativeTotalTokens);
  turn.modelContextWindow = positiveNumber(value.modelContextWindow);
  turn.updatedAt = positiveNumber(value.updatedAt);
  turn.segments = Array.isArray(value.segments)
    ? value.segments.map((segment) => ({
        model: String(segment?.model ?? ""),
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
