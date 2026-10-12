import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { captureCodexSessionCheckpoint, rolloutThreadId } from "../lifecycle-turn-gate.mjs";
import { inspectRolloutHistory } from "../lifecycle-history.mjs";
import { inspectThreadHistoryStore, locateHistoryDatabases } from "../lifecycle-history-store.mjs";

// Keep a record of every active turn seen while downloading/waiting, so an idle
// observation cannot hide a terminal event whose SQLite projection is behind.
export async function inspectUpdateHistory(control, tracked = [], dependencies = {}) {
  const codexHome = control.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const sqliteHome = control.sqliteHome ?? process.env.CODEX_SQLITE_HOME ?? codexHome;
  const capture = dependencies.capture ?? captureCodexSessionCheckpoint;
  const active = (await capture({ codexHome, sqliteHome })).turns;
  const groups = new Map(tracked.map(group => [group.path, { ...group, turnIds: [...group.turnIds] }]));
  for (const turn of active) {
    const group = groups.get(turn.path) ?? { path: turn.path, threadId: rolloutThreadId(turn.path), turnIds: [] };
    if (!group.turnIds.includes(turn.turnId)) group.turnIds.push(turn.turnId);
    groups.set(turn.path, group);
  }
  if (control.threadId && groups.size === 0 && !dependencies.capture) {
    const paths = await locateHistoryDatabases(sqliteHome);
    if (paths.state) {
      const db = new DatabaseSync(paths.state, { readOnly: true });
      try {
        const thread = db.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(control.threadId);
        if (thread?.rollout_path) groups.set(thread.rollout_path, { path: thread.rollout_path, threadId: control.threadId, turnIds: [] });
      } finally { db.close(); }
    }
  }
  const next = [...groups.values()];
  if (active.length) return { ready: false, reason: "等待当前任务结束", tracked: next };
  for (const group of next) {
    const history = await (dependencies.inspectHistory ?? inspectRolloutHistory)(group.path);
    if (history.repairRequired) throw new Error("任务历史结构不完整，更新已停止；未修改历史或关闭 Codex");
    if (history.activeTurn) return { ready: false, reason: "等待任务终态落盘", tracked: next };
    const projection = await (dependencies.inspectStore ?? inspectThreadHistoryStore)({ sqliteHome,
      threadId: group.threadId, rolloutPath: group.path, lastOrdinal: history.lastOrdinal, turnIds: group.turnIds });
    if (!projection.healthy) return { ready: false, reason: "等待任务历史投影落盘", tracked: next };
  }
  return { ready: true, tracked: next };
}

export async function runUpdateHistoryProbe() {
  const path = process.env.CODEX_QUOTA_UPDATE_CONTROL;
  const control = JSON.parse(await readFile(path, "utf8"));
  const tracked = JSON.parse(await readFile(`${path}.history`, "utf8").catch(() => "[]"));
  const result = await inspectUpdateHistory({ ...control, ...control.wslDirectories }, tracked);
  await writeFile(`${path}.history`, JSON.stringify(result.tracked), { mode: 0o600 });
  console.log(JSON.stringify(result));
}
