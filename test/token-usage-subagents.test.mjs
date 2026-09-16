import assert from "node:assert/strict";
import test from "node:test";
import { event, protocolUsage, rolloutUsage, turnContext, tokenCount, taskComplete, createManager } from "./token-usage/support.mjs";

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
