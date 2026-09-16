import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { captureCodexSessionCheckpoint, waitForCodexTurnsIdle, rolloutThreadId as threadIdFromPath } from "../src/lifecycle-turn-gate.mjs";
import { inspectRolloutHistory } from "../src/lifecycle-history.mjs";
import { inspectThreadHistoryStore } from "../src/lifecycle-history-store.mjs";

export async function captureMacLifecycleSession({
  codexHome = process.env.CODEX_HOME || join(homedir(), ".codex"),
  sqliteHome = process.env.CODEX_SQLITE_HOME || codexHome,
  threadId = process.env.CODEX_THREAD_ID,
  capture = captureCodexSessionCheckpoint,
} = {}) {
  const sessionCheckpoint = await capture({ codexHome, sqliteHome });
  const turn = sessionCheckpoint.turns.find((entry) => threadIdFromPath(entry.path) === threadId);
  if (!threadId || !turn) throw new Error("BLOCKED：无法绑定发起启停恢复测试的活动任务及回合，未调度关闭操作");
  const session = {
    sessionSafetyVersion: 1,
    codexHome,
    sqliteHome,
    sessionCheckpoint,
    initiatingTurn: { threadId, turnId: turn.turnId, path: turn.path },
  };
  validateMacLifecycleSession(session);
  return session;
}

export function validateMacLifecycleSession(control) {
  const origin = control?.initiatingTurn;
  const turns = control?.sessionCheckpoint?.turns;
  if (control?.sessionSafetyVersion !== 1 || !isAbsolute(control.codexHome ?? "") ||
    !isAbsolute(control.sqliteHome ?? "") || !Array.isArray(turns) || !turns.length ||
    !turns.every((turn) => isAbsolute(turn.path ?? "") && threadIdFromPath(turn.path) &&
      typeof turn.turnId === "string" && turn.turnId.length > 0) ||
    !origin?.threadId || threadIdFromPath(origin.path) !== origin.threadId ||
    !turns.some((turn) => turn.path === origin.path && turn.turnId === origin.turnId)) {
    throw new Error("BLOCKED：macOS C 控制记录缺少有效会话绑定；旧任务不能按固定延时恢复");
  }
}

function groups(control) {
  validateMacLifecycleSession(control);
  const result = new Map();
  for (const turn of control.sessionCheckpoint.turns) {
    const group = result.get(turn.path) ?? {
      path: turn.path, threadId: threadIdFromPath(turn.path), turnIds: [],
    };
    if (!group.turnIds.includes(turn.turnId)) group.turnIds.push(turn.turnId);
    result.set(turn.path, group);
  }
  return [...result.values()];
}

// This gate only reads history. Structural damage is never repaired while the
// desktop is running, nor bypassed merely to complete a lifecycle test.
export async function inspectMacLifecycleHistory(control, {
  allowActive = false,
  inspectHistory = inspectRolloutHistory,
} = {}) {
  const result = [];
  for (const group of groups(control)) {
    const history = await inspectHistory(group.path);
    if (history.repairRequired) {
      throw new Error(`BLOCKED：任务 ${group.threadId} 的历史结构不完整` +
        `（序号异常 ${history.sequenceIssues?.length ?? 0}，缺失终态 ${history.missingTerminalEvents?.length ?? 0}）` +
        "；拒绝关闭或在线修复，必须先独立核对历史证据");
    }
    if (!allowActive && history.activeTurn) {
      throw new Error(`BLOCKED：任务 ${group.threadId} 仍有活动回合，拒绝关闭或推进下一步骤`);
    }
    result.push({ ...group, lastOrdinal: history.lastOrdinal });
  }
  return result;
}

export function createMacLifecycleSessionGuard(control, {
  waitIdle = waitForCodexTurnsIdle,
  inspectHistory = inspectRolloutHistory,
  inspectStore = inspectThreadHistoryStore,
  timeoutMs = 60_000,
  pollIntervalMs = 500,
} = {}) {
  validateMacLifecycleSession(control);
  const durable = async () => {
    const deadline = Date.now() + timeoutMs;
    let latest = [];
    do {
      latest = [];
      for (const group of await inspectMacLifecycleHistory(control, { inspectHistory })) {
        const store = await inspectStore({
          sqliteHome: control.sqliteHome,
          threadId: group.threadId,
          rolloutPath: group.path,
          lastOrdinal: group.lastOrdinal,
          turnIds: group.turnIds,
        });
        latest.push({ threadId: group.threadId, turnIds: group.turnIds,
          healthy: store.healthy, reason: store.reason });
      }
      if (latest.every((entry) => entry.healthy)) return { status: "durable", threads: latest };
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    } while (Date.now() < deadline);
    throw new Error("BLOCKED：macOS 会话分页投影尚未持久化：" +
      latest.map((entry) => `${entry.threadId}:${entry.reason}`).join(", ") +
      "；不启动第二个 app-server，也不推进下一次重启");
  };
  return {
    async before() {
      await waitIdle({ codexHome: control.codexHome, sqliteHome: control.sqliteHome });
      return durable();
    },
    after: durable,
  };
}

export function protectMacLifecycleOperations(operations, guard) {
  return Object.fromEntries(Object.entries(operations).map(([id, operation]) => {
    if (id === "verify-package") return [id, operation];
    const protectedOperation = { ...operation };
    for (const method of ["run", "rollback", "reconcile"]) {
      if (typeof operation[method] !== "function") continue;
      protectedOperation[method] = async (...args) => {
        await guard.before();
        const result = await operation[method](...args);
        if (method === "reconcile" && result?.completed !== true) return result;
        const sessionHistory = await guard.after();
        return method === "reconcile"
          ? { ...result, evidence: { ...result.evidence, sessionHistory } }
          : { ...result, sessionHistory };
      };
    }
    return [id, protectedOperation];
  }));
}
