import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GENERATION_METRICS_VERSION } from "../src/relay-contract.mjs";
import { TokenPricingManager } from "../src/token-pricing.mjs";
import { TokenUsageManager } from "../src/token-usage.mjs";

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

test("自定义模型 usage 按累计水位去重并计算首字延迟与输出速度", async (t) => {
  const usage1 = protocolUsage({ input: 10, output: 10, reasoning: 3 });
  const usage2 = protocolUsage({ input: 5, output: 5, reasoning: 1 });
  const events = [
    event("1", "turn-started", "thread-custom", "turn-custom", {
      model: "deepseek-v4-flash",
      modelSource: "turn-request",
      generationMetricsVersion: GENERATION_METRICS_VERSION,
    }),
    event("2", "usage", "thread-custom", "turn-custom", {
      model: "deepseek-v4-flash",
      responseId: "resp-custom-1",
      tokenUsage: { last: usage1, total: usage1 },
    }),
    event("2", "usage", "thread-custom", "turn-custom", {
      model: "deepseek-v4-flash",
      responseId: "resp-custom-1",
      tokenUsage: { last: usage1, total: usage1 },
    }),
    event("3", "usage", "thread-custom", "turn-custom", {
      model: "deepseek-v4-flash",
      responseId: "resp-custom-1",
      tokenUsage: { last: usage1, total: usage1 },
    }),
    event("4", "generation", "thread-custom", "turn-custom", {
      model: "deepseek-v4-flash",
      generation: {
        responseId: "resp-custom-1",
        hasVisibleText: true,
        hasNonTextOutput: false,
        firstTokenLatencyMs: 400,
        generationDurationMs: 2_000,
      },
    }),
    event("5", "usage", "thread-custom", "turn-custom", {
      model: "deepseek-v4-flash",
      responseId: "resp-custom-2",
      tokenUsage: {
        last: usage2,
        total: protocolUsage({ input: 15, output: 15, reasoning: 4 }),
      },
    }),
    event("6", "generation", "thread-custom", "turn-custom", {
      model: "deepseek-v4-flash",
      generation: {
        responseId: "resp-custom-2",
        hasVisibleText: true,
        hasNonTextOutput: false,
        firstTokenLatencyMs: 600,
        generationDurationMs: 1_000,
      },
    }),
  ];
  const { manager } = await createManager(t, { events });
  const turn = manager.getViewModel().turns.find((value) => value.turnId === "turn-custom");
  assert.equal(turn.totalTokens, 30);
  assert.equal(turn.outputTokens, 15);
  assert.equal(turn.reasoningOutputTokens, 4);
  assert.equal(turn.firstTokenLatencyMs, 500);
  // Visible tokens: (10-3-1) + (5-1-1) = 9 over 3 seconds.
  assert.equal(turn.outputSpeed, 3);
  assert.deepEqual(turn.generationDetails, [
    {
      sequence: 1,
      hasVisibleText: true,
      followsToolResult: false,
      toolNames: [],
      responseLatencyMs: null,
      reasoningDurationMs: null,
      firstTokenLatencyMs: 400,
      outputSpeed: 3,
      outputGenerationTokens: 6,
      generationDurationMs: 2_000,
      textPhases: [],
      networkLatency: null,
      toolTiming: null,
      outputSpeedUnavailableReason: null,
    },
    {
      sequence: 2,
      hasVisibleText: true,
      followsToolResult: false,
      toolNames: [],
      responseLatencyMs: null,
      reasoningDurationMs: null,
      firstTokenLatencyMs: 600,
      outputSpeed: 3,
      outputGenerationTokens: 3,
      generationDurationMs: 1_000,
      textPhases: [],
      networkLatency: null,
      toolTiming: null,
      outputSpeedUnavailableReason: null,
    },
  ]);
  assert.equal(turn.cost.available, true);
  assert.equal(turn.cost.currency, "CNY");
});

