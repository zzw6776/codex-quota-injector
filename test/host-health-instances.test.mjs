import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createHostHealthTracker, resolveHostHealthInstance, readHostHealthViewModel,
  requestHostToolReload, watchHostToolReloadRequests, watchHostHealthFiles,
  publishHostToolSelection, watchHostToolSelection,
  HOST_TOOL_RELOAD_REQUEST_VERSION } from "../src/host-health.mjs";
import { relayInstancePath } from "../src/relay-instance-paths.mjs";
import { RELAY_STATE_VERSION } from "../src/relay-contract.mjs";
import { isRelayStateCurrent } from "../src/platform.mjs";
import { proveHostTools } from "./host-tool-fixtures.mjs";
import { useTempDir, waitFor } from "./helpers.mjs";

const TEST_SELECTION_TOKEN = {
  selectionSourceId: "test-selection",
  selectionRevision: 1,
};

async function fixture(t) {
  const trackers = [];
  t.after(async () => {
    for (const tracker of trackers) await tracker.close({ disconnected: false });
  });
  const directory = await useTempDir(t, "health-instances-");
  const binding = { statePath: join(directory, "state.json"), healthPath: join(directory, "health.json"),
    generation: "same-launch", hostToolsRequired: true, instanceScoped: true };
  async function instance(threadId) {
    const sessionId = randomUUID();
    const statePath = relayInstancePath(binding.statePath, sessionId);
    const healthPath = relayInstancePath(binding.healthPath, sessionId);
    const identity = { pid: process.pid, processStartedAt: Date.now() - process.uptime() * 1000 };
    await writeFile(statePath, JSON.stringify({ version: RELAY_STATE_VERSION,
      generation: binding.generation, ...identity }));
    const tracker = await createHostHealthTracker({ path: healthPath, sessionId,
      generation: binding.generation, processIdentity: identity });
    trackers.push(tracker);
    if (threadId) {
      tracker.observeServerMessage({ method: "mcpServer/startupStatus/updated",
        params: { threadId, name: "codex_app", status: "ready" } });
      proveHostTools(tracker, threadId);
      await waitFor(async () => JSON.parse(await readFile(healthPath, "utf8")).tasks?.[threadId]?.toolsVerified);
    }
    return { sessionId, statePath, healthPath, tracker };
  }
  return { binding, instance };
}

test("双后台同 generation，空闲 durable 不遮蔽 local 任务，切换任务按归属读取", async t => {
  const { binding, instance } = await fixture(t);
  const local = await instance("local-task");
  const durable = await instance();
  const checker = async () => true;
  let view = await readHostHealthViewModel(binding, { threadId: "local-task", relayStateChecker: checker });
  assert.equal(view.status, "ready");
  assert.equal(view.sessionId, local.sessionId);
  durable.tracker.noteTask("work-task");
  await waitFor(async () => JSON.parse(await readFile(durable.healthPath, "utf8")).tasks?.["work-task"]?.observed);
  view = await readHostHealthViewModel(binding, { threadId: "work-task", relayStateChecker: checker });
  assert.equal(view.sessionId, durable.sessionId);
  assert.equal(view.status, "idle", "仅发现归属时保持被动，进入任务后再启动检查");
  assert.equal(view.toolsVerified, false);
  assert.deepEqual(view.checks, {});
  durable.tracker.observeReloadStarted();
  assert.equal(durable.tracker.ownsTask("work-task"), true, "MCP 重载保留任务归属");
  durable.tracker.observeServerMessage({ method: "thread/closed", params: { threadId: "work-task" } });
  assert.equal(durable.tracker.ownsTask("work-task"), false);
});

