import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  inspectThreadHistoryStore,
  resetThreadHistoryProjection,
} from "../src/lifecycle-history-store.mjs";
import { useTempDir } from "./helpers.mjs";

test("[LCH-04] 分页投影必须追平 rollout 且包含发起回合", async (t) => {
  const root = await useTempDir(t, "codex-history-store-");
  const sqliteHome = join(root, "sqlite");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(sqliteHome));
  const rolloutPath = join(root, "rollout.jsonl");
  await writeFile(rolloutPath, "one\ntwo\n");
  createState(join(sqliteHome, "state_5.sqlite"), rolloutPath);
  createHistory(join(sqliteHome, "thread_history_1.sqlite"), 8, 2, "completed", 1);

  const healthy = await inspectThreadHistoryStore({
    sqliteHome, threadId: "thread", rolloutPath, lastOrdinal: 1, turnIds: ["turn"],
  });
  assert.equal(healthy.healthy, true);

  const history = new DatabaseSync(join(sqliteHome, "thread_history_1.sqlite"));
  history.prepare("UPDATE thread_history_projection_state SET next_rollout_byte_offset = 12, next_rollout_ordinal = 3 WHERE thread_id = 'thread'").run();
  history.close();
  const advancedDuringRead = await inspectThreadHistoryStore({
    sqliteHome, threadId: "thread", rolloutPath, lastOrdinal: 1, turnIds: ["turn"],
  });
  assert.equal(advancedDuringRead.healthy, true);

  const behindHistory = new DatabaseSync(join(sqliteHome, "thread_history_1.sqlite"));
  behindHistory.prepare("UPDATE thread_history_projection_state SET next_rollout_byte_offset = 4 WHERE thread_id = 'thread'").run();
  behindHistory.close();
  const behind = await inspectThreadHistoryStore({
    sqliteHome, threadId: "thread", rolloutPath, lastOrdinal: 1, turnIds: ["turn"],
  });
  assert.equal(behind.healthy, false);
  assert.equal(behind.reason, "projection-behind");

  const missingItemHistory = new DatabaseSync(join(sqliteHome, "thread_history_1.sqlite"));
  missingItemHistory.prepare(
    "UPDATE thread_history_projection_state SET next_rollout_byte_offset = 12 WHERE thread_id = 'thread'",
  ).run();
  missingItemHistory.prepare("DELETE FROM thread_items WHERE thread_id = 'thread' AND item_type = 'agentMessage'").run();
  missingItemHistory.close();
  const missingItem = await inspectThreadHistoryStore({
    sqliteHome, threadId: "thread", rolloutPath, lastOrdinal: 1, turnIds: ["turn"],
  });
  assert.equal(missingItem.healthy, false);
  assert.equal(missingItem.reason, "turn-not-durable");
  assert.equal(missingItem.turns[0].firstUserItemPresent, true);
  assert.equal(missingItem.turns[0].finalAgentItemPresent, false);
});

test("[LCH-04] 重建只清空目标任务投影并保留状态元数据", async (t) => {
  const root = await useTempDir(t, "codex-history-reset-");
  const sqliteHome = join(root, "sqlite");
  const backupDirectory = join(root, "backup");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(sqliteHome));
  createState(join(sqliteHome, "state_5.sqlite"), join(root, "rollout.jsonl"));
  createHistory(join(sqliteHome, "thread_history_1.sqlite"), 0, 0, "completed", 1);
  const result = await resetThreadHistoryProjection({
    sqliteHome, threadId: "thread", backupDirectory, label: "wsl",
  });
  assert.equal(result.thread.title, "保留标题");
  const state = new DatabaseSync(join(sqliteHome, "state_5.sqlite"), { readOnly: true });
  assert.equal(state.prepare("SELECT title FROM threads WHERE id = 'thread'").get().title, "保留标题");
  state.close();
  const history = new DatabaseSync(join(sqliteHome, "thread_history_1.sqlite"), { readOnly: true });
  assert.equal(history.prepare("SELECT count(*) AS count FROM thread_items WHERE thread_id = 'thread'").get().count, 0);
  assert.equal(history.prepare("SELECT count(*) AS count FROM thread_items WHERE thread_id = 'other'").get().count, 1);
  history.close();
});