test("请求明细包含纯工具请求，并区分混合工具调用和可计算速度", async (t) => {
  const usage = protocolUsage({ input: 2, output: 5 });
  const networkLatency = {
    status: "stable",
    latencyMs: 48,
    sampledAt: 1_786_000_000_000,
    connectionId: "official-ws-details",
  };
  const events = [
    event("1", "turn-started", "thread-details", "turn-details", {
      model: "gpt-5.6-luna",
      generationMetricsVersion: GENERATION_METRICS_VERSION,
      networkLatencySupported: true,
      networkConnectionId: networkLatency.connectionId,
    }),
    event("2", "usage", "thread-details", "turn-details", {
      responseId: "resp-details-tool",
      tokenUsage: { last: usage, total: usage },
    }),
    event("3", "generation", "thread-details", "turn-details", {
      generation: {
        responseId: "resp-details-tool",
        hasVisibleText: false,
        hasNonTextOutput: true,
        toolNames: ["exec_command"],
        generationDurationMs: 300,
      },
    }),
    event("4", "usage", "thread-details", "turn-details", {
      responseId: "resp-details-mixed",
      tokenUsage: { last: usage, total: protocolUsage({ input: 4, output: 10 }) },
    }),
    event("5", "generation", "thread-details", "turn-details", {
      generation: {
        requestId: "request-mixed",
        responseId: "resp-details-mixed",
        hasVisibleText: true,
        hasNonTextOutput: true,
        toolNames: ["read_thread"],
        firstTokenLatencyMs: 300,
        generationDurationMs: 500,
        textPhases: [{
          phase: "commentary",
          startLatencyMs: 300,
          durationMs: 500,
        }],
      },
    }),
    event("5a", "generation-tool-timing", "thread-details", "turn-details", {
      requestId: "request-mixed",
      toolTiming: {
        toolNames: ["read_thread", "exec_command"],
        toolCount: 3,
        readyLatencyMs: 1_800,
        preparationStartLatencyMs: 1_200,
        preparationDurationMs: 600,
        durationMs: 2_400,
        calls: [
          { toolName: "read_thread", preparationDurationMs: 300, durationMs: 800 },
          { toolName: "exec_command", preparationDurationMs: 600, durationMs: 2_400 },
          { toolName: "read_thread", preparationDurationMs: 450, durationMs: 1_200 },
        ],
      },
    }),
    event("6", "usage", "thread-details", "turn-details", {
      responseId: "resp-details-visible",
      tokenUsage: { last: usage, total: protocolUsage({ input: 6, output: 15 }) },
    }),
    event("7", "generation", "thread-details", "turn-details", {
      generation: {
        responseId: "resp-details-visible",
        hasVisibleText: true,
        hasNonTextOutput: false,
        followsToolResult: true,
        firstTokenLatencyMs: 700,
        generationDurationMs: 1_000,
        textPhases: [{
          phase: "final_answer",
          startLatencyMs: 700,
          durationMs: 1_000,
        }],
        networkLatency,
      },
    }),
  ];
  const { manager, dataDir, codexHome } = await createManager(t, { events });
  const turn = manager.getViewModel().turns.find((value) => value.turnId === "turn-details");
  assert.equal(turn.firstTokenLatencyMs, 500);
  assert.equal(turn.outputSpeed, 4);
  assert.equal(turn.networkLatencySupported, true);
  assert.equal(turn.networkConnectionId, networkLatency.connectionId);
  assert.deepEqual(turn.networkLatency, networkLatency);
  assert.equal(turn.generationDetails.length, 3);
  assert.deepEqual(turn.generationDetails.map((detail) => ({
    sequence: detail.sequence,
    visible: detail.hasVisibleText,
    followsToolResult: detail.followsToolResult,
    tools: detail.toolNames,
    firstTokenLatencyMs: detail.firstTokenLatencyMs,
    outputSpeed: detail.outputSpeed,
    textPhases: detail.textPhases,
    toolTiming: detail.toolTiming,
    reason: detail.outputSpeedUnavailableReason,
  })), [
    {
      sequence: 1, visible: false, followsToolResult: false, tools: ["exec_command"],
      firstTokenLatencyMs: null, outputSpeed: null, textPhases: [],
      toolTiming: null, reason: "no-visible-text",
    },
    {
      sequence: 2, visible: true, followsToolResult: false,
      tools: ["read_thread", "exec_command"],
      firstTokenLatencyMs: 300, outputSpeed: null,
      textPhases: [{ phase: "commentary", startLatencyMs: 300, durationMs: 500 }],
      toolTiming: {
        toolNames: ["read_thread", "exec_command"],
        toolCount: 3,
        readyLatencyMs: 1_800,
        preparationStartLatencyMs: 1_200,
        preparationDurationMs: 600,
        durationMs: 2_400,
        calls: [
          { toolName: "read_thread", preparationDurationMs: 300, durationMs: 800 },
          { toolName: "exec_command", preparationDurationMs: 600, durationMs: 2_400 },
          { toolName: "read_thread", preparationDurationMs: 450, durationMs: 1_200 },
        ],
      },
      reason: "unattributed-output",
    },
    {
      sequence: 3, visible: true, followsToolResult: true, tools: [],
      firstTokenLatencyMs: 700, outputSpeed: 4,
      textPhases: [{ phase: "final_answer", startLatencyMs: 700, durationMs: 1_000 }],
      toolTiming: null, reason: null,
    },
  ]);

  await manager.flush();
  manager.close();
  const restored = new TokenUsageManager({
    codexHome,
    dataDir,
    discoveryIntervalMs: 0,
    pricingManager: pricing(dataDir),
  });
  t.after(() => restored.close());
  await restored.initialize();
  const restoredTurn = restored.getViewModel().turns.find(
    (value) => value.turnId === "turn-details",
  );
  assert.deepEqual(
    restoredTurn.generationDetails.map((detail) => ({
      sequence: detail.sequence,
      textPhases: detail.textPhases,
      networkLatency: detail.networkLatency,
      toolTiming: detail.toolTiming,
    })),
    turn.generationDetails.map((detail) => ({
      sequence: detail.sequence,
      textPhases: detail.textPhases,
      networkLatency: detail.networkLatency,
      toolTiming: detail.toolTiming,
    })),
  );
  assert.deepEqual(restoredTurn.networkLatency, networkLatency);
  restored.close();
});

