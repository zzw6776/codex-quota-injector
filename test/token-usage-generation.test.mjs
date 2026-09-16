import assert from "node:assert/strict";
import test from "node:test";
import { GENERATION_METRICS_VERSION } from "../src/relay-contract.mjs";
import { TokenUsageManager } from "../src/token-usage.mjs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pricing, event, protocolUsage, createManager, rolloutUsage, turnContext, tokenCount, taskComplete, tokenUsageRecord, compactedCheckpoint, appendEvents } from "./token-usage/support.mjs";

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