test("[LCH-04] 恢复文件检查独立投影，旧任务索引不能误阻断或掩盖当前缺项", async t => {
  const root = await useTempDir(t, "codex-history-recovered-");
  const threadId = "01a0a992-7cef-76a0-a30f-93a7966fbe96";
  const projectionId = "01a0a9ad-ab8f-78f3-93e2-95c969f6a775";
  const rolloutPath = join(root, `rollout-2026-09-16T18-05-26-${threadId}_${projectionId}.jsonl`);
  await writeFile(rolloutPath, "one\ntwo\n");
  createState(join(root, "state_5.sqlite"), rolloutPath);
  const state = new DatabaseSync(join(root, "state_5.sqlite"));
  state.prepare("UPDATE threads SET id=? WHERE id='thread'").run(threadId);
  state.close();
  createHistory(join(root, "thread_history_1.sqlite"), 8, 2, "completed", 1);
  const history = new DatabaseSync(join(root, "thread_history_1.sqlite"));
  try {
    for (const table of ["thread_history_projection_state", "thread_turns", "thread_items"]) {
      history.prepare(`UPDATE ${table} SET thread_id=? WHERE thread_id='thread'`).run(projectionId);
    }
    history.prepare("INSERT INTO thread_history_projection_state VALUES (?,0,0)").run(threadId);
    const check = () => inspectThreadHistoryStore({ sqliteHome: root, threadId, rolloutPath,
      lastOrdinal: 1, turnIds: ["turn"] });
    const healthy = await check();
    assert.equal(healthy.healthy, true);
    assert.equal(healthy.thread.id, threadId);
    assert.equal(healthy.projectionId, projectionId);
    assert.equal(history.prepare("SELECT next_rollout_ordinal AS n FROM thread_history_projection_state WHERE thread_id=?").get(threadId).n, 0);

    history.prepare("UPDATE thread_history_projection_state SET next_rollout_byte_offset=100,next_rollout_ordinal=100 WHERE thread_id=?").run(threadId);
    history.prepare("UPDATE thread_history_projection_state SET next_rollout_byte_offset=4 WHERE thread_id=?").run(projectionId);
    assert.equal((await check()).reason, "projection-behind");
    history.prepare("UPDATE thread_history_projection_state SET next_rollout_byte_offset=8 WHERE thread_id=?").run(projectionId);
    history.prepare("UPDATE thread_items SET thread_id=? WHERE thread_id=? AND item_type='agentMessage'").run(threadId, projectionId);
    assert.equal((await check()).reason, "turn-not-durable");
    const mismatch = await inspectThreadHistoryStore({ sqliteHome: root, threadId,
      rolloutPath: join(root, "another.jsonl"), lastOrdinal: 1, turnIds: ["turn"] });
    assert.equal(mismatch.reason, "rollout-path-mismatch");
  } finally { history.close(); }
});

test("[LCH-04] 从未建立的运行环境允许官方首次重建，不完整数据库保持阻塞", async (t) => {
  const root = await useTempDir(t, "codex-history-missing-");
  assert.deepEqual(await resetThreadHistoryProjection({
    sqliteHome: root,
    threadId: "thread",
    backupDirectory: join(root, "backup"),
    label: "pristine",
  }), { reset: false, reason: "missing-history-database", sqliteHome: root });

  createState(join(root, "state_5.sqlite"), join(root, "rollout.jsonl"));
  await assert.rejects(resetThreadHistoryProjection({
    sqliteHome: root,
    threadId: "thread",
    backupDirectory: join(root, "backup"),
    label: "partial",
  }), /数据库不完整/);
});

function createState(path, rolloutPath) {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, title TEXT, history_mode TEXT)");
  db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?)").run("thread", rolloutPath, "保留标题", "paginated");
  db.close();
}

test("[LCH-04] 专用任务的完整官方委托输入可持久化验收，截断或其他回合输出不能替代", async t => {
  const root = await useTempDir(t, "codex-history-delegated-");
  const rolloutPath = join(root, "rollout.jsonl");
  await writeFile(rolloutPath, "one\ntwo\n");
  createState(join(root, "state_5.sqlite"), rolloutPath);
  createHistory(join(root, "thread_history_1.sqlite"), 8, 2, "completed", 1);
  const db = new DatabaseSync(join(root, "thread_history_1.sqlite"));
  try {
    db.exec("DELETE FROM thread_items WHERE thread_id='thread' AND item_type='userMessage'; UPDATE thread_turns SET first_user_item_id=NULL");
    const input = { type: "functionCallOutput", namespace: "codex_app", name: "create_thread",
      output: "<codex_delegation><source_thread_id>parent</source_thread_id><input>执行C</input></codex_delegation>" };
    const check = () => inspectThreadHistoryStore({ sqliteHome: root, threadId: "thread", rolloutPath,
      lastOrdinal: 1, turnIds: ["turn"] });
    db.prepare("INSERT INTO thread_items VALUES (?, ?, ?, ?, ?)").run("thread", "turn", "delegation", "functionCallOutput", JSON.stringify(input));
    assert.equal((await check()).healthy, true);
    db.prepare("UPDATE thread_items SET item_json=? WHERE item_id='delegation'").run(JSON.stringify({ ...input, output: input.output.slice(0, -5) }));
    assert.equal((await check()).healthy, false);
    db.prepare("UPDATE thread_items SET item_json=?, turn_id='another' WHERE item_id='delegation'").run(JSON.stringify(input));
    assert.equal((await check()).healthy, false);
  } finally { db.close(); }
});

function createHistory(path, offset, ordinal, status, endOrdinal) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE thread_history_projection_state (thread_id TEXT PRIMARY KEY, next_rollout_byte_offset INTEGER, next_rollout_ordinal INTEGER);
    CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, status TEXT, rollout_ordinal INTEGER, rollout_end_ordinal INTEGER, first_user_item_id TEXT, final_agent_item_id TEXT);
    CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT, item_type TEXT, item_json TEXT);
    CREATE TABLE thread_realtime_items (thread_id TEXT, value TEXT);
  `);
  db.prepare("INSERT INTO thread_history_projection_state VALUES (?, ?, ?)").run("thread", offset, ordinal);
  db.prepare("INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "thread", "turn", status, 0, endOrdinal, "user-item", "agent-item",
  );
  db.prepare("INSERT INTO thread_items VALUES (?, ?, ?, ?, ?)").run(
    "thread", "turn", "user-item", "userMessage", "target-user",
  );
  db.prepare("INSERT INTO thread_items VALUES (?, ?, ?, ?, ?)").run(
    "thread", "turn", "agent-item", "agentMessage", "target-agent",
  );
  db.prepare("INSERT INTO thread_items VALUES (?, ?, ?, ?, ?)").run(
    "other", "turn", "other-item", "agentMessage", "keep",
  );
  db.close();
}