test("文字、工具和混合请求按生成耗时加权，段落只在可归属时显示速率，缓存恢复不重复计账", async (t) => {
  const threadId = "thread-all-output";
  const turnId = "turn-all-output";
  const events = [event("start-all", "turn-started", threadId, turnId, {
    model: "gpt-5.6-sol", generationMetricsVersion: GENERATION_METRICS_VERSION,
  })];
  let totalOutput = 0;
  function addResponse(id, output, reasoning, generation) {
    totalOutput += output;
    events.push(event(`usage-${id}`, "usage", threadId, turnId, {
      responseId: id,
      tokenUsage: { last: protocolUsage({ input: 0, output, reasoning }), total: protocolUsage({ input: 0, output: totalOutput }) },
    }));
    events.push(event(`generation-${id}`, "generation", threadId, turnId, {
      generation: { responseId: id, ...generation },
    }));
  }
  addResponse("mixed", 71, 10, {
    hasVisibleText: true, hasNonTextOutput: true, firstTokenLatencyMs: 300,
    generationDurationMs: 2_000, outputPhasesComplete: true,
    textPhases: [{ phase: "commentary", startLatencyMs: 300, durationMs: 2_000 }],
    outputPhases: [
      { kind: "text", textPhaseIndex: 0, startLatencyMs: 300, durationMs: 2_000 },
      { kind: "tool", startLatencyMs: 4_000, durationMs: 1_000 },
    ],
    toolTiming: { readyLatencyMs: 5_000, durationMs: 30_000 },
  });
  addResponse("tool", 31, 0, {
    hasVisibleText: false, hasNonTextOutput: true, outputPhasesComplete: true,
    outputPhases: [{ kind: "tool", startLatencyMs: 700, durationMs: 1_000 }],
  });
  addResponse("text", 41, 0, {
    hasVisibleText: true, hasNonTextOutput: false, firstTokenLatencyMs: 200,
    generationDurationMs: 4_000, outputPhasesComplete: true,
    textPhases: [{ phase: "final_answer", startLatencyMs: 200, durationMs: 4_000 }],
    outputPhases: [{ kind: "text", textPhaseIndex: 0, startLatencyMs: 200, durationMs: 4_000 }],
  });
  addResponse("unmeasured", 1_001, 0, {
    hasVisibleText: false, hasNonTextOutput: true, outputPhasesComplete: false,
    outputPhases: [{ kind: "tool", startLatencyMs: 500, durationMs: null }],
  });
  events.push({ ...events[3], eventId: "repeat-tool-usage" });
  const { manager, dataDir, codexHome } = await createManager(t, { events });
  const turn = manager.getViewModel().turns.find((value) => value.turnId === turnId);
  assert.equal(turn.outputSpeed, 130 / 8, "weighted aggregate, not (20 + 30 + 10) / 3");
  assert.deepEqual(turn.generationDetails.map((detail) => detail.outputSpeed), [20, 30, 10, null]);
  assert.ok(turn.generationDetails[0].outputPhases.every((phase) => phase.outputSpeed === undefined));
  assert.equal(turn.generationDetails[1].outputPhases[0].outputSpeed, 30);
  assert.equal(turn.generationDetails[2].outputPhases[0].outputSpeed, 10);
  await manager.flush();
  const cache = JSON.parse(await readFile(join(dataDir, "token-usage-cache.json"), "utf8"));
  const cached = cache.turns.find((value) => value.turnId === turnId);
  assert.equal(cached.outputGenerationTokens, 130, "parent and child speeds never contribute twice");
  assert.equal(cached.outputGenerationDurationMs, 8_000, "execution and gaps are excluded");
  manager.close();
  const restored = new TokenUsageManager({ codexHome, dataDir, discoveryIntervalMs: 0, pricingManager: pricing(dataDir) });
  t.after(() => restored.close());
  await restored.initialize();
  const restoredTurn = restored.getViewModel().turns.find((value) => value.turnId === turnId);
  assert.equal(restoredTurn.outputSpeed, turn.outputSpeed);
  assert.deepEqual(restoredTurn.generationDetails, turn.generationDetails);
});

test("升级到包含工具的速率协议后，已确认的 v4 文字速率和首字历史不会清空", async (t) => {
  const threadId = "thread-speed-upgrade";
  const turnId = "turn-speed-upgrade";
  const usage = protocolUsage({ input: 0, output: 11 });
  const events = [
    event("old-start", "turn-started", threadId, turnId, { generationMetricsVersion: 4 }),
    event("old-usage", "usage", threadId, turnId, { responseId: "old-text", tokenUsage: { last: usage, total: usage } }),
    event("old-generation", "generation", threadId, turnId, { generationMetricsVersion: 4,
      generation: { responseId: "old-text", hasVisibleText: true, firstTokenLatencyMs: 200, generationDurationMs: 1_000 } }),
    event("new-start", "turn-started", threadId, turnId, { generationMetricsVersion: GENERATION_METRICS_VERSION }),
    event("new-usage", "usage", threadId, turnId, { responseId: "new-tool", tokenUsage: { last: usage, total: protocolUsage({ input: 0, output: 22 }) } }),
    event("new-generation", "generation", threadId, turnId, { generation: {
      responseId: "new-tool", hasVisibleText: false, hasNonTextOutput: true, outputPhasesComplete: true,
      outputPhases: [{ kind: "tool", startLatencyMs: 300, durationMs: 2_000 }],
    } }),
  ];
  const { manager } = await createManager(t, { events });
  const turn = manager.getViewModel().turns.find((value) => value.turnId === turnId);
  assert.deepEqual(turn.generationDetails.map((detail) => detail.outputSpeed), [10, 5]);
  assert.equal(turn.outputSpeed, 20 / 3);
  assert.equal(turn.firstTokenLatencyMs, 200);
});

