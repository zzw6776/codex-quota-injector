import assert from "node:assert/strict";
import test from "node:test";
import { CodexTurnStateMonitor } from "../src/model-router/turn-state-monitor.mjs";

const official = (threadId, model = "gpt-5.6-sol") => ({
  threadId,
  model,
  target: { kind: "official" },
});

test("292 状态只读取官方 x-codex-turn-state，并按任务隔离且不暴露原值", () => {
  let now = 100;
  const monitor = new CodexTurnStateMonitor({ clock: () => now++ });
  const changes = [];
  monitor.onChange((view, threadId) => changes.push({ view, threadId }));

  assert.equal(monitor.observe(official("one"), {
    current_turn_state: "x".repeat(292),
  }), false, "current_turn_state 不是当前指示器的数据源");
  assert.equal(monitor.observe({ ...official("one"), target: { kind: "custom" } }, {
    headers: { "x-codex-turn-state": "x".repeat(292) },
  }), false, "第三方同名字段不能冒充官方状态");
  assert.equal(monitor.observe(official("one"), {
    headers: { "x-codex-turn-state": "x".repeat(292) },
  }), true);
  assert.deepEqual(monitor.getViewModel("one"), {
    status: "match", expectedByteLength: 292, byteLength: 292,
    model: "gpt-5.6-sol", observedAt: 100,
  });
  assert.deepEqual(monitor.getViewModel("two"), {
    status: "unknown", expectedByteLength: 292, byteLength: null,
    model: null, observedAt: null,
  });
  assert.equal(JSON.stringify(changes).includes("x".repeat(32)), false,
    "公开状态不得包含 state 原值");

  monitor.observe(official("one", "gpt-6-astra"), {
    headers: { "x-codex-turn-state": "短状态" },
  });
  assert.deepEqual(monitor.getViewModel("one"), {
    status: "mismatch", expectedByteLength: 292,
    byteLength: Buffer.byteLength("短状态"), model: "gpt-6-astra", observedAt: 101,
  });
});
