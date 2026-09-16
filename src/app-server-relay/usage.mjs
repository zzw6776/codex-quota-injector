import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { readModelSetting, updateThreadContext, resolveTurnModel, rememberTurnModel, nextModelRevision } from "./thread-context.mjs";
import { normalizedModel } from "./configuration.mjs";

function captureUsageNotification(message, state) {
  const method = message?.method;
  const params = message?.params;
  if (!params || typeof params !== "object") return;
  const configuredModel = readModelSetting(params.threadSettings ?? params);
  if (method === "thread/settings/updated" && params.threadId && configuredModel.present) {
    updateThreadContext(state.threadContexts, params.threadId, {
      model: configuredModel.model,
      modelPresent: true,
      source: "thread-settings",
      revision: nextModelRevision(state),
    });
    return;
  }
  if (method === "turn/started" && params.threadId && params.turn?.id) {
    const turnId = String(params.turn.id);
    const resolved = resolveTurnModel(state, params.threadId, turnId, params);
    const model = resolved.model;
    const source = resolved.explicit ? "turn-started" : resolved.source;
    if (model) rememberTurnModel(state, turnId, { model, source });
    state.emitUsageEvent({
      type: "turn-started",
      threadId: params.threadId,
      turnId,
      model,
      modelSource: source,
    });
    return;
  }
  if (method === "model/rerouted" && params.threadId) {
    const model = normalizedModel(params.toModel);
    const turnId = params.turnId ?? params.turn?.id;
    if (model && turnId) {
      rememberTurnModel(state, turnId, { model, source: "rerouted" });
    }
    return;
  }
  if (method === "thread/tokenUsage/updated" && params.threadId && params.turnId) {
    const resolved = resolveTurnModel(state, params.threadId, params.turnId, params);
    state.emitUsageEvent({
      type: "usage",
      threadId: params.threadId,
      turnId: params.turnId,
      model: resolved.model,
      modelSource: resolved.explicit ? "usage" : resolved.source,
      tokenUsage: params.tokenUsage,
    });
    return;
  }
  if (method === "turn/completed" && params.threadId && params.turn?.id) {
    const turnId = String(params.turn.id);
    const resolved = resolveTurnModel(state, params.threadId, turnId, params);
    state.emitUsageEvent({
      type: "turn-completed",
      threadId: params.threadId,
      turnId,
      model: resolved.model,
      modelSource: resolved.explicit ? "completed" : resolved.source,
      status: params.turn.status ?? null,
    });
    state.turnModels.delete(turnId);
    return;
  }
  if (method === "turn/aborted" && params.threadId) {
    const turnId = params.turnId ?? params.turn?.id;
    if (!turnId) return;
    const resolved = resolveTurnModel(state, params.threadId, turnId, params);
    state.emitUsageEvent({
      type: "turn-completed",
      threadId: params.threadId,
      turnId: String(turnId),
      model: resolved.model,
      modelSource: resolved.explicit ? "completed" : resolved.source,
      status: params.reason === "interrupted" ? "interrupted" : "failed",
    });
    state.turnModels.delete(String(turnId));
  }
}

function createUsageEventWriter(path) {
  const sessionId = randomUUID();
  let sequence = 0;
  let buffer = [];
  let flushTimer = null;
  let closed = false;
  let tail = Promise.resolve();
  const directoryReady = path
    ? mkdir(dirname(path), { recursive: true, mode: 0o700 })
    : Promise.resolve();
  const flush = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!path || buffer.length === 0) return tail;
    const batch = buffer;
    buffer = [];
    const content = `${batch.map((payload) => JSON.stringify(payload)).join("\n")}\n`;
    tail = tail
      .then(async () => {
        await directoryReady;
        await appendFile(path, content, { encoding: "utf8", mode: 0o600 });
      })
      .catch((error) => {
        console.error(`记录 Token 用量事件失败: ${error.message}`);
      });
    return tail;
  };
  const write = (event) => {
    if (closed || !path || !event?.type) return;
    const payload = {
      ...event,
      eventId: `${sessionId}:${++sequence}`,
      recordedAt: Date.now(),
    };
    buffer.push(payload);
    if (buffer.length >= 32) {
      void flush();
    } else if (!flushTimer) {
      flushTimer = setTimeout(() => void flush(), 25);
    }
  };
  return {
    write,
    close: async () => {
      closed = true;
      await flush();
      await tail;
    },
  };
}

export { createUsageEventWriter, captureUsageNotification };
