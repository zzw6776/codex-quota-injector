import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import test from "node:test";
import { TokenUsageManager } from "../src/token-usage.mjs";
import { event, protocolUsage, rolloutUsage, createManager, pricing, appendEvents, writeRollout, turnContext, tokenUsageRecord, tokenCount, taskComplete } from "./token-usage/support.mjs";

test("官方临时侧聊无需 rollout；旧通知、重复响应和回落水位不会重复计账", async (t) => {
  const threadId = "ephemeral-official";
  const turnId = "ephemeral-turn";
  const first = protocolUsage({ input: 80, cached: 60, output: 20 });
  const second = protocolUsage({ input: 30, cached: 20, output: 10 });
  const events = [
    event("1", "turn-started", threadId, turnId, { model: "gpt-5.6-sol", rolloutUsageFallback: true }),
    event("2", "usage", threadId, turnId, { tokenUsage: { last: first, total: { totalTokens: 10_100 } } }),
    event("3", "usage", threadId, turnId, { responseId: "resp-a", rolloutUsageFallback: false, tokenUsage: { last: first, total: first } }),
    event("4", "usage", threadId, turnId, { responseId: "resp-a", rolloutUsageFallback: false, tokenUsage: { last: first, total: first } }),
    event("5", "usage", threadId, turnId, { tokenUsage: { last: first, total: { totalTokens: 10_100 } } }),
    event("late-start", "turn-started", threadId, turnId, { rolloutUsageFallback: true }),
    event("6", "usage", threadId, turnId, { responseId: "resp-b", rolloutUsageFallback: false, tokenUsage: { last: second, total: second } }),
    event("7", "turn-completed", threadId, turnId, { status: "completed" }),
  ];
  const { manager } = await createManager(t, { events });
  const turn = manager.getViewModel().turns.find((turn) => turn.turnId === turnId);
  assert.equal(turn.totalTokens, 140);
  assert.equal(turn.inputTokens, 110);
  assert.equal(turn.cachedInputTokens, 80);
  assert.equal(turn.outputTokens, 30);
  assert.equal(turn.completed, true);
  assert.equal(turn.cost.available, true);
  assert.equal(manager.fileStates.size, 0);
});

for (const firstSource of ["Router", "rollout"]) {
  test(`${firstSource} 先到，另一来源及缓存恢复仍按响应 ID 合并且不丢压缩用量`, async (t) => {
    const threadId = "45454545-4545-4545-8545-454545454545";
    const turnId = "ordered-ledger";
    const first = protocolUsage({ input: 80, cached: 60, output: 20 });
    const exact = rolloutUsage({ input: 80, cached: 60, output: 20 });
    const records = [turnContext(turnId, "gpt-5.6-sol"), tokenUsageRecord(turnId, "resp-shared", exact, 100), tokenCount(exact, 100)];
    const events = [
      event("start", "turn-started", threadId, turnId, { model: "gpt-5.6-sol", rolloutUsageFallback: true }),
      event("router", "usage", threadId, turnId, { responseId: "resp-shared", rolloutUsageFallback: false, tokenUsage: { last: first, total: first } }),
    ];
    const fixture = await createManager(t, firstSource === "Router"
      ? { events }
      : { rollouts: [{ threadId, records }] });
    const { manager, dataDir, codexHome } = fixture;
    assert.equal(manager.getViewModel().turns.find((turn) => turn.turnId === turnId).totalTokens, 100);
    await manager.flush();
    manager.close();
    let path;
    if (firstSource === "Router") path = await writeRollout(codexHome, threadId, records);
    else {
      await appendEvents(dataDir, events);
      path = [...manager.fileStates.keys()][0];
    }
    const restored = new TokenUsageManager({ codexHome, dataDir, discoveryIntervalMs: 0, pricingManager: pricing(dataDir) });
    t.after(() => restored.close());
    await restored.initialize();
    const getTurn = () => restored.getViewModel().turns.find((turn) => turn.turnId === turnId);
    assert.equal(getTurn().totalTokens, 100);
    const compacted = rolloutUsage({ input: 15, cached: 10, output: 5 });
    await appendFile(path, `${[
      tokenUsageRecord(turnId, "resp-compaction", compacted, 20),
      tokenCount({ total_tokens: 9_000 }, 9_000),
      tokenCount(exact, 10_000),
      taskComplete(),
    ].map(JSON.stringify).join("\n")}\n`);
    await restored.refresh();
    assert.equal(getTurn().totalTokens, 120);
    assert.equal(getTurn().inputTokens, 95);
    assert.equal(getTurn().outputTokens, 25);
    assert.equal(getTurn().cost.available, true);
    await restored.flush();
    restored.close();
  });
}