test("零输出占位和工具输出不会错配到下一次可见文字速率", async (t) => {
  const zero = protocolUsage({ input: 2, output: 0 });
  const visible = protocolUsage({ input: 3, output: 6, reasoning: 1 });
  const events = [
    event("1", "turn-started", "thread-rate", "turn-rate", {
      model: "gpt-5.6-luna",
      generationMetricsVersion: GENERATION_METRICS_VERSION,
    }),
    event("2", "usage", "thread-rate", "turn-rate", {
      model: "gpt-5.6-luna",
      responseId: "resp-rate-tool",
      tokenUsage: { last: zero, total: zero },
    }),
    event("3", "generation", "thread-rate", "turn-rate", {
      model: "gpt-5.6-luna",
      generation: {
        responseId: "resp-rate-tool",
        hasVisibleText: false,
        hasNonTextOutput: true,
        generationDurationMs: 500,
      },
    }),
    event("4", "usage", "thread-rate", "turn-rate", {
      model: "gpt-5.6-luna",
      responseId: "resp-rate-visible",
      tokenUsage: { last: visible, total: protocolUsage({ input: 5, output: 6, reasoning: 1 }) },
    }),
    event("5", "generation", "thread-rate", "turn-rate", {
      model: "gpt-5.6-luna",
      generation: {
        responseId: "resp-rate-visible",
        hasVisibleText: true,
        hasNonTextOutput: false,
        firstTokenLatencyMs: 250,
        generationDurationMs: 1_000,
      },
    }),
  ];
  const { manager } = await createManager(t, { events });
  const turn = manager.getViewModel().turns.find((value) => value.turnId === "turn-rate");
  assert.equal(turn.firstTokenLatencyMs, 250);
  assert.equal(turn.outputSpeed, 4);
});

test("rollout 内部工具按响应归属，增量续读、旧缓存重建及 Worker 回退保持计价不变", async (t) => {
  const threadId = "98989898-9898-4989-8989-989898989898";
  const turnId = "turn-execution-items";
  const usage = rolloutUsage({ input: 100, output: 20 });
  const epoch = Date.now() - 20_000;
  const at = (offset) => new Date(epoch + offset).toISOString();
  const responseItem = (type, offset, callId = "outer-a") => ({ timestamp: at(offset), type: "response_item", payload: {
    type, name: "exec", call_id: callId,
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  } });
  const item = (id, started, duration, ownerThread = threadId) => ({
    timestamp: at(started + duration), type: "event_msg", payload: {
      type: "item_completed", thread_id: ownerThread, turn_id: turnId,
      started_at_ms: epoch + started, completed_at_ms: epoch + started + duration,
      item: { type: "CommandExecution", id, command: ["secret-marker"],
        parsed_cmd: [{ type: "unknown", cmd: "npm test" }],
        duration: { secs: Math.floor(duration / 1_000), nanos: duration % 1_000 * 1_000_000 },
        stdout: "secret-marker", status: "completed" },
    },
  });
  const prefix = [
    turnContext(turnId, "gpt-5.6-sol", at(0)),
    responseItem("custom_tool_call", 100),
    tokenUsageRecord(turnId, "resp-tools-a", usage, 120, at(110)),
    item("inner-a", 150, 6_317),
    item("inner-b", 160, 5_000),
    { timestamp: at(400), type: "event_msg", payload: {
      type: "item_completed", thread_id: threadId, turn_id: turnId,
      started_at_ms: epoch + 320, completed_at_ms: epoch + 400,
      item: { type: "FileChange", id: "inner-patch", changes: Object.fromEntries(
        Array.from({ length: 40 }, (_, index) => [`/private/module-${index}.mjs`, { unified_diff: "secret-marker" }]),
      ) },
    } },
    item("foreign-item", 170, 10, "another-thread"),
    responseItem("custom_tool_call_output", 6_600),
    responseItem("custom_tool_call", 7_000, "outer-b"),
    tokenUsageRecord(turnId, "resp-tools-b", usage, 240, at(7_010)),
  ];
  const tail = [item("inner-c", 7_100, 100), responseItem("custom_tool_call_output", 7_300, "outer-b")];
  const events = [
    event("tool-active", "thread-active", threadId, null, { rolloutUsageFallback: true }),
    event("tool-start", "turn-started", threadId, turnId, {
      model: "gpt-5.6-sol", rolloutUsageFallback: true, generationMetricsVersion: GENERATION_METRICS_VERSION,
    }),
    ...["a", "b"].map((id) => event(`generation-${id}`, "generation", threadId, turnId, { generation: {
      responseId: `resp-tools-${id}`, toolNames: ["exec"], hasNonTextOutput: true,
    } })),
  ];
  const { manager, dataDir, codexHome } = await createManager(t, { events, rollouts: [{ threadId, records: prefix }] });
  const getTurn = (source) => source.getViewModel().turns.find((turn) => turn.turnId === turnId);
  const original = getTurn(manager);
  assert.deepEqual(original.generationDetails[0].toolExecutions.calls.map((call) => call.durationMs), [6_317, 5_000, 80]);
  assert.deepEqual(original.generationDetails[0].toolExecutions.calls.map((call) => call.description), ["1 条命令", "1 条命令", "40 个文件"]);
  assert.deepEqual(original.generationDetails[0].toolExecutions.calls[0].detailList, { kind: "commands", items: ["npm test"] });
  assert.equal(original.generationDetails[0].toolExecutions.calls[2].detailList.items.at(-1), "module-39.mjs");
  assert.equal(original.generationDetails[0].toolExecutions.durationMs, 6_500);
  assert.equal(original.generationDetails[1].toolExecutions.complete, false);
  assert.equal(original.totalTokens, 240);
  assert.equal(original.cost.available, true);
  await manager.flush();
  manager.close();

  // Resume a pending outer call across a cache reload, without rereading the
  // prefix; the response ID must survive and keep the two requests separate.
  const rolloutPath = [...manager.fileStates.keys()][0];
  await appendFile(rolloutPath, `${tail.map(JSON.stringify).join("\n")}\n`);
  const openManager = async (fallback = false) => {
    const restored = new TokenUsageManager({ codexHome, dataDir, discoveryIntervalMs: 0, pricingManager: pricing(dataDir) });
    if (fallback) restored.rolloutWorker = { postMessage() { throw new Error("fixture worker unavailable"); }, terminate() {} };
    t.after(() => restored.close());
    await restored.initialize();
    return restored;
  };
  const restored = await openManager();
  const expected = getTurn(restored);
  assert.deepEqual(expected.generationDetails[1].toolExecutions.calls.map((call) => call.id), ["inner-c"]);
  assert.equal(expected.totalTokens, 240);
  await restored.flush();
  restored.close();

  const cachePath = join(dataDir, "token-usage-cache.json");
  const current = JSON.parse(await readFile(cachePath, "utf8"));
  assert.equal(JSON.stringify(current).includes("secret-marker"), false);
  for (const fallback of [false, true]) {
    const old = structuredClone(current);
    old.version = 21;
    for (const turn of old.turns) {
      for (const item of turn.toolExecutionLedger?.items ?? []) {
        item.description = "已截断的旧明细";
        delete item.detailList;
      }
    }
    for (const state of old.fileStates) state.parserVersion = 8;
    await writeFile(cachePath, JSON.stringify(old));
    const rebuilt = await openManager(fallback);
    assert.deepEqual(getTurn(rebuilt).generationDetails, expected.generationDetails);
    assert.equal(getTurn(rebuilt).totalTokens, expected.totalTokens);
    assert.equal(getTurn(rebuilt).cost.totalCny, expected.cost.totalCny);
    await rebuilt.flush();
    rebuilt.close();
  }
});

