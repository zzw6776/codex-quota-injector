import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, open, rename, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import readline from "node:readline";
import { once } from "node:events";
import { finished } from "node:stream/promises";

const TERMINAL_EVENTS = new Set(["task_complete", "turn_aborted"]);

export function analyzeRolloutRecords(records) {
  const state = createAnalysisState();
  for (const record of records) analyzeRecord(state, record);
  return finishAnalysis(state);
}

export function repairRolloutRecords(records) {
  const output = [];
  const state = createRepairState();
  for (const record of records) repairRecord(state, structuredClone(record), (value) => output.push(value));
  return { records: output, manifest: finishRepair(state) };
}

export async function inspectRolloutHistory(path, { snapshotSize = null } = {}) {
  const info = await stat(path);
  const size = snapshotSize ?? info.size;
  const state = createAnalysisState();
  const hash = createHash("sha256");
  await visitJsonLines(path, size, (record, raw) => {
    hash.update(raw);
    hash.update("\n");
    analyzeRecord(state, record);
  });
  return {
    path,
    size,
    mtimeMs: info.mtimeMs,
    sha256: hash.digest("hex"),
    ...finishAnalysis(state),
  };
}

export async function prepareRolloutHistoryRepair({
  path,
  runDirectory,
  expectedSha256 = null,
  expectedSize = null,
} = {}) {
  const before = await inspectRolloutHistory(path);
  if (expectedSha256 && before.sha256 !== expectedSha256 ||
    expectedSize != null && before.size !== expectedSize) {
    throw new Error("Codex rollout 在历史修复前发生变化，拒绝覆盖");
  }
  if (before.activeTurn) throw new Error("Codex rollout 仍有活动回合，拒绝修复历史");
  if (!before.repairRequired) return { repaired: false, before };
  if (!before.repairable) throw new Error("Codex rollout 存在无法安全自动修复的结构损坏");

  const repairId = randomUUID();
  const backupPath = join(runDirectory, `${basename(path)}.${repairId}.original`);
  const stagingPath = join(dirname(path), `.${basename(path)}.${repairId}.repairing`);
  await copyFile(path, backupPath);

  const input = createReadStream(path, { start: 0, end: before.size - 1, encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const output = createWriteStream(stagingPath, { encoding: "utf8", flags: "wx" });
  const state = createRepairState();
  try {
    for await (const line of lines) {
      if (!line) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch (error) {
        throw new Error(`Codex rollout 包含无效 JSON，拒绝自动修复：${error.message}`);
      }
      const emitted = [];
      repairRecord(state, record, (value) => emitted.push(value));
      for (const value of emitted) {
        if (!output.write(`${JSON.stringify(value)}\n`)) await once(output, "drain");
      }
    }
    output.end();
    await finished(output);
  } catch (error) {
    output.destroy();
    throw error;
  }
  const manifest = finishRepair(state);
  const after = await inspectRolloutHistory(stagingPath);
  if (after.repairRequired || after.activeTurn ||
    after.conversationDigest !== before.conversationDigest ||
    after.conversationRecordCount !== before.conversationRecordCount) {
    throw new Error("Codex rollout 自动修复后的完整性校验失败");
  }
  const unchanged = await inspectRolloutHistory(path);
  if (unchanged.sha256 !== before.sha256 || unchanged.size !== before.size) {
    throw new Error("Codex rollout 在生成修复副本期间发生变化，拒绝替换");
  }
  return { repaired: true, before, after, manifest, backupPath, stagingPath };
}

export async function commitRolloutHistoryRepair(prepared) {
  if (!prepared?.repaired) return prepared;
  const displacedPath = `${prepared.before.path}.${randomUUID()}.pre-repair`;
  await rename(prepared.before.path, displacedPath);
  try {
    await rename(prepared.stagingPath, prepared.before.path);
  } catch (error) {
    await rename(displacedPath, prepared.before.path).catch(() => undefined);
    throw error;
  }
  return { ...prepared, displacedPath, committed: true };
}

function createAnalysisState() {
  return {
    recordCount: 0,
    previousOrdinal: null,
    sequenceIssues: [],
    missingTerminalEvents: [],
    invalidOrdinalRecords: [],
    activeTurn: null,
    conversationHash: createHash("sha256"),
    conversationRecordCount: 0,
  };
}

function analyzeRecord(state, record) {
  const index = state.recordCount;
  state.recordCount += 1;
  if (!Number.isInteger(record?.ordinal)) {
    state.invalidOrdinalRecords.push({ index, ordinal: record?.ordinal ?? null });
  } else {
    const expected = state.previousOrdinal == null ? declaredInitialOrdinal(record) : state.previousOrdinal + 1;
    if (record.ordinal !== expected) {
      state.sequenceIssues.push({
        index,
        expected,
        actual: record.ordinal,
        kind: record.ordinal === state.previousOrdinal ? "duplicate" : "unknown",
        timestamp: record.timestamp ?? null,
      });
    }
    state.previousOrdinal = record.ordinal;
  }
  updateConversationDigest(state, record);
  updateTurnState(state, record, (active, next) => {
    state.missingTerminalEvents.push({
      abortedTurnId: active.turnId,
      beforeTurnId: next.turnId,
      timestamp: record.timestamp ?? null,
      startedAt: active.startedAt,
      completedAt: next.startedAt,
    });
  });
}

function finishAnalysis(state) {
  const repairRequired = state.sequenceIssues.length > 0 ||
    state.missingTerminalEvents.length > 0 || state.invalidOrdinalRecords.length > 0;
  return {
    recordCount: state.recordCount,
    lastOrdinal: state.previousOrdinal,
    sequenceIssues: state.sequenceIssues,
    missingTerminalEvents: state.missingTerminalEvents,
    invalidOrdinalRecords: state.invalidOrdinalRecords,
    activeTurn: state.activeTurn,
    conversationRecordCount: state.conversationRecordCount,
    conversationDigest: state.conversationHash.digest("hex"),
    repairRequired,
    repairable: repairRequired && state.invalidOrdinalRecords.length === 0 &&
      state.sequenceIssues.every((issue) => issue.kind === "duplicate"),
  };
}

function createRepairState() {
  return {
    initialOrdinal: 0,
    nextOrdinal: 0,
    activeTurn: null,
    sourceRecords: 0,
    rewrittenOrdinals: 0,
    insertedTerminalEvents: [],
  };
}

function repairRecord(state, record, emit) {
  if (state.sourceRecords === 0) {
    state.initialOrdinal = declaredInitialOrdinal(record);
    state.nextOrdinal = state.initialOrdinal;
  }
  state.sourceRecords += 1;
  const payload = eventPayload(record);
  if (payload?.type === "task_started" && state.activeTurn) {
    const completedAt = numericSeconds(payload.started_at, record.timestamp);
    const startedAt = numericSeconds(state.activeTurn.startedAt, record.timestamp);
    const synthetic = {
      timestamp: record.timestamp ?? new Date(completedAt * 1_000).toISOString(),
      ordinal: state.nextOrdinal,
      type: "event_msg",
      payload: {
        type: "turn_aborted",
        turn_id: state.activeTurn.turnId,
        reason: "interrupted",
        started_at: startedAt,
        completed_at: completedAt,
        duration_ms: Math.max(0, (completedAt - startedAt) * 1_000),
      },
    };
    emitAssigned(state, synthetic, emit);
    state.insertedTerminalEvents.push({
      abortedTurnId: state.activeTurn.turnId,
      beforeTurnId: String(payload.turn_id),
      ordinal: synthetic.ordinal,
      timestamp: synthetic.timestamp,
    });
    state.activeTurn = null;
  }
  emitAssigned(state, record, emit);
  updateTurnState(state, record);
}

function emitAssigned(state, record, emit) {
  if (record.ordinal !== state.nextOrdinal) state.rewrittenOrdinals += 1;
  record.ordinal = state.nextOrdinal;
  state.nextOrdinal += 1;
  emit(record);
}

function finishRepair(state) {
  return {
    sourceRecords: state.sourceRecords,
    outputRecords: state.nextOrdinal - state.initialOrdinal,
    lastOrdinal: state.nextOrdinal - 1,
    rewrittenOrdinals: state.rewrittenOrdinals,
    insertedTerminalEvents: state.insertedTerminalEvents,
    activeTurn: state.activeTurn,
  };
}

function updateTurnState(state, record, onMissingTerminal = null) {
  const payload = eventPayload(record);
  if (payload?.type === "task_started" && payload.turn_id) {
    const next = { turnId: String(payload.turn_id), startedAt: payload.started_at ?? null };
    if (state.activeTurn) onMissingTerminal?.(state.activeTurn, next);
    state.activeTurn = next;
  } else if (TERMINAL_EVENTS.has(payload?.type)) {
    state.activeTurn = null;
  }
}

function declaredInitialOrdinal(record) {
  const meta = record?.type === "session_meta" ? record.payload : null;
  const base = meta?.history_base;
  // Paginated forks keep their parent's ordinal space. Do not treat an
  // arbitrary nonzero first record as a valid base without matching metadata.
  return typeof base?.thread_id === "string" && base.thread_id.length > 0 &&
    base.thread_id === meta.forked_from_id &&
    Number.isSafeInteger(base.end_ordinal_exclusive) && base.end_ordinal_exclusive >= 0 &&
    base.end_ordinal_exclusive === meta.forked_from_ordinal_exclusive
    ? base.end_ordinal_exclusive : 0;
}

function eventPayload(record) {
  return record?.type === "event_msg" ? record.payload : null;
}

function updateConversationDigest(state, record) {
  const payload = record?.payload;
  const itemType = record?.type === "event_msg" && payload?.type === "item_completed"
    ? payload.item?.type
    : null;
  if (itemType !== "UserMessage" && itemType !== "AgentMessage") return;
  state.conversationHash.update(JSON.stringify(payload.item));
  state.conversationHash.update("\n");
  state.conversationRecordCount += 1;
}

function numericSeconds(value, timestamp) {
  const number = Number(value);
  if (Number.isFinite(number)) return Math.trunc(number);
  const parsed = Date.parse(timestamp ?? "");
  return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) : 0;
}

async function visitJsonLines(path, size, visitor) {
  if (size === 0) return;
  const input = createReadStream(path, { start: 0, end: size - 1, encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw new Error(`Codex rollout 第 ${lineNumber} 行不是有效 JSON：${error.message}`);
    }
    visitor(record, line);
  }
}
