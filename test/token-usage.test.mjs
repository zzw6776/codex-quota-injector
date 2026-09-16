import assert from "node:assert/strict";
import test from "node:test";
import { GENERATION_METRICS_VERSION } from "../src/relay-contract.mjs";
import { event, protocolUsage, createManager } from "./token-usage/support.mjs";

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
