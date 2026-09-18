import assert from "node:assert/strict";
import test from "node:test";
import { createHostHealthTracker } from "../src/host-health.mjs";
import { requestCodexAppToolsStatus, requestCodexAppToolsReload, requestCodexAppToolsDiagnostic,
  handleHostToolReloadResponse, closeHostToolChecks } from "../src/app-server-relay/host-tools.mjs";
import { successfulHostToolResult } from "./host-tool-fixtures.mjs";
import { rewriteClientLine } from "../src/app-server-relay/client-messages.mjs";
import { rewriteServerLine } from "../src/app-server-relay/server-messages.mjs";

async function fixture(t) {
  const hostHealth = await createHostHealthTracker({ path: null });
  const sent = [], timers = new Set();
  const state = { hostHealth, pendingRequests: new Map(), sendUpstream: message => sent.push(message),
    setHostToolTimer(fn) { timers.add(fn); return fn; }, clearHostToolTimer(fn) { timers.delete(fn); } };
  t.after(async () => { closeHostToolChecks(state); await hostHealth.close({ disconnected: false }); });
  return { state, sent, timers, ready(threadId) {
    hostHealth.observeStartupStatus({ name: "codex_app", status: "ready", threadId });
    requestCodexAppToolsStatus(state, threadId);
  }, reply(message, result = successfulHostToolResult(message.params?.tool, message.params?.arguments?.threadId), error) {
    const pending = state.pendingRequests.get(message.id);
    state.pendingRequests.delete(message.id);
    handleHostToolReloadResponse({ id: message.id, result, error }, pending, state);
  } };
}

test("[LCH-04 TOOL-04] 四项并发、重复通知合并、通过后复用且不查询目录", async t => {
  const { state, sent, ready, reply } = await fixture(t);
  ready("task");
  ready("task");
  assert.equal(sent.length, 4);
  assert.deepEqual(new Set(sent.map(x => x.params.tool)), new Set(state.hostHealth.requiredTools));
  assert.ok(sent.every(x => x.method === "mcpServer/tool/call" && x.params.threadId === "task"));
  for (const request of sent) reply(request);
  ready("task");
  assert.equal(sent.length, 4);
  assert.equal(state.hostHealth.snapshot("task").toolsVerified, true);
});

test("[LCH-04] 跨任务最多八个请求，已选任务优先且结果互不覆盖", async t => {
  const { state, sent, ready, reply } = await fixture(t);
  for (const id of ["a", "b", "queued", "selected"]) ready(id);
  assert.equal(sent.length, 8);
  requestCodexAppToolsStatus(state, "selected", { priority: true });
  reply(sent[0]);
  assert.equal(sent[8].params.threadId, "selected");
  assert.equal(state.hostHealth.snapshot("a").checks.list_threads.status, "passed");
  assert.equal(state.hostHealth.snapshot("b").checks.list_threads.status, "checking");
});

test("[LCH-04] 超时仅未确认，同代迟到成功恢复，重试只补未通过项", async t => {
  const { state, sent, ready, reply } = await fixture(t);
  ready("task");
  sent.slice(0, 3).forEach(x => reply(x));
  const last = sent[3];
  state.pendingRequests.get(last.id).timer();
  assert.equal(state.hostHealth.snapshot("task").status, "unconfirmed");
  reply(last);
  assert.equal(state.hostHealth.snapshot("task").status, "ready");
  requestCodexAppToolsStatus(state, "task", { retry: true });
  assert.equal(sent.length, 8);
  sent.slice(4, 7).forEach(x => reply(x));
  reply(sent[7], null, { message: "Unauthorized Bearer private-secret" });
  requestCodexAppToolsStatus(state, "task", { retry: true });
  assert.equal(sent.length, 9);
  assert.equal(sent[8].params.tool, "get_usage_limits");
  assert.doesNotMatch(JSON.stringify(state.hostHealth.snapshot()), /private-secret/);
});

