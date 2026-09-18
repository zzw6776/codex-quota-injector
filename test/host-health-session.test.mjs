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
  const run = rows => JSON.parse(JSON.stringify(vm.runInNewContext(`(${readVisibleHostTask.toString()})()`, {
    document: { querySelectorAll: () => rows },
  })));
  assert.deepEqual(run([row("a")]), { hostId: "local", threadId: "a" });
  assert.equal(run([row("a"), row("b")]), null);
  assert.equal(run([row("a", "local", "cloud")]), null);
  assert.equal(run([]), null);
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
