import assert from "node:assert/strict";
import test from "node:test";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  analyzeRolloutRecords,
  commitRolloutHistoryRepair,
  inspectRolloutHistory,
  prepareRolloutHistoryRepair,
  repairRolloutRecords,
} from "../src/lifecycle-history.mjs";
import { useTempDir } from "./helpers.mjs";

const event = (ordinal, type, turnId, extra = {}) => ({
  timestamp: `2026-09-13T11:00:${String(ordinal).padStart(2, "0")}.000Z`,
  ordinal,
  type: "event_msg",
  payload: { type, turn_id: turnId, ...extra },
});

test("[C LCH-04] 检出重启造成的重复 ordinal 和未终止回合", () => {
  const records = [
    event(0, "task_started", "interrupted", { started_at: 100 }),
    event(1, "token_count"),
    event(1, "thread_settings_applied"),
    event(2, "task_started", "next", { started_at: 120 }),
    event(3, "task_complete", "next"),
  ];
  const result = analyzeRolloutRecords(records);
  assert.deepEqual(result.sequenceIssues.map(({ expected, actual }) => ({ expected, actual })), [
    { expected: 2, actual: 1 },
  ]);
  assert.deepEqual(result.missingTerminalEvents.map(({ abortedTurnId, beforeTurnId }) => ({
    abortedTurnId,
    beforeTurnId,
  })), [{ abortedTurnId: "interrupted", beforeTurnId: "next" }]);
  assert.equal(result.repairRequired, true);
  assert.equal(result.repairable, true);
});

test("[C LCH-04] 修复保留对话内容并补齐中断边界和连续 ordinal", () => {
  const userItem = {
    ordinal: 1,
    type: "event_msg",
    payload: { type: "item_completed", item: { type: "UserMessage", id: "user", content: [{ type: "text", text: "不能丢" }] } },
  };
  const agentItem = {
    ordinal: 3,
    type: "event_msg",
    payload: { type: "item_completed", item: { type: "AgentMessage", id: "agent", content: [{ type: "Text", text: "已保留" }] } },
  };
  const records = [
    event(0, "task_started", "interrupted", { started_at: 100 }),
    userItem,
    event(2, "token_count"),
    event(2, "thread_settings_applied"),
    event(3, "task_started", "next", { started_at: 120 }),
    agentItem,
    event(4, "task_complete", "next"),
  ];
  const before = analyzeRolloutRecords(records);
  const repaired = repairRolloutRecords(records);
  const after = analyzeRolloutRecords(repaired.records);
  assert.deepEqual(repaired.records.map((record) => record.ordinal), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(repaired.manifest.insertedTerminalEvents.map(({ abortedTurnId, beforeTurnId }) => ({
    abortedTurnId,
    beforeTurnId,
  })), [{ abortedTurnId: "interrupted", beforeTurnId: "next" }]);
  assert.equal(after.repairRequired, false);
  assert.equal(after.activeTurn, null);
  assert.equal(after.conversationDigest, before.conversationDigest);
  assert.equal(after.conversationRecordCount, 2);
});

test("[C LCH-04] 文件修复先备份再原子替换并保留替换前现场", async (t) => {
  const directory = await useTempDir(t, "codex-rollout-repair-");
  const rolloutPath = join(directory, "rollout-01a0966e-380a-7692-a939-0a3beeb054a5.jsonl");
  const records = [
    event(0, "task_started", "interrupted", { started_at: 100 }),
    event(1, "token_count", "interrupted"),
    event(1, "thread_settings_applied", "interrupted"),
    event(2, "task_started", "next", { started_at: 120 }),
    event(3, "task_complete", "next"),
  ];
  const original = `${records.map((value) => JSON.stringify(value)).join("\n")}\n`;
  await writeFile(rolloutPath, original);
  const before = await inspectRolloutHistory(rolloutPath);
  const prepared = await prepareRolloutHistoryRepair({
    path: rolloutPath,
    runDirectory: directory,
    expectedSha256: before.sha256,
    expectedSize: before.size,
  });
  const committed = await commitRolloutHistoryRepair(prepared);
  const after = await inspectRolloutHistory(rolloutPath);
  assert.equal(after.repairRequired, false);
  assert.equal(after.activeTurn, null);
  assert.equal(after.conversationDigest, before.conversationDigest);
  assert.equal(await readFile(committed.backupPath, "utf8"), original);
  assert.equal(await readFile(committed.displacedPath, "utf8"), original);
  await access(committed.stagingPath).then(
    () => assert.fail("修复暂存文件应已原子移动"),
    (error) => assert.equal(error.code, "ENOENT"),
  );
});

test("[C LCH-04] 无法证明 ordinal 的记录拒绝自动修复", () => {
  const result = analyzeRolloutRecords([{ type: "session_meta", payload: {} }]);
  assert.equal(result.repairRequired, true);
  assert.equal(result.repairable, false);
  assert.equal(result.invalidOrdinalRecords.length, 1);
});

test("[C LCH-04] ordinal 缺口可能代表记录丢失，不能用重新编号掩盖", () => {
  const result = analyzeRolloutRecords([
    event(0, "task_started", "turn", { started_at: 100 }),
    event(2, "task_complete", "turn"),
  ]);
  assert.equal(result.repairRequired, true);
  assert.equal(result.sequenceIssues[0].kind, "unknown");
  assert.equal(result.repairable, false);
});
