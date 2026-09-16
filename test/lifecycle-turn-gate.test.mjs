import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  captureCodexSessionCheckpoint,
  findActiveCodexTurns,
  parseActiveCodexTurns,
  rolloutThreadId,
  waitForCodexTurnsIdle,
} from "../src/lifecycle-turn-gate.mjs";
import { useTempDir } from "./helpers.mjs";

const record = (type, turnId, timestamp) => JSON.stringify({
  timestamp,
  type: "event_msg",
  payload: { type, turn_id: turnId },
});

test("[A HAR-04 LCH-03] 只有缺少完成事件的最新 Codex 回合会阻止生命周期关闭", () => {
  const active = parseActiveCodexTurns([
    record("task_started", "lost-on-restart", "2026-09-13T11:00:00.000Z"),
    record("task_started", "current", "2026-09-13T11:01:00.000Z"),
  ].join("\n"), { path: "rollout.jsonl" });
  assert.deepEqual(active, [{
    path: "rollout.jsonl",
    turnId: "current",
    startedAt: "2026-09-13T11:01:00.000Z",
  }]);

  assert.deepEqual(parseActiveCodexTurns([
    record("task_started", "completed", "2026-09-13T11:02:00.000Z"),
    record("task_complete", "completed", "2026-09-13T11:03:00.000Z"),
  ].join("\n")), []);
  assert.deepEqual(parseActiveCodexTurns([
    record("task_started", "aborted", "2026-09-13T11:04:00.000Z"),
    record("turn_aborted", "aborted", "2026-09-13T11:05:00.000Z"),
  ].join("\n")), []);
});

test("[A HAR-04 LCH-03] 生命周期等待活动回合完成落盘后才允许关闭", async () => {
  const observations = [
    [{ turnId: "active" }],
    [],
  ];
  const result = await waitForCodexTurnsIdle({
    findActiveTurns: async () => observations.shift() ?? [],
    stableDurationMs: 0,
    pollIntervalMs: 1,
    timeoutMs: 100,
  });
  assert.deepEqual(result, { idle: true, observedTurnCount: 1 });
});

test("[C HAR-04 LCH-04] 调度时固定发起 C 的任务和回合用于重启后持久化验收", async (t) => {
  const codexHome = await useTempDir(t, "codex-session-checkpoint-");
  const sessions = join(codexHome, "sessions", "2026", "09", "13");
  await mkdir(sessions, { recursive: true });
  const rollout = join(sessions, "rollout-01a0966e-380a-7692-a939-0a3beeb054a5.jsonl");
  await writeFile(rollout, `${record(
    "task_started",
    "01a09a62-8415-7290-a294-aff2102807d2",
    "2026-09-13T11:00:00.000Z",
  )}\n`);
  const checkpoint = await captureCodexSessionCheckpoint({ codexHome });
  assert.equal(checkpoint.turns.length, 1);
  assert.deepEqual(checkpoint.turns[0], {
    path: rollout,
    turnId: "01a09a62-8415-7290-a294-aff2102807d2",
    startedAt: "2026-09-13T11:00:00.000Z",
  });
  assert.ok(Number.isFinite(Date.parse(checkpoint.capturedAt)));
});

test("[A HAR-04 LCH-03] 大型 rollout 从尾部查找状态且不损坏跨块 UTF-8", async (t) => {
  const codexHome = await useTempDir(t, "codex-turn-gate-");
  const sessions = join(codexHome, "sessions", "2026", "09", "13");
  await mkdir(sessions, { recursive: true });
  const rollout = join(sessions, "rollout.jsonl");
  const noise = Array.from({ length: 3_000 }, (_, index) => JSON.stringify({
    type: "event_msg",
    payload: { type: "token_count", index, text: "测试内容".repeat(25) },
  })).join("\n");
  await writeFile(rollout, `${record("task_started", "active", "2026-09-13T11:00:00.000Z")}\n${noise}\n`);
  assert.deepEqual(await findActiveCodexTurns({ codexHome }), [{
    path: rollout,
    turnId: "active",
    startedAt: "2026-09-13T11:00:00.000Z",
  }]);

  await appendFile(rollout, `${record("task_complete", "active", "2026-09-13T11:05:00.000Z")}\n`);
  assert.deepEqual(await findActiveCodexTurns({ codexHome }), []);
});

test("[A HAR-04 LCH-03] 活动回合未落盘时超时并拒绝关闭", async () => {
  await assert.rejects(waitForCodexTurnsIdle({
    findActiveTurns: async () => [{ turnId: "active" }],
    stableDurationMs: 0,
    pollIntervalMs: 1,
    timeoutMs: 3,
  }), /拒绝关闭桌面应用/);
});

test("[A HAR-04 LCH-03] 官方索引指向恢复后的 rollout 时，旧文件不再制造假活动回合", async t => {
  const codexHome = await useTempDir(t, "codex-turn-index-");
  const sessions = join(codexHome, "sessions");
  await mkdir(sessions);
  const id = "01a0a3f6-5bb6-77a2-9ab8-c93b249cc535";
  const old = join(sessions, `rollout-old-${id}.jsonl`);
  const current = join(sessions, `rollout-new-${id}_01a0a40d-4715-7732-befc-e7856cefe993.jsonl`);
  await writeFile(old, record("task_started", "abandoned", "2026-09-15T07:50:00Z") + "\n");
  await writeFile(current, record("task_complete", "recovered", "2026-09-15T07:55:00Z") + "\n");
  const database = new DatabaseSync(join(codexHome, "state_5.sqlite"));
  try {
    database.exec("CREATE TABLE threads (id TEXT, rollout_path TEXT)");
    database.prepare("INSERT INTO threads VALUES (?, ?)").run(id, current);
    assert.equal(rolloutThreadId(current), id);
    assert.deepEqual(await findActiveCodexTurns({ codexHome, sqliteHome: codexHome }), []);
    await appendFile(current, record("task_started", "actually-running", "2026-09-16T00:00:00Z") + "\n");
    assert.deepEqual((await findActiveCodexTurns({ codexHome, sqliteHome: codexHome })).map(x => x.turnId), ["actually-running"]);
    database.prepare("UPDATE threads SET rollout_path = ?").run(join(sessions, "missing.jsonl"));
    await assert.rejects(findActiveCodexTurns({ codexHome, sqliteHome: codexHome }), { code: "ENOENT" });
  } finally { database.close(); }
});
