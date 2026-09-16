import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  captureMacLifecycleSession,
  createMacLifecycleSessionGuard,
  inspectMacLifecycleHistory,
  protectMacLifecycleOperations,
  validateMacLifecycleSession,
} from "../scripts/lifecycle-macos-session.mjs";
import { createMacLifecycleOperations, launchdPlist } from "../scripts/lifecycle-macos.mjs";
import { useTempDir } from "./helpers.mjs";

const threadId = "01a09f91-2789-7dd1-b293-5c08e741f5ed";
const path = `/tmp/sessions/rollout-${threadId}.jsonl`;
const turn = { path, turnId: "turn-current", startedAt: "2026-09-16T00:00:00Z" };
const control = {
  sessionSafetyVersion: 1,
  codexHome: "/tmp/codex-home",
  sqliteHome: "/tmp/codex-sqlite",
  initiatingTurn: { ...turn, threadId },
  sessionCheckpoint: { turns: [turn] },
};
const healthyHistory = async () => ({ repairRequired: false, activeTurn: null, lastOrdinal: 20 });

test("[platform:macos-native] [LCH-04] Mac 调度绑定实际发起回合及独立 SQLite 目录，拒绝空绑定与旧控制记录", async () => {
  const session = await captureMacLifecycleSession({
    codexHome: control.codexHome, sqliteHome: control.sqliteHome, threadId,
    capture: async (options) => {
      assert.equal(options.codexHome, control.codexHome);
      return { turns: [turn] };
    },
  });
  assert.deepEqual(session.initiatingTurn, { threadId, turnId: turn.turnId, path });
  assert.equal(session.sqliteHome, control.sqliteHome);
  await assert.rejects(captureMacLifecycleSession({ threadId, capture: async () => ({ turns: [] }) }), /无法绑定/);
  assert.throws(() => validateMacLifecycleSession({ version: 1, startDelayMs: 10000 }), /旧任务/);
  assert.throws(() => validateMacLifecycleSession({ ...control, initiatingTurn: { ...control.initiatingTurn, turnId: "other" } }), /会话绑定/);
});

test("[platform:macos-native] [LCH-04] Mac 历史异常在调度前阻断，不在线改写记录", async t => {
  const directory = await useTempDir(t, "mac-c-history-");
  const file = join(directory, `rollout-${threadId}.jsonl`);
  const records = [
    { ordinal: 0, type: "event_msg", payload: { type: "task_started", turn_id: "old" } },
    { ordinal: 3, type: "event_msg", payload: { type: "task_started", turn_id: turn.turnId } },
  ].map(JSON.stringify).join("\n") + "\n";
  await writeFile(file, records);
  const bound = { ...control, initiatingTurn: { ...control.initiatingTurn, path: file },
    sessionCheckpoint: { turns: [{ ...turn, path: file }] } };
  await assert.rejects(inspectMacLifecycleHistory(bound, { allowActive: true }), /历史结构不完整/);
  assert.equal(await readFile(file, "utf8"), records);
});

test("[platform:macos-native] [LCH-03 LCH-04] Mac 关闭必须等待回合结束且投影追平，重启后再次核验", async () => {
  const events = [];
  let finishTurn;
  let inspections = 0;
  const guard = createMacLifecycleSessionGuard(control, {
    waitIdle: async ({ codexHome }) => {
      assert.equal(codexHome, control.codexHome);
      events.push("wait-idle");
      await new Promise(resolve => { finishTurn = resolve; });
    },
    inspectHistory: healthyHistory,
    inspectStore: async request => {
      assert.equal(request.sqliteHome, control.sqliteHome);
      assert.equal(request.threadId, threadId);
      assert.deepEqual(request.turnIds, [turn.turnId]);
      assert.equal(request.lastOrdinal, 20);
      events.push("projection");
      return ++inspections === 1 ? { healthy: false, reason: "projection-behind" } : { healthy: true };
    },
    timeoutMs: 100, pollIntervalMs: 0,
  });
  const ops = protectMacLifecycleOperations({ "close-reopen": {
    run: async () => { events.push("close-reopen"); return { reopened: true }; },
  } }, guard);
  const running = ops["close-reopen"].run();
  await Promise.resolve();
  assert.deepEqual(events, ["wait-idle"]);
  finishTurn();
  const result = await running;
  assert.deepEqual(events, ["wait-idle", "projection", "projection", "close-reopen", "projection"]);
  assert.equal(result.reopened, true);
  assert.equal(result.sessionHistory.status, "durable");
});

test("[platform:macos-native] [LCH-04] Mac 投影不追平或活动回合仍存在时，拒绝完成重启步骤", async () => {
  const guard = createMacLifecycleSessionGuard(control, {
    waitIdle: async () => undefined,
    inspectHistory: healthyHistory,
    inspectStore: async () => ({ healthy: false, reason: "turn-not-durable" }),
    timeoutMs: 0,
  });
  await assert.rejects(guard.after(), /不推进下一次重启/);
  const active = createMacLifecycleSessionGuard(control, {
    waitIdle: async () => undefined,
    inspectHistory: async () => ({ repairRequired: false, activeTurn: { turnId: "new" } }),
    inspectStore: async () => assert.fail("活动回合不可当作已落盘"),
  });
  await assert.rejects(active.before(), /仍有活动回合/);
});

test("[platform:macos-native] [LCH-03 LCH-04 LCH-06] Mac 实际操作表的关闭、接管、账号入口全部经过门禁且没有回滚", async () => {
  let calls = 0;
  const blocked = new Error("test-session-blocked");
  const ops = createMacLifecycleOperations("/nonexistent/control.json", control, {
    sessionGuard: { before: async () => { calls++; throw blocked; }, after: async () => assert.fail("门禁失败后不可继续") },
  });
  let checked = 0;
  for (const [id, operation] of Object.entries(ops)) {
    if (id === "verify-package") continue;
    for (const method of ["run", "reconcile"]) {
      if (!operation[method]) continue;
      await assert.rejects(operation[method](), error => error === blocked, `${id}/${method}`);
      checked++;
    }
  }
  assert.ok(checked >= 18);
  assert.ok(Object.values(ops).every(operation => operation.rollback === undefined));
  assert.equal(calls, checked);
});

test("[platform:macos-native] [LCH-04] Mac 控制器恢复不能跳过重启后历史检查", async () => {
  const events = [];
  const ops = protectMacLifecycleOperations({ test: {
    reconcile: async () => ({ completed: true, evidence: { recovered: true } }),
  } }, {
    before: async () => { events.push("before"); },
    after: async () => { events.push("after"); throw new Error("projection-behind"); },
  });
  await assert.rejects(ops.test.reconcile(), /projection-behind/);
  assert.deepEqual(events, ["before", "after"]);
  assert.doesNotMatch(launchdPlist({}), /--recover/);
});
