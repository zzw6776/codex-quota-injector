import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { createHostHealthSession } from "../src/injector/host-health-session.mjs";
import { readVisibleHostTask } from "../src/injector/active-task.mjs";

test("任务选择来源为当前可见的官方任务标记，歧义和云任务不借用最近任务", () => {
  const row = (id, host = "local", kind = "local") => ({ getAttribute(name) { return {
    "data-app-action-sidebar-thread-host-id": host,
    "data-app-action-sidebar-thread-id": `${host}:${id}`,
    "data-app-action-sidebar-thread-kind": kind,
  }[name]; } });
  const run = (rows, composerIds = []) => JSON.parse(JSON.stringify(vm.runInNewContext(`(${readVisibleHostTask.toString()})()`, {
    document: { querySelectorAll: selector => selector.includes("sidebar-thread-active") ? rows
      : selector.includes("data-codex-composer-root")
        ? composerIds.map(id => ({ checkVisibility: () => true,
          querySelectorAll: () => [{ getAttribute: () => id }] })) : [] },
  })));
  assert.deepEqual(run([row("a")]), { hostId: "local", threadId: "a" });
  assert.equal(run([row("a"), row("b")]), null);
  assert.equal(run([row("a", "local", "cloud")]), null);
  assert.equal(run([]), null);
});

test("侧栏临时任务 ID 从当前任务编辑区恢复真实 ID，缺失或歧义时不借用", () => {
  const realId = "01a0cc06-6ac8-7951-851e-2b17ef3f79fd";
  const otherId = "01a0cc07-6ac8-7951-851e-2b17ef3f79fd";
  const row = (id, kind = "local") => ({ getAttribute(name) { return {
    "data-app-action-sidebar-thread-host-id": "local",
    "data-app-action-sidebar-thread-id": `local:${id}`,
    "data-app-action-sidebar-thread-kind": kind,
  }[name]; } });
  const run = (rows, composerIds) => JSON.parse(JSON.stringify(vm.runInNewContext(`(${readVisibleHostTask.toString()})()`, {
    document: { querySelectorAll: selector => selector.includes("sidebar-thread-active") ? rows
      : selector.includes("data-codex-composer-root")
        ? composerIds.map(id => ({ checkVisibility: () => true,
          querySelectorAll: () => [{ getAttribute: () => id }] })) : [] },
  })));
  const provisional = row("client-new-thread:temporary");
  assert.deepEqual(run([provisional], [realId]), { hostId: "local", threadId: realId });
  assert.equal(run([provisional], []), null);
  assert.equal(run([provisional], [realId, otherId]), null);
  assert.equal(run([provisional], ["client-new-thread:temporary"]), null);
  assert.equal(run([row(realId), provisional], [realId]), null);
  assert.equal(run([row(realId, "cloud")], [realId]), null);
});

test("切换任务绕过读取缓存，重选只请求复用，远程任务不借用本机结果", async t => {
  let active = { hostId: "local", threadId: "a" };
  const reads = [], requests = [];
  const session = createHostHealthSession({ getLaunchOptions: () => ({ relay: { hostToolsRequired: true } }),
    readActiveTask: async () => active, markWidgetDataDirty() {}, requestWidgetUpdate() {},
    async readViewModel(_binding, { threadId }) { reads.push(threadId); return {
      status: "ready", threadId, sessionId: "runtime", canCheck: true,
    }; },
    async requestCheck(_binding, request) { requests.push(request); },
  });
  t.after(() => session.closeHostHealthWatcher());
  await session.syncHostHealth();
  active = { hostId: "local", threadId: "b" };
  await session.syncHostHealth();
  assert.equal(session.hostHealth.threadId, "b");
  assert.deepEqual(reads, ["a", "b"]);
  assert.ok(requests.every(x => x.action === "select"));
  assert.ok(requests.every(x => x.sessionId === "runtime"));
  active = { hostId: "remote", threadId: "c" };
  await session.syncHostHealth();
  assert.equal(session.hostHealth.canCheck, false);
  assert.equal(session.hostHealth.threadId, null);
  assert.equal(requests.length, 2);
});

test("异步读取期间切换任务，旧任务响应不能覆盖新任务状态", async t => {
  let active = { hostId: "local", threadId: "a" }, resolveOld;
  let started;
  const start = new Promise(resolve => { started = resolve; });
  const session = createHostHealthSession({ getLaunchOptions: () => ({ relay: { hostToolsRequired: true } }),
    readActiveTask: async () => active, markWidgetDataDirty() {}, requestWidgetUpdate() {}, requestCheck: async () => {},
    async readViewModel(_binding, { threadId }) {
      if (threadId === "a") { started(); await new Promise(resolve => { resolveOld = resolve; }); }
      return { threadId, status: "ready", canCheck: true, sessionId: "runtime" };
    },
  });
  t.after(() => session.closeHostHealthWatcher());
  const old = session.syncHostHealth(); await start;
  active = { hostId: "local", threadId: "b" };
  const current = session.syncHostHealth();
  await Promise.resolve(); resolveOld();
  await Promise.all([old, current]);
  assert.equal(session.hostHealth.threadId, "b");
});

test("同一任务重连后选择新后台，发送失败不会提前缓存已选会话", async t => {
  let sessionId = "old", rejectNext = false;
  const requests = [];
  const session = createHostHealthSession({ getLaunchOptions: () => ({ relay: { hostToolsRequired: true } }),
    readActiveTask: async () => ({ hostId: "local", threadId: "task" }),
    markWidgetDataDirty() {}, requestWidgetUpdate() {},
    async readViewModel() { return { status: "ready", threadId: "task", sessionId, canCheck: true }; },
    async requestCheck(_binding, request) {
      requests.push(request);
      if (rejectNext) { rejectNext = false; throw new Error("后台已变化"); }
    },
  });
  t.after(() => session.closeHostHealthWatcher());
  await session.syncHostHealth();
  await session.syncHostHealth({ force: true });
  assert.equal(requests.length, 1);
  sessionId = "replacement"; rejectNext = true;
  await session.syncHostHealth({ force: true });
  assert.equal(session.hostHealth.status, "unconfirmed");
  await session.syncHostHealth({ force: true });
  assert.deepEqual(requests.map(request => request.sessionId), ["old", "replacement", "replacement"]);
  assert.equal(session.hostHealth.sessionId, "replacement");
  assert.equal(session.hostHealth.status, "ready");
});
