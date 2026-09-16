import { dirname, join } from "node:path";
import { commitRolloutHistoryRepair, inspectRolloutHistory, prepareRolloutHistoryRepair } from "../../src/lifecycle-history.mjs";
import { inspectLifecycleHost } from "../../src/lifecycle-host.mjs";
import { waitForCodexTurnsIdle } from "../../src/lifecycle-turn-gate.mjs";
import { stopCodex } from "../../src/platform.mjs";
import { WINDOWS_NATIVE, WSL_NATIVE } from "../test-runtime-targets.mjs";
import { delay } from "./io.mjs";
import { requestWindowsRuntimeHistoryRebuild } from "./history-rebuild.mjs";
import { runWindowsHistoryStoreRequest } from "./wsl-history-store.mjs";
import { stopWindowsInjectorOwners } from "./process-ownership.mjs";

async function safeguardWindowsDesktopHistory(control, {
  updateControl = async () => undefined,
  waitForDesktopIdle = () => waitForCodexTurnsIdle({ codexHome: control.codexHome }),
  inspectHistory = inspectRolloutHistory,
  runStoreRequest = (runtimeTarget, request) =>
    runWindowsHistoryStoreRequest(control, runtimeTarget, request),
  stopInjectorOwners = stopWindowsInjectorOwners,
  stopDesktop = stopCodex,
  inspectHost = inspectLifecycleHost,
  prepareRepair = prepareRolloutHistoryRepair,
  commitRepair = commitRolloutHistoryRepair,
} = {}) {
  const groups = checkpointGroups(control.sessionCheckpoint);
  if (groups.length === 0) {
    const evidence = { status: "not-applicable", capturedTurns: 0, repairs: [] };
    await updateControl({ desktopHistory: evidence });
    return evidence;
  }
  await waitForDesktopIdle();
  const currentRuntime = control.runtimeConfiguration?.originalRuntime ?? control.sourceRecoveryMode;
  const inspected = [];
  for (const group of groups) {
    const history = await inspectHistory(group.path);
    if (history.activeTurn) throw new Error(`Codex 任务 ${group.threadId} 仍有活动回合，拒绝关闭桌面应用`);
    const projection = await runStoreRequest(currentRuntime, {
      operation: "inspect",
      threadId: group.threadId,
      rolloutPath: group.path,
      lastOrdinal: history.lastOrdinal,
      turnIds: group.turnIds,
    });
    inspected.push({ group, history, projection });
  }
  const repairTargets = inspected.filter(({ history, projection }) =>
    history.repairRequired || !projection.healthy
  );
  for (const { group, history, projection } of repairTargets) {
    if (history.repairRequired && !history.repairable) {
      throw new Error(`Codex 任务 ${group.threadId} 的历史损坏无法安全自动修复`);
    }
    if (!history.repairRequired &&
      !["projection-behind", "turn-not-durable", "missing-thread"].includes(projection.reason)) {
      throw new Error(
        `Codex 任务 ${group.threadId} 的分页投影异常无法安全自动修复：${projection.reason}`,
      );
    }
  }
  const repairs = [];
  if (repairTargets.length > 0) {
    await stopInjectorOwners();
    await stopDesktop();
    for (const { group, history, projection } of repairTargets) {
      const prepared = history.repairRequired
        ? await prepareRepair({
            path: group.path,
            runDirectory: dirname(control.reportPath),
            expectedSha256: history.sha256,
            expectedSize: history.size,
          })
        : null;
      const stores = [];
      for (const runtimeTarget of [WINDOWS_NATIVE, WSL_NATIVE]) {
        stores.push(await runStoreRequest(runtimeTarget, {
          operation: "reset",
          threadId: group.threadId,
          backupDirectory: join(dirname(control.reportPath), "history-database-backups"),
          label: runtimeTarget,
        }));
      }
      const committed = prepared ? await commitRepair(prepared) : null;
      repairs.push({
        threadId: group.threadId,
        reason: history.repairRequired ? "rollout-and-projection" : projection.reason,
        sourceSha256: history.sha256,
        repairedSha256: committed?.after.sha256 ?? history.sha256,
        sequenceIssues: history.sequenceIssues.length,
        insertedTerminalEvents: committed?.manifest.insertedTerminalEvents.length ?? 0,
        conversationRecords: committed?.after.conversationRecordCount ??
          history.conversationRecordCount,
        backupPath: committed?.backupPath ?? null,
        displacedPath: committed?.displacedPath ?? null,
        stores,
      });
    }
  }
  const host = await inspectHost({
    installedApp: control.installedApp,
    expectedProtocol: control.expectedProtocol,
  });
  let currentProjection = null;
  if (host.codexPids.length > 0 && repairs.length === 0) {
    currentProjection = {
      status: "durable",
      runtimeTarget: currentRuntime,
      threads: inspected.map(({ projection }) => publicHistoryStoreEvidence(projection)),
    };
  }
  const evidence = {
    status: repairs.length > 0 ? "repaired-awaiting-rebuild" : "durable",
    capturedTurns: groups.reduce((count, group) => count + group.turnIds.length, 0),
    repairs,
    currentProjection,
  };
  await updateControl({ desktopHistory: evidence });
  return evidence;
}

