import { backup, DatabaseSync } from "node:sqlite";
import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export async function inspectThreadHistoryStore({
  sqliteHome,
  threadId,
  rolloutPath,
  lastOrdinal,
  turnIds = [],
} = {}) {
  const paths = await locateHistoryDatabases(sqliteHome);
  if (!paths.state || !paths.history) {
    return { healthy: false, reason: "missing-history-database", sqliteHome, paths };
  }
  const state = new DatabaseSync(paths.state, { readOnly: true });
  const history = new DatabaseSync(paths.history, { readOnly: true });
  try {
    const thread = state.prepare(
      "SELECT id, rollout_path, title, history_mode FROM threads WHERE id = ?",
    ).get(threadId);
    const projection = history.prepare(
      "SELECT next_rollout_byte_offset, next_rollout_ordinal FROM thread_history_projection_state WHERE thread_id = ?",
    ).get(threadId);
    const item = history.prepare(
      "SELECT item_type FROM thread_items WHERE thread_id = ? AND turn_id = ? AND item_id = ?",
    );
    const turns = turnIds.map((turnId) => {
      const turn = history.prepare(
        `SELECT turn_id, status, rollout_ordinal, rollout_end_ordinal,
          first_user_item_id, final_agent_item_id
        FROM thread_turns WHERE thread_id = ? AND turn_id = ?`,
      ).get(threadId, turnId) ?? { turn_id: turnId, status: "missing" };
      const firstUserItem = turn.first_user_item_id
        ? item.get(threadId, turnId, turn.first_user_item_id)
        : null;
      const finalAgentItem = turn.final_agent_item_id
        ? item.get(threadId, turnId, turn.final_agent_item_id)
        : null;
      return {
        ...turn,
        first_user_item_present: firstUserItem?.item_type === "userMessage",
        final_agent_item_present: finalAgentItem?.item_type === "agentMessage",
      };
    });
    const rollout = await stat(rolloutPath).catch(() => null);
    const pathMatches = Boolean(thread?.rollout_path) &&
      normalizePath(thread.rollout_path) === normalizePath(rolloutPath);
    const projectionCaughtUp = Boolean(projection && rollout) &&
      Number(projection.next_rollout_byte_offset) >= rollout.size &&
      Number(projection.next_rollout_ordinal) >= Number(lastOrdinal) + 1;
    const turnsDurable = turns.every((turn) =>
      ["completed", "interrupted"].includes(String(turn.status)) &&
      turn.rollout_end_ordinal != null && turn.first_user_item_present &&
      (turn.status === "interrupted" || turn.final_agent_item_present)
    );
    return {
      healthy: Boolean(thread) && pathMatches && projectionCaughtUp && turnsDurable,
      reason: !thread ? "missing-thread" : !pathMatches ? "rollout-path-mismatch"
        : !projectionCaughtUp ? "projection-behind" : !turnsDurable ? "turn-not-durable" : null,
      sqliteHome,
      paths,
      thread: thread ? {
        id: thread.id,
        title: thread.title,
        historyMode: thread.history_mode,
        rolloutPath: thread.rollout_path,
      } : null,
      projection: projection ? {
        nextRolloutByteOffset: Number(projection.next_rollout_byte_offset),
        nextRolloutOrdinal: Number(projection.next_rollout_ordinal),
      } : null,
      rolloutSize: rollout?.size ?? null,
      lastOrdinal,
      turns: turns.map((turn) => ({
        turnId: turn.turn_id,
        status: turn.status,
        rolloutOrdinal: turn.rollout_ordinal == null ? null : Number(turn.rollout_ordinal),
        rolloutEndOrdinal: turn.rollout_end_ordinal == null ? null : Number(turn.rollout_end_ordinal),
        firstUserItemPresent: turn.first_user_item_present,
        finalAgentItemPresent: turn.final_agent_item_present,
      })),
    };
  } finally {
    history.close();
    state.close();
  }
}

export async function resetThreadHistoryProjection({
  sqliteHome,
  threadId,
  backupDirectory,
  label,
} = {}) {
  const paths = await locateHistoryDatabases(sqliteHome);
  if (!paths.state && !paths.history) {
    return { reset: false, reason: "missing-history-database", sqliteHome };
  }
  if (!paths.state || !paths.history) {
    throw new Error(`Codex 历史数据库不完整，拒绝修改：${sqliteHome}`);
  }
  await mkdir(backupDirectory, { recursive: true });
  const safeLabel = String(label ?? "history").replace(/[^a-zA-Z0-9_.-]/g, "_");
  const stateBackup = join(backupDirectory, `${safeLabel}-${paths.state.split(/[\\/]/).pop()}`);
  const historyBackup = join(backupDirectory, `${safeLabel}-${paths.history.split(/[\\/]/).pop()}`);
  const state = new DatabaseSync(paths.state, { readOnly: true });
  const history = new DatabaseSync(paths.history);
  try {
    const thread = state.prepare("SELECT id, title, history_mode FROM threads WHERE id = ?").get(threadId);
    if (!thread) return { reset: false, reason: "missing-thread", sqliteHome };
    await backup(state, stateBackup);
    await backup(history, historyBackup);
    history.exec("BEGIN IMMEDIATE");
    try {
      for (const table of ["thread_realtime_items", "thread_items", "thread_turns",
        "thread_history_projection_state"]) {
        history.prepare(`DELETE FROM ${table} WHERE thread_id = ?`).run(threadId);
      }
      history.exec("COMMIT");
    } catch (error) {
      history.exec("ROLLBACK");
      throw error;
    }
    return {
      reset: true,
      sqliteHome,
      thread: { id: thread.id, title: thread.title, historyMode: thread.history_mode },
      backups: { state: stateBackup, history: historyBackup },
    };
  } finally {
    history.close();
    state.close();
  }
}

export async function locateHistoryDatabases(sqliteHome) {
  const entries = await readdir(sqliteHome).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  return {
    state: latestVersioned(entries, "state") ? join(sqliteHome, latestVersioned(entries, "state")) : null,
    history: latestVersioned(entries, "thread_history")
      ? join(sqliteHome, latestVersioned(entries, "thread_history")) : null,
  };
}

function latestVersioned(entries, prefix) {
  return entries
    .map((name) => ({ name, match: name.match(new RegExp(`^${prefix}_(\\d+)\\.sqlite$`)) }))
    .filter((entry) => entry.match)
    .sort((a, b) => Number(b.match[1]) - Number(a.match[1]))[0]?.name ?? null;
}

function normalizePath(value) {
  return String(value ?? "")
    .replace(/^\\\\\?\\/, "")
    .replaceAll("\\", "/")
    .replace(/\/$/, "")
    .toLowerCase();
}
