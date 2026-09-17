import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { createMacLifecyclePlan } from "../scripts/lifecycle-macos.mjs";
import { protectMacLifecycleOperations } from "../scripts/lifecycle-macos-session.mjs";
import { createLifecycleReport, runLifecycleReport, writeLifecycleReport } from "../src/lifecycle-runner.mjs";
import { renderLifecycleProgressHtml } from "../src/lifecycle-progress.mjs";
import { useTempDir } from "./helpers.mjs";

const startupSteps = ["verify-package", "wait-desktop-idle", "install-update", "launch-updated",
  "repeat-launch", "relay-reconnect", "close-reopen", "final-state"];

test("[platform:macos-native] [LCH-01 LCH-06] Mac 定向计划无双账号前置和模型请求，默认完整计划仍包含账号往返", async t => {
  const root = await useTempDir(t);
  for (const roundTripAvailable of [false, true]) {
    const options = { root, projectVersion: "1.2.3", expectedProtocol: 84,
      inspectHost: async () => ({ accounts: { roundTripAvailable } }) };
    const targeted = await createMacLifecyclePlan({ ...options, taskToolsOnly: true });
    assert.equal(targeted.scope, "task-tools-startup");
    assert.equal(targeted.tokenRequests, 0);
    assert.equal(targeted.accountRoundTrip, "not-run");
    assert.deepEqual(targeted.steps, startupSteps);
    const full = await createMacLifecyclePlan(options);
    assert.equal(full.scope, "full");
    assert.deepEqual(full.steps, [...startupSteps.slice(0, -1), "switch-account", "restore-account", "final-state"]);
    assert.equal(full.tokenRequests, roundTripAvailable ? 1 : 0);
    assert.equal(full.accountRoundTrip, roundTripAvailable ? "ready" : "blocked-less-than-two-oauth-accounts");
  }
});

test("[platform:macos-native] [LCH-03 LCH-04 LCH-06] Mac 定向执行及恢复只运行已选步骤，保留关闭前后会话门禁", async t => {
  const root = await useTempDir(t);
  const plan = await createMacLifecyclePlan({ root, taskToolsOnly: true,
    inspectHost: async () => ({ accounts: { roundTripAvailable: false } }) });
  const reportPath = join(root, "report.json");
  const report = createLifecycleReport({ steps: plan.steps, metadata: { scope: plan.scope } });
  report.steps[0].status = "passed";
  report.steps[1].status = "running";
  await writeLifecycleReport(reportPath, report);
  const events = [];
  const operations = protectMacLifecycleOperations({
    ...Object.fromEntries(plan.steps.map(id => [id, {
      replaySafe: true,
      run: async () => { events.push(id); return { checked: true }; },
      reconcile: async () => { events.push(`recover:${id}`); return { completed: true }; },
    }])),
    "switch-account": { run: async () => assert.fail("定向补测不得切换账号或发送冒烟") },
    "restore-account": { run: async () => assert.fail("定向补测不得触发账号写入") },
  }, {
    before: async () => { events.push("durable-before"); },
    after: async () => { events.push("durable-after"); return { status: "durable" }; },
  });
  const result = await runLifecycleReport({ reportPath, operations });
  assert.equal(result.status, "passed");
  assert.equal(result.steps.length, 8);
  assert.equal(result.steps[1].recovered, true);
  assert.deepEqual(events, plan.steps.slice(1).flatMap((id, index) =>
    ["durable-before", index === 0 ? `recover:${id}` : id, "durable-after"]));
  const html = renderLifecycleProgressHtml(result);
  assert.match(html, /定向补测通过/);
  assert.match(html, /已通过 8\/8/);
  assert.match(html, /账号切换与模型冒烟未执行/);
  assert.doesNotMatch(html, /生命周期测试全部通过/);
});
