import assert from "node:assert/strict";
import test from "node:test";
import { event, protocolUsage, rolloutUsage, appendEvents, turnContext, tokenCount, tokenUsageRecord, taskComplete, createManager } from "./token-usage/support.mjs";

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
