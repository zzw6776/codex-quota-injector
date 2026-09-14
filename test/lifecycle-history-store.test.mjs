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

test("[C LCH-04] 分页投影必须追平 rollout 且包含发起回合", async (t) => {
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

test("[C LCH-04] 重建只清空目标任务投影并保留状态元数据", async (t) => {
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

test("[C LCH-04] 从未建立的运行环境允许官方首次重建，不完整数据库保持阻塞", async (t) => {
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

function createHistory(path, offset, ordinal, status, endOrdinal) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE thread_history_projection_state (thread_id TEXT PRIMARY KEY, next_rollout_byte_offset INTEGER, next_rollout_ordinal INTEGER);
    CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, status TEXT, rollout_ordinal INTEGER, rollout_end_ordinal INTEGER, first_user_item_id TEXT, final_agent_item_id TEXT);
    CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT, item_type TEXT, value TEXT);
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