test("任务选择使用最新状态快照，快速切换不会回放旧任务且支持显式撤销", async t => {
  const { binding, instance } = await fixture(t);
  const owner = await instance("task-a");
  owner.tracker.noteTask("task-b");
  await waitFor(async () => JSON.parse(await readFile(owner.healthPath, "utf8"))
    .tasks?.["task-b"]?.observed);
  const selections = [];
  const watcher = watchHostToolSelection({ healthPath: owner.healthPath,
    generation: binding.generation, sessionId: owner.sessionId }, {
    debounceMs: 10,
    onSelection: selection => selections.push(selection),
  });
  t.after(() => watcher.close());
  const options = { relayStateChecker: async () => true };
  await publishHostToolSelection(binding, { sourceId: "selection-source", revision: 1,
    threadId: "task-a", sessionId: owner.sessionId }, options);
  await publishHostToolSelection(binding, { sourceId: "selection-source", revision: 2,
    threadId: "task-b", sessionId: owner.sessionId }, options);
  await waitFor(() => selections.at(-1)?.threadId === "task-b");
  assert.equal(selections.some((selection, index) => selection.threadId === "task-a" &&
    selections.slice(index + 1).some(next => next.threadId === "task-b") &&
    selections.at(-1)?.threadId === "task-a"), false);
  await publishHostToolSelection(binding, { sourceId: "selection-source", revision: 3,
    threadId: null, ownerThreadId: "task-b", sessionId: owner.sessionId }, options);
  await waitFor(() => selections.at(-1)?.threadId === null);
  assert.equal(selections.at(-1).revision, 3);
});

test("未确认归属有限等待，冲突归属和旧代际、死亡、身份错配均不借用结果", async t => {
  const { binding, instance } = await fixture(t);
  const first = await instance("task");
  const second = await instance("task");
  const options = { threadId: "task", relayStateChecker: async () => true };
  let view = await readHostHealthViewModel(binding, options);
  assert.equal(view.code, "task-owner-ambiguous");
  assert.equal(view.canCheck, false);
  view = await readHostHealthViewModel(binding, { ...options, threadId: "unknown", waitingSince: 1000, now: 1001 });
  assert.equal(view.status, "starting");
  view = await readHostHealthViewModel(binding, { ...options, threadId: "unknown", waitingSince: 1000, now: 31001 });
  assert.equal(view.status, "unconfirmed");
  assert.equal(view.canCheck, false);
  const selected = await resolveHostHealthInstance(binding, { ...options, relayStateChecker: async path => path === first.statePath });
  assert.equal(selected.instance.sessionId, first.sessionId);
  const original = JSON.parse(await readFile(second.statePath, "utf8"));
  for (const change of [{ generation: "previous-launch" }, { processStartedAt: 1 }, { pid: 1 }]) {
    await writeFile(second.statePath, JSON.stringify({ ...original, ...change }));
    assert.equal((await resolveHostHealthInstance(binding, options)).instance.sessionId, first.sessionId);
  }
});

test("macOS/Windows 原生单后台与双后台请求定向，重连后的旧会话请求拒绝", {
  skip: !["darwin", "win32"].includes(process.platform),
}, async t => {
  const { binding, instance } = await fixture(t);
  const first = await instance("task-a");
  assert.equal(await isRelayStateCurrent(binding.statePath, binding.generation), true);
  const second = await instance("task-b");
  const received = [[], []];
  for (const [i, owner] of [first, second].entries()) {
    const watcher = watchHostToolReloadRequests({ healthPath: owner.healthPath,
      generation: binding.generation, sessionId: owner.sessionId }, {
      onRequest: request => received[i].push(request),
    });
    t.after(() => watcher.close());
  }
  for (const action of ["check", "diagnose", "reload"]) {
    await requestHostToolReload(binding, { action, threadId: "task-a",
      sessionId: first.sessionId, ...TEST_SELECTION_TOKEN });
  }
  await requestHostToolReload(binding, { action: "check", threadId: "task-b",
    sessionId: second.sessionId, ...TEST_SELECTION_TOKEN });
  await waitFor(() => received[0].length === 3 && received[1].length === 1);
  assert.ok(received[0].every(request => request.threadId === "task-a" && request.sessionId === first.sessionId));
  assert.ok(received[1].every(request => request.threadId === "task-b" && request.sessionId === second.sessionId));
  await assert.rejects(requestHostToolReload(binding, { threadId: "task-a",
    sessionId: second.sessionId, ...TEST_SELECTION_TOKEN }), /任务所属后台/);
  await instance("task-a");
  await assert.rejects(requestHostToolReload(binding, { threadId: "task-a",
    sessionId: first.sessionId, ...TEST_SELECTION_TOKEN }), /任务所属后台/);
  await unlink(first.statePath);
  const replacement = await resolveHostHealthInstance(binding, { threadId: "task-a" });
  assert.notEqual(replacement.instance.sessionId, first.sessionId);
  await assert.rejects(requestHostToolReload(binding, { threadId: "task-a",
    sessionId: first.sessionId, ...TEST_SELECTION_TOKEN }), /任务所属后台/);
  // A stale request accidentally copied into the new instance's mailbox is rejected too.
  const rejected = [];
  const owner = replacement.instance;
  const watcher = watchHostToolReloadRequests({ healthPath: owner.healthPath,
    generation: binding.generation, sessionId: owner.sessionId }, { onRequest: x => rejected.push(x) });
  t.after(() => watcher.close());
  const stalePath = `${owner.healthPath}.reload-stale-request.json`;
  await writeFile(stalePath, JSON.stringify({ version: HOST_TOOL_RELOAD_REQUEST_VERSION,
    requestId: "stale-request", generation: binding.generation, sessionId: first.sessionId,
    action: "check", threadId: "task-a", ...TEST_SELECTION_TOKEN }));
  await waitFor(() => readFile(stalePath).then(() => false, error => error.code === "ENOENT"));
  assert.deepEqual(rejected, []);
});

