import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { notifyLifecycleCompletion } from "../src/lifecycle-completion.mjs";
import {
  createLifecycleReport,
  readLifecycleReport,
  writeLifecycleReport,
} from "../src/lifecycle-runner.mjs";
import { useTempDir } from "./helpers.mjs";

test("[HAR-02 LCH-01] 启停恢复测试终态重试置前 Codex 并记录发起任务且不改写测试结论", async (t) => {
  const directory = await useTempDir(t);
  const reportPath = join(directory, "report.json");
  const report = createLifecycleReport({
    runId: "completion-notification",
    projectVersion: "1.2.3",
    targetRelayProtocol: 55,
    steps: ["final-state"],
    metadata: { sessionCheckpoint: { turns: [
      { threadId: "thread-a", turnId: "turn-a" },
      { threadId: "thread-a", turnId: "turn-b" },
    ] } },
  });
  report.status = "passed";
  report.finishedAt = "2026-09-13T14:16:42.964Z";
  report.updatedAt = report.finishedAt;
  report.steps[0].status = "passed";
  await writeLifecycleReport(reportPath, report);

  let activationAttempts = 0;
  const waits = [];
  const notification = await notifyLifecycleCompletion({
    reportPath,
    activate: async () => ++activationAttempts === 3,
    wait: async (ms) => waits.push(ms),
    retryDelaysMs: [0, 10, 20],
    now: () => new Date("2026-09-13T14:16:45.000Z"),
  });

  assert.equal(notification.status, "activated");
  assert.equal(notification.attempts, 3);
  assert.deepEqual(notification.targetThreadIds, ["thread-a"]);
  assert.deepEqual(waits, [10, 20]);
  const stored = await readLifecycleReport(reportPath);
  assert.equal(stored.status, "passed");
  assert.equal(stored.finishedAt, "2026-09-13T14:16:42.964Z");
  assert.deepEqual(stored.completionNotification, notification);
});

test("[HAR-02 LCH-01] 结束唤起失败只记录通知失败，不覆盖 C 失败与回滚结果", async (t) => {
  const directory = await useTempDir(t);
  const reportPath = join(directory, "report.json");
  const report = createLifecycleReport({
    runId: "completion-notification-failed",
    projectVersion: "1.2.3",
    targetRelayProtocol: 55,
    steps: ["final-state"],
  });
  report.status = "failed";
  report.finishedAt = "2026-09-13T14:16:42.964Z";
  report.updatedAt = report.finishedAt;
  report.error = { name: "Error", code: null, message: "生命周期断言失败" };
  report.steps[0].status = "failed";
  report.steps[0].rollback = { status: "passed" };
  await writeLifecycleReport(reportPath, report);

  const notification = await notifyLifecycleCompletion({
    reportPath,
    activate: async () => false,
    wait: async () => undefined,
    retryDelaysMs: [0],
  });
  const stored = await readLifecycleReport(reportPath);
  assert.equal(notification.status, "failed");
  assert.equal(stored.status, "failed");
  assert.equal(stored.error.message, "生命周期断言失败");
  assert.equal(stored.steps[0].rollback.status, "passed");
});

test("[HAR-02 LCH-01] 尚未形成 启停恢复测试终态时不提前唤起或写入通知", async (t) => {
  const directory = await useTempDir(t);
  const reportPath = join(directory, "report.json");
  const report = createLifecycleReport({
    runId: "completion-notification-running",
    projectVersion: "1.2.3",
    targetRelayProtocol: 55,
    steps: ["final-state"],
  });
  report.status = "running";
  await writeLifecycleReport(reportPath, report);

  let activated = false;
  const notification = await notifyLifecycleCompletion({
    reportPath,
    activate: async () => { activated = true; return true; },
  });
  assert.equal(notification, null);
  assert.equal(activated, false);
  assert.equal((await readLifecycleReport(reportPath)).completionNotification, undefined);
});