async function prepareWindowsHistoryBeforeLaunch(control, runtimeTarget, {
  requestRebuild = requestWindowsRuntimeHistoryRebuild,
  inspectHistory = inspectRolloutHistory,
  runStoreRequest = (target, request) => runWindowsHistoryStoreRequest(control, target, request),
  inspectHost = inspectLifecycleHost,
  waitForDurable = waitForWindowsHistoryDurable,
} = {}) {
  const groups = checkpointGroups(control.sessionCheckpoint);
  if (groups.length === 0) {
    return { status: "not-applicable", runtimeTarget, rebuild: null, threads: [] };
  }
  const host = await inspectHost({
    installedApp: control.installedApp,
    expectedProtocol: control.expectedProtocol,
  });
  if ((host.codexPids ?? []).length > 0 || (host.appServerPids ?? []).length > 0) {
    throw new Error("Codex 桌面或 app-server 仍在运行，拒绝并发启动历史重建 app-server");
  }
  const latest = [];
  for (const group of groups) {
    const rollout = await inspectHistory(group.path);
    if (rollout.repairRequired || rollout.activeTurn) {
      throw new Error(`Codex 任务 ${group.threadId} 的 rollout 在启动前仍不完整`);
    }
    latest.push(await runStoreRequest(runtimeTarget, {
      operation: "inspect",
      threadId: group.threadId,
      rolloutPath: group.path,
      lastOrdinal: rollout.lastOrdinal,
      turnIds: group.turnIds,
    }));
  }
  if (latest.every((entry) => entry.healthy)) {
    return {
      status: "durable",
      runtimeTarget,
      rebuild: null,
      threads: latest.map(publicHistoryStoreEvidence),
    };
  }
  for (const entry of latest.filter((candidate) => !candidate.healthy)) {
    const missingBothDatabases = entry.reason === "missing-history-database" &&
      !entry.paths?.state && !entry.paths?.history;
    if (!missingBothDatabases &&
      !["projection-behind", "turn-not-durable", "missing-thread"].includes(entry.reason)) {
      throw new Error(
        `Codex ${runtimeTarget} 分页投影异常无法安全自动重建：${entry.reason}`,
      );
    }
  }
  const rebuild = await requestRebuild(
    control,
    runtimeTarget,
    groups.map((group) => group.threadId),
  );
  const durable = await waitForDurable(control, runtimeTarget, {
    inspectHistory,
    runStoreRequest,
  });
  return { ...durable, rebuild };
}

async function waitForWindowsHistoryDurable(control, runtimeTarget, {
  timeoutMs = 60_000,
  pollIntervalMs = 500,
  inspectHistory = inspectRolloutHistory,
  runStoreRequest = (target, request) => runWindowsHistoryStoreRequest(control, target, request),
} = {}) {
  const groups = checkpointGroups(control.sessionCheckpoint);
  if (groups.length === 0) return { status: "not-applicable", runtimeTarget, threads: [] };
  const deadline = Date.now() + timeoutMs;
  let latest = [];
  while (Date.now() < deadline) {
    latest = [];
    for (const group of groups) {
      const rollout = await inspectHistory(group.path);
      if (rollout.repairRequired || rollout.activeTurn) {
        throw new Error(`Codex 任务 ${group.threadId} 的 rollout 在重启后仍不完整`);
      }
      latest.push(await runStoreRequest(runtimeTarget, {
        operation: "inspect",
        threadId: group.threadId,
        rolloutPath: group.path,
        lastOrdinal: rollout.lastOrdinal,
        turnIds: group.turnIds,
      }));
    }
    if (latest.every((entry) => entry.healthy)) {
      return {
        status: "durable",
        runtimeTarget,
        rebuild: null,
        threads: latest.map(publicHistoryStoreEvidence),
      };
    }
    await delay(pollIntervalMs);
  }
  throw new Error(
    `Codex ${runtimeTarget} 会话历史未在超时内完成分页持久化：` +
    latest.map((entry) => `${entry.thread?.id ?? "unknown"}:${entry.reason}`).join(", ") +
    "；桌面启动后只允许只读检查，拒绝并发启动第二个 app-server",
  );
}

function checkpointGroups(checkpoint) {
  const groups = new Map();
  for (const turn of checkpoint?.turns ?? []) {
    const threadId = threadIdFromRolloutPath(turn.path);
    if (!threadId || !turn.turnId) throw new Error("Codex 会话检查点缺少任务或回合 ID");
    const group = groups.get(turn.path) ?? { path: turn.path, threadId, turnIds: [] };
    group.turnIds.push(turn.turnId);
    groups.set(turn.path, group);
  }
  return [...groups.values()];
}

function threadIdFromRolloutPath(path) {
  return String(path ?? "").match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i)?.[1] ?? null;
}

function publicHistoryStoreEvidence(entry) {
  return {
    threadId: entry.thread?.id ?? null,
    historyMode: entry.thread?.historyMode ?? null,
    nextRolloutOrdinal: entry.projection?.nextRolloutOrdinal ?? null,
    rolloutSize: entry.rolloutSize,
    turns: entry.turns,
  };
}

export { safeguardWindowsDesktopHistory, prepareWindowsHistoryBeforeLaunch, waitForWindowsHistoryDurable };