test("[LCH-04] 重试后旧响应和重连前响应不能覆盖更新的检查", async t => {
  const { state, sent, ready, reply } = await fixture(t);
  ready("task");
  const first = sent[0];
  state.pendingRequests.get(first.id).timer();
  requestCodexAppToolsStatus(state, "task", { retry: true });
  reply(sent[4], null, { message: "tool missing" });
  reply(first);
  assert.equal(state.hostHealth.snapshot("task").checks.list_threads.status, "failed");
  state.hostHealth.observeStartupStatus({ name: "codex_app", status: "starting", threadId: "task" });
  ready("task");
  sent.slice(1, 4).forEach(x => reply(x));
  assert.equal(state.hostHealth.snapshot("task").toolsVerified, false);
  sent.slice(5).forEach(x => reply(x));
  assert.equal(state.hostHealth.snapshot("task").status, "ready");
});

test("[LCH-04] 配置刷新独立执行，刷新期间就绪任务在响应后四项并发", async t => {
  const { state, sent, ready, reply } = await fixture(t);
  ready("old"); sent.slice().forEach(x => reply(x));
  requestCodexAppToolsReload(state);
  const reload = sent[4];
  assert.equal(reload.method, "config/mcpServer/reload");
  assert.equal(Object.hasOwn(reload, "params"), false);
  ready("new");
  assert.equal(sent.length, 5);
  reply(reload, {});
  assert.equal(sent.length, 9);
  sent.slice(5).forEach(x => reply(x));
  assert.equal(state.hostHealth.snapshot("new").status, "ready");
  assert.notEqual(state.hostHealth.snapshot("old").status, "ready");
});

test("[LCH-04] 深入目录查询按需分页，目录失败不推翻实际通过证据", async t => {
  const { state, sent, ready, reply } = await fixture(t);
  ready("task"); sent.slice().forEach(x => reply(x));
  requestCodexAppToolsDiagnostic(state, "task");
  reply(sent[4], { data: [], nextCursor: "next" });
  assert.equal(sent[5].params.cursor, "next");
  reply(sent[5], null, { message: "timeout" });
  assert.equal(state.hostHealth.snapshot("task").status, "ready");
  assert.equal(state.hostHealth.snapshot("task").diagnostic.status, "unconfirmed");
});

for (const notification of ["before-timeout", "after-timeout"]) {
  test(`[LCH-04] 刷新超时保留就绪通知并继续探针：${notification}`, async t => {
    const { state, sent, ready, reply } = await fixture(t);
    ready("old"); sent.slice().forEach(x => reply(x));
    requestCodexAppToolsReload(state);
    const reload = sent[4];
    if (notification === "before-timeout") ready("new");
    state.pendingRequests.get(reload.id).timer();
    if (notification === "after-timeout") ready("new");
    assert.equal(sent.length, 9, "超时后不依赖刷新响应或再次点击，即可派发四项检查");
    assert.equal(state.hostHealth.snapshot("new").serverStatus, "ready");
    sent.slice(5).forEach(x => reply(x));
    reply(reload, {});
    assert.equal(state.hostHealth.snapshot("new").status, "ready");
    assert.equal(sent.length, 9, "迟到成功不得重复派发或清除证据");
    assert.notEqual(state.hostHealth.snapshot("old").status, "ready");
  });
}

test("[LCH-04] 刷新错误响应不能抹掉本次已经收到的任务就绪证据", async t => {
  const { state, sent, ready, reply } = await fixture(t);
  requestCodexAppToolsReload(state);
  ready("new");
  reply(sent[0], null, { message: "reload response failed" });
  assert.equal(sent.length, 5);
  assert.equal(state.hostHealth.snapshot("new").serverStatus, "ready");
  sent.slice(1).forEach(x => reply(x));
  assert.equal(state.hostHealth.snapshot("new").status, "ready");
});