test("旧版官方 token_count 保留计价，但缺少响应 ID 时不猜测速度", async (t) => {
  const threadId = "11111111-1111-4111-8111-111111111111";
  const turnId = "turn-official";
  const direct = protocolUsage({ input: 100, cached: 20, output: 20, reasoning: 5 });
  const last = rolloutUsage({ input: 100, cached: 20, output: 20, reasoning: 5 });
  const events = [
    event("1", "thread-active", threadId, null, { rolloutUsageFallback: true }),
    event("2", "turn-started", threadId, turnId, {
      model: "gpt-5.6-sol",
      rolloutUsageFallback: true,
      generationMetricsVersion: GENERATION_METRICS_VERSION,
    }),
    // Kept to verify replay of logs written by the buggy release does not double count.
    event("3", "usage", threadId, turnId, {
      model: "gpt-5.6-sol",
      tokenUsage: { last: direct, total: direct },
    }),
    event("4", "generation", threadId, turnId, {
      model: "gpt-5.6-sol",
      generation: {
        hasVisibleText: true,
        hasNonTextOutput: false,
        firstTokenLatencyMs: 500,
        generationDurationMs: 1_000,
      },
    }),
  ];
  const rollouts = [{
    threadId,
    records: [turnContext(turnId, "gpt-5.6-sol"), tokenCount(last, 120), taskComplete()],
  }];
  const { manager } = await createManager(t, { events, rollouts });
  const turn = manager.getViewModel().turns.find((value) => value.turnId === turnId);
  assert.equal(turn.totalTokens, 120);
  assert.equal(turn.inputTokens, 100);
  assert.equal(turn.outputTokens, 20);
  assert.equal(turn.completed, true);
  assert.equal(turn.cost.available, true);
  assert.equal(turn.cost.provider, "openai");
  assert.equal(turn.firstTokenLatencyMs, 500);
  assert.equal(turn.outputSpeed, null);
});

test("逐响应 usage 覆盖压缩并去重，且压缩输出不会污染下一次速度", async (t) => {
  const threadId = "12121212-1212-4212-8212-121212121212";
  const turnId = "turn-response-ledger";
  const normal = rolloutUsage({ input: 100, cached: 20, output: 20, reasoning: 5 });
  const compact = rolloutUsage({ input: 200, cached: 180, output: 10 });
  const legacy = rolloutUsage({ input: 5, output: 5 });
  const zeroComponents = {
    ...rolloutUsage({ input: 0, output: 0 }),
    total_tokens: 26_084,
  };
  const compactRecord = tokenUsageRecord(turnId, "resp-compact", compact, 210);
  const normalRecord = tokenUsageRecord(turnId, "resp-normal", normal, 330);
  const direct = protocolUsage({ input: 100, cached: 20, output: 20, reasoning: 5 });
  const events = [
    event("1", "thread-active", threadId, null, { rolloutUsageFallback: true }),
    event("2", "turn-started", threadId, turnId, {
      model: "gpt-5.6-sol",
      rolloutUsageFallback: true,
      generationMetricsVersion: GENERATION_METRICS_VERSION,
    }),
    event("3", "usage", threadId, turnId, {
      model: "gpt-5.6-sol",
      tokenUsage: { last: direct, total: direct },
    }),
    event("4", "generation", threadId, turnId, {
      model: "gpt-5.6-sol",
      generation: {
        responseId: "resp-normal",
        hasVisibleText: true,
        hasNonTextOutput: false,
        firstTokenLatencyMs: 500,
        generationDurationMs: 1_000,
      },
    }),
  ];
  const rollouts = [{
    threadId,
    records: [
      turnContext(turnId, "gpt-5.6-sol"),
      compactRecord,
      normalRecord,
      tokenCount(normal, 10_020),
      compactedCheckpoint(compactRecord.payload),
      compactRecord,
      tokenCount(zeroComponents, 9_999),
      // A response from an older rollout format still falls back to token_count.
      tokenCount(legacy, 10_030),
      taskComplete(),
    ],
  }];
  const { manager } = await createManager(t, { events, rollouts });
  const turn = manager.getViewModel().turns.find((value) => value.turnId === turnId);
  assert.equal(turn.inputTokens, 305);
  assert.equal(turn.cachedInputTokens, 200);
  assert.equal(turn.outputTokens, 35);
  assert.equal(turn.reasoningOutputTokens, 5);
  assert.equal(turn.totalTokens, 340);
  assert.equal(turn.outputSpeed, 14);
  assert.equal(turn.cost.available, true);
  assert.equal(turn.cost.provider, "openai");
  assert.equal("usageResponseIds" in turn, false);
  assert.equal("rolloutTokenCountTotalTokens" in turn, false);
  assert.equal("responseCumulativeTotalTokens" in turn, false);
  assert.equal(turn.cumulativeTotalTokens, 10_030);
});

