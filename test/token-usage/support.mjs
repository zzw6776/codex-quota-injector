import { TokenPricingManager } from "../../src/token-pricing.mjs";
import { GENERATION_METRICS_VERSION } from "../../src/relay-contract.mjs";
import { writeFile, appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TokenUsageManager } from "../../src/token-usage.mjs";

function pricing(dataDir) {
  const manager = new TokenPricingManager({ dataDir, fetchImpl: null });
  manager.refreshExchangeRate = async () => manager.exchangeRate;
  return manager;
}

function event(eventId, type, threadId, turnId, extra = {}) {
  return {
    eventId,
    type,
    threadId,
    ...(turnId ? { turnId } : {}),
    recordedAt: Date.now(),
    ...(["generation", "generation-tool-timing"].includes(type)
      ? { generationMetricsVersion: GENERATION_METRICS_VERSION }
      : {}),
    ...extra,
  };
}

function protocolUsage({ input, cached = 0, cacheWrite = 0, output, reasoning = 0 }) {
  return {
    inputTokens: input,
    cachedInputTokens: cached,
    cacheWriteInputTokens: cacheWrite,
    outputTokens: output,
    reasoningOutputTokens: reasoning,
    totalTokens: input + output,
  };
}

function rolloutUsage({ input, cached = 0, cacheWrite = 0, output, reasoning = 0 }) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: cacheWrite,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  };
}

async function writeEvents(dataDir, events) {
  await writeFile(
    join(dataDir, "token-usage-events.jsonl"),
    `${events.map((value) => JSON.stringify(value)).join("\n")}\n`,
  );
}

async function appendEvents(dataDir, events) {
  await appendFile(
    join(dataDir, "token-usage-events.jsonl"),
    `${events.map((value) => JSON.stringify(value)).join("\n")}\n`,
  );
}

async function writeRollout(codexHome, threadId, records, { metadata = {} } = {}) {
  const directory = join(codexHome, "sessions", "2026", "09", "11");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `rollout-2026-09-11T00-00-00-${threadId}.jsonl`);
  const session = {
    timestamp: new Date().toISOString(),
    type: "session_meta",
    payload: { id: threadId, ...metadata },
  };
  await writeFile(path, `${[session, ...records].map((value) => JSON.stringify(value)).join("\n")}\n`);
  return path;
}

function turnContext(turnId, model, timestamp = new Date().toISOString()) {
  return { timestamp, type: "turn_context", payload: { turn_id: turnId, model } };
}

function tokenCount(last, cumulativeTotal, timestamp = new Date().toISOString()) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: last,
        total_token_usage: { total_tokens: cumulativeTotal },
        model_context_window: 400_000,
      },
    },
  };
}

function tokenUsageRecord(
  turnId,
  responseId,
  usage,
  cumulativeTotal,
  timestamp = new Date().toISOString(),
) {
  return {
    timestamp,
    type: "token_usage_record",
    payload: {
      turn_id: turnId,
      response_id: responseId,
      usage,
      turn_token_usage: { total_tokens: cumulativeTotal },
      thread_token_usage: { total_tokens: cumulativeTotal },
    },
  };
}

function compactedCheckpoint(latestTokenUsageRecord, timestamp = new Date().toISOString()) {
  return {
    timestamp,
    type: "compacted",
    payload: { latest_token_usage_record: latestTokenUsageRecord },
  };
}

function taskComplete(timestamp = new Date().toISOString()) {
  return { timestamp, type: "event_msg", payload: { type: "task_complete" } };
}

async function createManager(t, { events = [], rollouts = [] } = {}) {
  const codexHome = await mkdtemp(join(tmpdir(), "codex-usage-home-"));
  const dataDir = await mkdtemp(join(tmpdir(), "codex-quota-test-"));
  if (events.length) await writeEvents(dataDir, events);
  for (const rollout of rollouts) {
    await writeRollout(codexHome, rollout.threadId, rollout.records, rollout.options);
  }
  const manager = new TokenUsageManager({
    codexHome,
    dataDir,
    discoveryIntervalMs: 0,
    pricingManager: pricing(dataDir),
  });
  t.after(async () => {
    await manager.flush();
    manager.close();
  });
  t.after(async () => {
    await Promise.all([
      rm(codexHome, { recursive: true, force: true }),
      rm(dataDir, { recursive: true, force: true }),
    ]);
  });
  await manager.initialize();
  return { manager, codexHome, dataDir };
}

export { event, protocolUsage, createManager, pricing, rolloutUsage, turnContext, tokenUsageRecord, tokenCount, taskComplete, compactedCheckpoint, appendEvents };