for (const outcome of ["empty", "missing-tool", "timeout"]) {
  test(`[LCH-04] 首次探针排队期间目录诊断不改变主状态：${outcome}`, async t => {
    const { state, sent, ready, reply } = await fixture(t);
    for (const id of ["a", "b", "queued"]) ready(id);
    assert.equal(sent.length, 8);
    const before = state.hostHealth.snapshot("queued");
    assert.deepEqual(before.checks, {});
    requestCodexAppToolsDiagnostic(state, "queued");
    const diagnostic = sent[8];
    if (outcome === "timeout") state.pendingRequests.get(diagnostic.id).timer();
    else reply(diagnostic, { data: outcome === "empty" ? [] : [{
      name: "codex_app", runtimeStatus: "connected", tools: {},
    }] });
    const after = state.hostHealth.snapshot("queued");
    assert.equal(after.serverStatus, before.serverStatus);
    assert.equal(after.status, before.status);
    assert.equal(after.code, before.code);
    assert.equal(after.diagnostic.status, outcome === "timeout" ? "unconfirmed" : "complete");
    sent.slice(0, 8).forEach(x => reply(x));
    const probes = sent.filter(x => x.params?.threadId === "queued" && x.method === "mcpServer/tool/call");
    assert.equal(probes.length, 4);
    probes.forEach(x => reply(x));
    assert.equal(state.hostHealth.snapshot("queued").status, "ready");
    assert.equal(state.hostHealth.snapshot("queued").toolsVerified, true);
  });
}

test("[LCH-04] 正常工具调用经过同一校验更新对应项，不吞掉客户端响应", async t => {
  const { state, ready } = await fixture(t);
  state.threadContexts = new Map(); state.turnModels = new Map(); state.emitUsageEvent = () => {};
  ready("task");
  const request = { id: 91, method: "mcpServer/tool/call", params: {
    threadId: "task", server: "codex_app", tool: "read_thread", arguments: { threadId: "other" } } };
  assert.equal(rewriteClientLine(JSON.stringify(request), state), JSON.stringify(request));
  const reply = JSON.stringify({ id: 91, result: successfulHostToolResult("read_thread", "other") });
  assert.equal(rewriteServerLine(reply, state), reply);
  assert.equal(state.hostHealth.snapshot("task").checks.read_thread.status, "passed");
  assert.equal(state.hostHealth.snapshot("other").toolsVerified, false);
});

test("[LCH-04] 全局就绪不调用无作用域探针，关闭释放计时器", async t => {
  const { state, sent, ready, timers } = await fixture(t);
  ready(null);
  assert.equal(sent.length, 0);
  ready("task");
  assert.equal(timers.size, 4);
  closeHostToolChecks(state);
  assert.equal(timers.size, 0);
});

test("[LCH-04] 同步发送失败不会重入重复派发，四项均留下失败证据", async t => {
  const { state, ready } = await fixture(t);
  const calls = [];
  state.sendUpstream = message => { calls.push(message); throw new Error("transport disconnected"); };
  ready("task");
  assert.equal(calls.length, 4);
  assert.equal(new Set(calls.map(x => x.params.tool)).size, 4);
  assert.ok(Object.values(state.hostHealth.snapshot("task").checks).every(x => x.status === "failed"));
  assert.equal(state.hostToolScheduler.active.size, 0);
});

test("[LCH-04] 模型正常工具事件只更新对应检查，重连前事件不能恢复旧证据", async t => {
  const { state, ready } = await fixture(t);
  ready("task");
  const started = { method: "item/started", params: { threadId: "task", item: {
    id: "normal-tool", type: "mcpToolCall", server: "codex_app", tool: "read_thread",
    arguments: JSON.stringify({ threadId: "other" }),
  } } };
  state.hostHealth.observeServerMessage(started);
  state.hostHealth.observeServerMessage({ method: "item/completed", params: { threadId: "task", item: {
    ...started.params.item, status: "completed", result: successfulHostToolResult("read_thread", "other"),
  } } });
  assert.equal(state.hostHealth.snapshot("task").checks.read_thread.status, "passed");
  state.hostHealth.observeServerMessage(started);
  state.hostHealth.observeStartupStatus({ name: "codex_app", status: "starting", threadId: "task" });
  state.hostHealth.observeServerMessage({ method: "item/completed", params: { threadId: "task", item: {
    ...started.params.item, status: "completed", result: successfulHostToolResult("read_thread", "other"),
  } } });
  assert.equal(state.hostHealth.snapshot("task").checks.read_thread, undefined);
});