test("旧版无响应 ID 通知仅作实时预览，逐响应账本会完整重建", async (t) => {
  const threadId = "13131313-1313-4313-8313-131313131313";
  const turnId = "turn-custom-response-record";
  const direct = protocolUsage({ input: 5, output: 5 });
  const exact = rolloutUsage({ input: 30, cached: 10, output: 10, reasoning: 2 });
  const missed = rolloutUsage({ input: 5, output: 5 });
  const events = [
    event("1", "turn-started", threadId, turnId, {
      model: "deepseek-v4-flash",
      modelSource: "turn-request",
    }),
    event("2", "usage", threadId, turnId, {
      model: "deepseek-v4-flash",
      tokenUsage: { last: direct, total: direct },
    }),
  ];
  const rollouts = [{
    threadId,
    records: [
      turnContext(turnId, "deepseek-v4-flash"),
      tokenUsageRecord(turnId, "resp-custom", exact, 40),
      tokenCount(exact, 40),
      tokenUsageRecord(turnId, "resp-custom-missed", missed, 50),
      tokenCount(missed, 50),
      taskComplete(),
    ],
  }];
  const { manager } = await createManager(t, { events, rollouts });
  const turn = manager.getViewModel().turns.find((value) => value.turnId === turnId);
  assert.equal(turn.inputTokens, 35);
  assert.equal(turn.outputTokens, 15);
  assert.equal(turn.totalTokens, 50);
});

test("官方辅助 usage 可直接计账，并与同回合逐响应记录统一去重", async (t) => {
  const threadId = "14141414-1414-4414-8414-141414141414";
  const turnId = "turn-official-auxiliary";
  const auxiliaryProtocol = protocolUsage({ input: 80, cached: 60, output: 20 });
  const auxiliaryRollout = rolloutUsage({ input: 80, cached: 60, output: 20 });
  const primaryRollout = rolloutUsage({ input: 15, cached: 10, output: 5 });
  const events = [
    event("1", "thread-active", threadId, null, { rolloutUsageFallback: true }),
    event("2", "turn-started", threadId, turnId, {
      model: "gpt-5.6-sol",
      rolloutUsageFallback: true,
    }),
    event("3", "usage", threadId, turnId, {
      model: "gpt-5.6-sol",
      responseId: "resp-auxiliary",
      rolloutUsageFallback: false,
      tokenUsage: { last: auxiliaryProtocol, total: auxiliaryProtocol },
    }),
  ];
  const rollouts = [{
    threadId,
    records: [
      turnContext(turnId, "gpt-5.6-sol"),
      tokenUsageRecord(turnId, "resp-auxiliary", auxiliaryRollout, 10),
      tokenCount(auxiliaryRollout, 100),
      tokenUsageRecord(turnId, "resp-primary", primaryRollout, 30),
      tokenCount(primaryRollout, 500),
      taskComplete(),
    ],
  }];
  const { manager, dataDir } = await createManager(t, { events, rollouts });
  let turn = manager.getViewModel().turns.find((value) => value.turnId === turnId);
  assert.equal(turn.inputTokens, 95);
  assert.equal(turn.cachedInputTokens, 70);
  assert.equal(turn.outputTokens, 25);
  assert.equal(turn.totalTokens, 120);
  assert.equal(turn.cumulativeTotalTokens, 500);
  assert.equal(turn.cost.available, true);
  const lateAuxiliary = protocolUsage({ input: 4, output: 1 });
  await appendEvents(dataDir, [
    event("4", "usage", threadId, turnId, {
      model: "gpt-5.6-sol",
      responseId: "resp-auxiliary-late",
      rolloutUsageFallback: false,
      tokenUsage: { last: lateAuxiliary, total: lateAuxiliary },
    }),
  ]);
  await manager.refresh();
  turn = manager.getViewModel().turns.find((value) => value.turnId === turnId);
  assert.equal(turn.totalTokens, 125);
  assert.equal(turn.cumulativeTotalTokens, 500);
});

