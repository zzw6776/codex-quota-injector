import { simplifyToolExecutionRecord } from "../tool-executions.mjs";
import { Worker } from "node:worker_threads";

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

class RolloutWorkerClient {
  constructor() {
    this.rolloutWorker = null;
    this.rolloutWorkerRequestId = 0;
    this.rolloutWorkerRequests = new Map();
  }

  readRolloutInWorker(state, reconcile, onBatch, onReset) {
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

  closeRolloutWorker() {
    const worker = this.rolloutWorker;
    this.rolloutWorker = null;
    if (!worker) return;
    const error = new Error("TokenUsageManager 已关闭");
    for (const pending of this.rolloutWorkerRequests.values()) pending.reject(error);
    this.rolloutWorkerRequests.clear();
    void worker.terminate();
  }
}

export { RolloutWorkerClient };