test("状态监听覆盖实例原子替换/删除，忽略临时文件和请求文件", async t => {
  const { binding } = await fixture(t);
  const callbacks = [], changes = [];
  const watcher = watchHostHealthFiles(binding, { debounceMs: 0,
    watchImpl(_directory, _options, callback) { callbacks.push(callback); const emitter = new EventEmitter(); emitter.close = () => {}; return emitter; },
    onChange: () => changes.push(true),
  });
  t.after(() => watcher.close());
  const file = basename(relayInstancePath(binding.healthPath, randomUUID()));
  callbacks[0]("rename", `${file}.tmp`);
  callbacks[0]("rename", `${file}.reload-request.json`);
  assert.equal(changes.length, 0);
  callbacks[0]("rename", file);
  await waitFor(() => changes.length === 1);
  callbacks[0]("rename", file);
  await waitFor(() => changes.length === 2);
});

test("WSL 双后台重检先写目标实例请求，再通知其状态身份；通知失败清除该请求", async t => {
  const { binding, instance } = await fixture(t);
  const first = await instance("task-a");
  const second = await instance("task-b");
  const wslBinding = { ...binding, wslNative: true };
  const notices = [];
  for (const [owner, threadId] of [[first, "task-a"], [second, "task-b"]]) {
    const requestId = `target-wsl-${threadId}`;
    const request = await requestHostToolReload(wslBinding, { action: "check", threadId,
      sessionId: owner.sessionId, requestId, ...TEST_SELECTION_TOKEN }, {
      relayStateChecker: async () => true,
      async signalWslRelay(statePath, generation) {
        notices.push(statePath);
        assert.equal(statePath, owner.statePath);
        assert.equal(generation, binding.generation);
        const body = JSON.parse(await readFile(`${owner.healthPath}.reload-${requestId}.json`, "utf8"));
        assert.equal(body.sessionId, owner.sessionId);
        assert.equal(body.threadId, threadId);
      },
    });
    await unlink(request.path);
  }
  assert.deepEqual(notices, [first.statePath, second.statePath]);
  const failedPath = `${first.healthPath}.reload-failed-wsl-request.json`;
  await assert.rejects(requestHostToolReload(wslBinding, { action: "check", threadId: "task-a",
    sessionId: first.sessionId, requestId: "failed-wsl-request", ...TEST_SELECTION_TOKEN }, {
    relayStateChecker: async () => true,
    signalWslRelay: async () => { throw new Error("signal failed"); },
  }), /signal failed/);
  await assert.rejects(readFile(failedPath), { code: "ENOENT" });
});
