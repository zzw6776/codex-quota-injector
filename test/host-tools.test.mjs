import assert from "node:assert/strict";
import test from "node:test";
import { createHostHealthTracker } from "../src/host-health.mjs";
import { requestCodexAppToolsStatus, requestCodexAppToolsReload,
  handleHostToolReloadResponse } from "../src/app-server-relay/host-tools.mjs";

const catalog = { data: [{ name: "codex_app", runtimeStatus: "connected",
  tools: Object.fromEntries(["list_threads", "read_thread", "list_projects", "get_usage_limits"]
    .map(name => [name, { name }])) }] };

async function fixture(t) {
  const hostHealth = await createHostHealthTracker({ path: null });
  const sent = [];
  const state = { hostHealth, pendingRequests: new Map(), sendUpstream: message => sent.push(message) };
  t.after(async () => { clearTimeout(state.hostToolReloadTimer); await hostHealth.close({ disconnected: false }); });
  return { state, sent, ready(threadId) {
    hostHealth.observeStartupStatus({ name: "codex_app", status: "ready", threadId });
    requestCodexAppToolsStatus(state, threadId);
  }, reply(message, result = catalog, error) {
    const pending = state.pendingRequests.get(message.id);
    state.pendingRequests.delete(message.id);
    handleHostToolReloadResponse({ id: message.id, result, error }, pending, state);
  } };
}

test("[LCH-04 TOOL-04] 交错就绪的任务逐个核验，重复通知合并且不会增加轮询", async t => {
  const { state, sent, ready, reply } = await fixture(t);
  ready("initiating");
  ready("other");
  ready("other");
  ready("initiating");
  assert.equal(sent.length, 1);
  reply(sent[0]);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].params.threadId, "other");
  reply(sent[1]);
  assert.equal(sent.length, 2);
  assert.equal(state.hostHealth.snapshot("initiating").status, "ready");
  assert.equal(state.hostHealth.snapshot("other").status, "ready");
  ready("third");
  assert.equal(sent.length, 3, "已就绪的其他任务不能阻止新任务核验");
  const missing = structuredClone(catalog);
  delete missing.data[0].tools.read_thread;
  reply(sent[2], missing);
  assert.equal(state.hostHealth.snapshot("third").code, "required-tool-missing");
  assert.equal(state.hostHealth.snapshot("initiating").status, "ready");
  assert.equal(state.hostToolReloadTimer, null);
});

test("[LCH-04 TOOL-04] 旧查询响应不能让重启中的任务通过，新启动仍会核验", async t => {
  const { state, sent, ready, reply } = await fixture(t);
  ready("task");
  state.hostHealth.observeStartupStatus({ name: "codex_app", status: "starting", threadId: "task" });
  ready("task");
  reply(sent[0]);
  assert.equal(state.hostHealth.snapshot("task").toolsVerified, false);
  assert.equal(sent.length, 2);
  reply(sent[1]);
  assert.equal(state.hostHealth.snapshot("task").status, "ready");
});

test("[LCH-04 TOOL-04] 查询失败不丢掉另一任务，真实启动失败也不能被旧目录掩盖", async t => {
  const { state, sent, ready, reply } = await fixture(t);
  ready("failed-query");
  ready("failed-start");
  reply(sent[0], null, { message: "unavailable" });
  assert.equal(state.hostHealth.snapshot("failed-query").code, "status-query-failed");
  assert.equal(sent.length, 2);
  state.hostHealth.observeStartupStatus({ name: "codex_app", status: "failed", threadId: "failed-start" });
  reply(sent[1]);
  assert.equal(state.hostHealth.snapshot("failed-start").status, "degraded");
  assert.equal(state.hostHealth.snapshot("failed-start").toolsVerified, false);
});

test("[LCH-04 TOOL-04] 全局重载后不能继承旧任务证明，重载期间的新就绪通知会继续核验", async t => {
  const { state, sent, ready, reply } = await fixture(t);
  ready("old");
  reply(sent[0]);
  requestCodexAppToolsReload(state);
  assert.notEqual(state.hostHealth.snapshot("old").status, "ready");
  ready("new");
  reply(sent[1], {});
  assert.equal(sent[2].method, "mcpServerStatus/list");
  assert.deepEqual(sent[2].params, {});
  reply(sent[2]);
  assert.equal(sent[3].params.threadId, "new");
  reply(sent[3]);
  assert.equal(state.hostHealth.snapshot("new").status, "ready");
  assert.notEqual(state.hostHealth.snapshot("old").status, "ready");
});