test("多个官方任务的 rollout 同时读取，重复累计水位不会二次计数", async (t) => {
  const threads = [
    ["22222222-2222-4222-8222-222222222222", "turn-a", 10],
    ["33333333-3333-4333-8333-333333333333", "turn-b", 20],
  ];
  const events = [];
  const rollouts = [];
  let id = 0;
  for (const [threadId, turnId, input] of threads) {
    events.push(
      event(String(++id), "thread-active", threadId, null, { rolloutUsageFallback: true }),
      event(String(++id), "turn-started", threadId, turnId, {
        model: "gpt-5.6-luna",
        rolloutUsageFallback: true,
      }),
    );
    const last = rolloutUsage({ input, output: 5 });
    rollouts.push({
      threadId,
      records: [
        turnContext(turnId, "gpt-5.6-luna"),
        tokenCount(last, input + 5),
        tokenCount(last, input + 5),
      ],
    });
  }
  const { manager } = await createManager(t, { events, rollouts });
  const turns = manager.getViewModel().turns.filter((turn) => ["turn-a", "turn-b"].includes(turn.turnId));
  assert.equal(turns.length, 2);
  assert.deepEqual(turns.map((turn) => turn.totalTokens).sort((a, b) => a - b), [15, 25]);
});

test("子智能体用量形成摘要并计入根任务累计费用", async (t) => {
  const rootThread = "44444444-4444-4444-8444-444444444444";
  const childThread = "55555555-5555-4555-8555-555555555555";
  const rootTurn = "root-turn";
  const childTurn = "child-turn";
  const started = new Date(Date.now() - 1_000).toISOString();
  const completed = new Date().toISOString();
  const rootUsage = protocolUsage({ input: 10, output: 2 });
  const events = [
    event("1", "turn-started", rootThread, rootTurn, { model: "gpt-5.6-luna" }),
    event("2", "usage", rootThread, rootTurn, {
      model: "gpt-5.6-luna",
      tokenUsage: { last: rootUsage, total: rootUsage },
    }),
    event("3", "turn-completed", rootThread, rootTurn, {
      model: "gpt-5.6-luna",
      status: "completed",
      recordedAt: Date.now() + 5_000,
    }),
  ];
  const rollouts = [{
    threadId: childThread,
    options: {
      metadata: {
        session_id: rootThread,
        thread_source: "subagent",
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: rootThread,
              agent_path: "reviewer",
              agent_nickname: "review",
              depth: 1,
            },
          },
        },
      },
    },
    records: [
      turnContext(childTurn, "gpt-5.6-luna", started),
      tokenCount(rolloutUsage({ input: 8, output: 2 }), 10, completed),
      taskComplete(completed),
    ],
  }];
  const { manager } = await createManager(t, { events, rollouts });
  const view = manager.getViewModel();
  const child = view.turns.find((turn) => turn.turnId === childTurn);
  const summary = view.turns.find((turn) => turn.isSubagentSummary);
  const root = view.turns.find((turn) => turn.turnId === rootTurn);
  assert.equal(child.isSubagent, true);
  assert.equal(child.rootThreadId, rootThread);
  assert.equal(child.parentTurnId, rootTurn);
  assert.equal(summary.totalTokens, 10);
  assert.equal(summary.agentNickname, "review");
  assert.ok(root.cost.cumulativeCny > root.cost.totalCny);
});

test("逐响应记录与配对汇总分两次写入时，缓存恢复后仍只计一次", async (t) => {
  const threadId = "66666666-6666-4666-8666-666666666666";
  const turnId = "turn-incremental-usage";
  const exact = rolloutUsage({ input: 80, cached: 60, output: 20 });
  const { manager, dataDir, codexHome } = await createManager(t, {
    rollouts: [{
      threadId,
      records: [
        turnContext(turnId, "gpt-5.6-luna"),
        tokenUsageRecord(turnId, "resp-incremental", exact, 100),
      ],
    }],
  });
  assert.equal(
    manager.getViewModel().turns.find((turn) => turn.turnId === turnId)?.totalTokens,
    100,
  );
  await manager.flush();
  manager.close();

  const rolloutPath = join(
    codexHome,
    "sessions",
    "2026",
    "09",
    "11",
    `rollout-2026-09-11T00-00-00-${threadId}.jsonl`,
  );
  await appendFile(
    rolloutPath,
    `${JSON.stringify(tokenCount(exact, 100))}\n`,
  );
  const restored = new TokenUsageManager({
    codexHome,
    dataDir,
    discoveryIntervalMs: 0,
    pricingManager: pricing(dataDir),
  });
  t.after(() => restored.close());
  await restored.initialize();
  const turn = restored.getViewModel().turns.find((value) => value.turnId === turnId);
  assert.equal(turn.inputTokens, 80);
  assert.equal(turn.outputTokens, 20);
  assert.equal(turn.totalTokens, 100);
  await restored.flush();
  restored.close();
});

