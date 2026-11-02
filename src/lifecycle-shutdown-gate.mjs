import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

import {
  captureCodexSessionCheckpoint,
  rolloutThreadId,
} from "./lifecycle-turn-gate.mjs";
import {
  inspectThreadHistoryStore,
  locateHistoryDatabases,
} from "./lifecycle-history-store.mjs";

// Track every active turn observed while waiting. A later idle observation is
// only safe after each tracked turn has reached the official SQLite history
// projection, otherwise stopping the desktop can lose the last visible reply.
export async function inspectCodexShutdownReadiness(
  control = {},
  tracked = [],
  dependencies = {},
) {
  const codexHome = control.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const sqliteHome = control.sqliteHome ?? process.env.CODEX_SQLITE_HOME ?? codexHome;
  const capture = dependencies.capture ?? captureCodexSessionCheckpoint;
  const active = (await capture({ codexHome, sqliteHome })).turns;
  const groups = new Map(
    tracked.map((group) => [group.path, { ...group, turnIds: [...group.turnIds] }]),
  );
  for (const turn of active) {
    const group = groups.get(turn.path) ?? {
      path: turn.path,
      threadId: rolloutThreadId(turn.path),
      turnIds: [],
    };
    if (!group.turnIds.includes(turn.turnId)) group.turnIds.push(turn.turnId);
    groups.set(turn.path, group);
  }
  if (control.threadId && groups.size === 0 && !dependencies.capture) {
    const paths = await locateHistoryDatabases(sqliteHome);
    if (paths.state) {
      const db = new DatabaseSync(paths.state, { readOnly: true });
      try {
        const thread = db.prepare("SELECT rollout_path FROM threads WHERE id = ?")
          .get(control.threadId);
        if (thread?.rollout_path) {
          groups.set(thread.rollout_path, {
            path: thread.rollout_path,
            threadId: control.threadId,
            turnIds: [],
          });
        }
      } finally {
        db.close();
      }
    }
  }
  const next = [...groups.values()];
  if (active.length) {
    return {
      ready: false,
      reason: "等待当前任务结束",
      activeTurnCount: active.length,
      tracked: next,
    };
  }
  for (const group of next) {
    const projection = await (dependencies.inspectStore ?? inspectThreadHistoryStore)({
      sqliteHome,
      threadId: group.threadId,
      rolloutPath: group.path,
      turnIds: group.turnIds,
    });
    if (!projection.healthy) {
      return {
        ready: false,
        reason: "等待任务历史投影落盘",
        activeTurnCount: 0,
        tracked: next,
      };
    }
  }
  return { ready: true, activeTurnCount: 0, tracked: next };
}

export async function waitForCodexShutdownReadiness({
  inspect,
  onStatus = () => {},
  timeoutMs = 30 * 60_000,
  pollIntervalMs = 1_000,
  stableObservations = 2,
  timeoutMessage = "等待任务结束或历史落盘超时，拒绝重启 Codex",
  now = Date.now,
  sleep = delay,
  signal,
} = {}) {
  if (typeof inspect !== "function") throw new TypeError("缺少 Codex 关闭前历史检查器");
  if (!Number.isInteger(stableObservations) || stableObservations < 1) {
    throw new TypeError("稳定检查次数必须是正整数");
  }
  const deadline = now() + timeoutMs;
  let tracked = [];
  let stableSignature = null;
  let stableCount = 0;
  while (true) {
    signal?.throwIfAborted();
    const result = await inspect(tracked, { signal });
    signal?.throwIfAborted();
    tracked = Array.isArray(result?.tracked) ? result.tracked : tracked;
    await onStatus({ ...result, tracked });
    if (result?.ready) {
      const signature = JSON.stringify(tracked);
      if (signature === stableSignature) stableCount += 1;
      else {
        stableSignature = signature;
        stableCount = 1;
      }
      if (stableCount >= stableObservations) {
        return { ...result, tracked, stableObservations: stableCount };
      }
    } else {
      stableSignature = null;
      stableCount = 0;
    }
    if (now() >= deadline) throw new Error(timeoutMessage);
    await sleep(pollIntervalMs, undefined, { signal });
  }
}
