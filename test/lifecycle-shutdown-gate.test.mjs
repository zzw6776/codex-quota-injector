import assert from "node:assert/strict";
import test from "node:test";

import { waitForCodexShutdownReadiness } from "../src/lifecycle-shutdown-gate.mjs";

test("安全关闭等待活动回合、历史投影及连续稳定检查", async () => {
  const tracked = [{ path: "/rollout.jsonl", threadId: "thread", turnIds: ["turn"] }];
  const observations = [
    { ready: false, reason: "等待当前任务结束", tracked },
    { ready: false, reason: "等待任务历史投影落盘", tracked },
    { ready: true, tracked },
    { ready: true, tracked },
  ];
  const statuses = [];
  let time = 0;
  const result = await waitForCodexShutdownReadiness({
    inspect: async () => observations.shift(),
    onStatus: (status) => statuses.push(status.reason ?? "ready"),
    now: () => time,
    sleep: async (milliseconds) => { time += milliseconds; },
    timeoutMs: 10_000,
  });
  assert.equal(result.ready, true);
  assert.equal(result.stableObservations, 2);
  assert.deepEqual(statuses, [
    "等待当前任务结束",
    "等待任务历史投影落盘",
    "ready",
    "ready",
  ]);
});

test("安全关闭超时后拒绝重启", async () => {
  let time = 0;
  await assert.rejects(waitForCodexShutdownReadiness({
    inspect: async () => ({ ready: false, reason: "等待当前任务结束", tracked: [] }),
    now: () => time,
    sleep: async (milliseconds) => { time += milliseconds; },
    pollIntervalMs: 10,
    timeoutMs: 15,
  }), /拒绝重启 Codex/);
});