test("旧缓存升级会重建官方 rollout 用量，而不是在错误计数上继续叠加", async (t) => {
  const threadId = "77777777-7777-4777-8777-777777777777";
  const turnId = "turn-cache-rebuild";
  const exact = rolloutUsage({ input: 200, cached: 190, output: 10 });
  const zeroComponents = {
    ...rolloutUsage({ input: 0, output: 0 }),
    total_tokens: 26_084,
  };
  const events = [
    event("1", "thread-active", threadId, null, { rolloutUsageFallback: true }),
    event("2", "turn-started", threadId, turnId, {
      model: "gpt-5.6-sol",
      rolloutUsageFallback: true,
      generationMetricsVersion: GENERATION_METRICS_VERSION,
    }),
    event("3", "generation", threadId, turnId, {
      model: "gpt-5.6-sol",
      generation: {
        responseId: "resp-cache-rebuild",
        hasVisibleText: true,
        hasNonTextOutput: false,
        firstTokenLatencyMs: 300,
        generationDurationMs: 1_000,
      },
    }),
  ];
  const { manager, dataDir, codexHome } = await createManager(t, {
    events,
    rollouts: [{
      threadId,
      records: [
        turnContext(turnId, "gpt-5.6-sol"),
        tokenUsageRecord(turnId, "resp-cache-rebuild", exact, 210),
        tokenCount(zeroComponents, 26_084),
      ],
    }],
  });
  await manager.flush();
  manager.close();

  const cachePath = join(dataDir, "token-usage-cache.json");
  const cache = JSON.parse(await readFile(cachePath, "utf8"));
  cache.version = 16;
  const cachedTurn = cache.turns.find((turn) => turn.turnId === turnId);
  Object.assign(cachedTurn, {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 26_084,
    cumulativeTotalTokens: 26_084,
    segments: [{
      model: "gpt-5.6-sol",
      modelSource: "turn-context",
      contextTier: "short",
      usage: { ...zeroComponents },
    }],
  });
  cachedTurn.rolloutParserVersion = 5;
  delete cachedTurn.rolloutTokenCountTotalTokens;
  delete cachedTurn.usageResponseIds;
  for (const state of cache.fileStates) {
    state.parserVersion = 5;
    state.pendingUsageRecords = [{
      turnId,
      responseId: "resp-cache-rebuild",
    }];
  }
  await writeFile(cachePath, JSON.stringify(cache));

  const restored = new TokenUsageManager({
    codexHome,
    dataDir,
    discoveryIntervalMs: 0,
    pricingManager: pricing(dataDir),
  });
  t.after(() => restored.close());
  await restored.initialize();
  const turn = restored.getViewModel().turns.find((value) => value.turnId === turnId);
  assert.equal(turn.inputTokens, 200);
  assert.equal(turn.cachedInputTokens, 190);
  assert.equal(turn.outputTokens, 10);
  assert.equal(turn.totalTokens, 210);
  assert.equal(turn.cost.available, true);
  assert.equal(turn.firstTokenLatencyMs, 300);
  assert.equal(turn.outputSpeed, 9);
  await restored.flush();
  restored.close();
});

test("Token 缓存持久化后可恢复且不会保留零 Token 速率占位", async (t) => {
  const usage = protocolUsage({ input: 4, output: 4 });
  const { manager, dataDir, codexHome } = await createManager(t, {
    events: [
      event("1", "turn-started", "cache-thread", "cache-turn", {
        model: "gpt-5.6-luna",
        generationMetricsVersion: GENERATION_METRICS_VERSION,
      }),
      event("2", "usage", "cache-thread", "cache-turn", {
        model: "gpt-5.6-luna",
        tokenUsage: { last: usage, total: usage },
      }),
    ],
  });
  await manager.flush();
  manager.close();
  const cachePath = join(dataDir, "token-usage-cache.json");
  const cache = JSON.parse(await readFile(cachePath, "utf8"));
  cache.version = 11;
  cache.turns[0].firstTokenLatencyMs = 100;
  cache.turns[0].firstTokenLatencyTotalMs = 100;
  cache.turns[0].firstTokenLatencySamples = 1;
  cache.turns[0].outputSpeed = 3;
  cache.turns[0].outputGenerationDurationMs = 1_000;
  cache.turns[0].outputGenerationTokens = 3;
  delete cache.turns[0].generationDetails;
  cache.turns[0].pendingGenerationUsages = [0, 4];
  await writeFile(cachePath, JSON.stringify(cache));

  const restored = new TokenUsageManager({
    codexHome,
    dataDir,
    discoveryIntervalMs: 0,
    pricingManager: pricing(dataDir),
  });
  await restored.initialize();
  const migrated = restored.getViewModel().turns.find((value) => value.turnId === "cache-turn");
  assert.equal(migrated.firstTokenLatencyMs, null);
  assert.equal(migrated.outputSpeed, null);
  assert.deepEqual(migrated.generationDetails, []);
  await appendEvents(dataDir, [
    event("3", "turn-started", "cache-thread", "cache-turn", {
      model: "gpt-5.6-luna",
      generationMetricsVersion: GENERATION_METRICS_VERSION,
    }),
    event("4", "usage", "cache-thread", "cache-turn", {
      model: "gpt-5.6-luna",
      responseId: "resp-cache-visible",
      tokenUsage: {
        last: usage,
        total: protocolUsage({ input: 8, output: 8 }),
      },
    }),
    event("5", "generation", "cache-thread", "cache-turn", {
      model: "gpt-5.6-luna",
      generation: {
        responseId: "resp-cache-visible",
        hasVisibleText: true,
        hasNonTextOutput: false,
        firstTokenLatencyMs: 100,
        generationDurationMs: 1_000,
      },
    }),
  ]);
  await restored.refresh();
  const turn = restored.getViewModel().turns.find((value) => value.turnId === "cache-turn");
  assert.equal(turn.totalTokens, 16);
  assert.equal(turn.outputSpeed, 3);
  assert.equal(turn.generationDetails.length, 1);
  await restored.flush();
  restored.close();
});
