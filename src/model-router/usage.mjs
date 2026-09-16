import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { number } from "./contract.mjs";

function normalizeUsage(value) {
  if (!value || typeof value !== "object") return null;
  const inputTokens = number(value.input_tokens ?? value.inputTokens);
  const cachedInputTokens = number(
    value.input_tokens_details?.cached_tokens ?? value.cachedInputTokens,
  );
  const cacheWriteInputTokens = number(
    value.input_tokens_details?.cache_write_tokens ?? value.cacheWriteInputTokens,
  );
  const outputTokens = number(value.output_tokens ?? value.outputTokens);
  const reasoningOutputTokens = number(
    value.output_tokens_details?.reasoning_tokens ?? value.reasoningOutputTokens,
  );
  const totalTokens = number(value.total_tokens ?? value.totalTokens) || inputTokens + outputTokens;
  if (totalTokens <= 0) return null;
  return {
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
  };
}

function emptyUsage() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
}

function addUsage(total, usage) {
  for (const key of Object.keys(total)) total[key] += number(usage[key]);
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
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    if (!path || buffer.length === 0) return tail;
    const batch = buffer;
    buffer = [];
    const content = `${batch.map((payload) => JSON.stringify(payload)).join("\n")}\n`;
    tail = tail.then(async () => {
      await directoryReady;
      await appendFile(path, content, { encoding: "utf8", mode: 0o600 });
    }).catch((error) => {
      console.error(`[model-router] 记录 Token 用量事件失败: ${error.message}`);
    });
    return tail;
  };
  return {
    write(event) {
      if (closed || !path || !event?.type || !event.threadId) return;
      buffer.push({
        ...event,
        eventId: `${sessionId}:${++sequence}`,
        recordedAt: Date.now(),
      });
      if (buffer.length >= 32) void flush();
      else if (!flushTimer) flushTimer = setTimeout(() => void flush(), 25);
    },
    async close() {
      closed = true;
      await flush();
      await tail;
    },
  };
}

export { emptyUsage, addUsage, createUsageEventWriter, normalizeUsage };
