import assert from "node:assert/strict";
import test from "node:test";
import { createWidgetSession } from "../src/injector/widget-session.mjs";
import * as widget from "../src/widget.mjs";

function fixture() {
  const calls = [];
  const sent = [];
  const state = {
    network: { status: "stable", latencyMs: 100, sampledAt: 1 },
    account: { id: "one", email: "fixture@example.test", current: true },
    models: { platforms: [] },
    usage: { status: "ready", turns: [{ turnId: "a", totalTokens: 100, updatedAt: 1 }] },
    stopped: false,
  };
  const page = {
    version: widget.WIDGET_RUNTIME_VERSION,
    dataRevision: null,
    update(data, revision = null) {
      if (revision != null && revision === this.dataRevision) return;
      this.dataRevision = revision;
      calls.push(["view", data, revision]);
    },
    updateNetwork: (...args) => calls.push(["network", ...args]),
    updateExtraModels: (...args) => calls.push(["models", ...args]),
    updateTokenUsageDelta: (...args) => calls.push(["usage", ...args]),
  };
  const window = { __codexQuotaWidget: page };
  const runtime = { ...widget, widgetInstallExpression: () => "installWidget()" };
  const cdp = { isConnected: true, async evaluate(expression) {
    sent.push(expression);
    await state.beforeEvaluate?.(expression);
    return Function("window", "installWidget", `return (${expression})`)(window, () => {
      window.__codexQuotaWidget = page;
      page.version = widget.WIDGET_RUNTIME_VERSION;
      return page.version;
    });
  } };
  state.cdp = cdp;
  const session = createWidgetSession({
    get cdp() { return state.cdp; },
    get stopped() { return state.stopped; },
    widget: runtime, appDisplayVersion: "fixture", injectionMode: "macos",
    accountManager: { getViewModel: () => ({ accounts: [state.account], windows: [] }) },
    contextManager: { getViewModel: () => ({ models: [] }) },
    extraModelManager: { getViewModel: () => state.models },
    modelRouterManager: { getNetworkViewModel: () => state.network },
    tokenUsageManager: { getViewModel: () => state.usage },
    wakeupManager: { getViewModel: () => null },
  });
  return { session, state, calls, sent, page, window, cdp, async push() {
    session.markWidgetDataDirty();
    return session.requestWidgetUpdate();
  } };
}

test("网络采样只发送小包，不重传或序列化未变化的回合", async () => {
  const f = fixture();
  let serializations = 0;
  f.state.usage.turns[0].toJSON = function () {
    serializations++;
    return { turnId: this.turnId, totalTokens: this.totalTokens, history: "x".repeat(50_000) };
  };
  await f.push();
  assert.ok(f.calls[0][1].tokenUsage.turns.length);
  const before = serializations;
  f.calls.length = 0;
  f.sent.length = 0;
  f.state.network = { ...f.state.network, latencyMs: 250, sampledAt: 2 };
  await f.push();
  assert.deepEqual(f.calls, [["network", f.state.network]]);
  assert.equal(serializations, before, "网络采样不应扫描历史明细");
  assert.ok(f.sent[0].length < 400, "小包不携带历史");
  f.calls.length = 0;
  f.sent.length = 0;
  await f.push();
  assert.deepEqual(f.calls, [], "无变化时不发送页面更新");
  assert.deepEqual(f.sent, []);
});

test("账号、网络与用量同时变化只用一次 CDP 往返，重连恢复完整快照", async () => {
  const f = fixture();
  await f.push();
  f.calls.length = 0;
  f.sent.length = 0;
  f.state.account = { ...f.state.account, quotaUpdatedAt: 2 };
  f.state.network = { ...f.state.network, sampledAt: 2 };
  f.state.usage = { status: "ready", turns: [{ turnId: "b", totalTokens: 200, updatedAt: 2 }] };
  await f.push();
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.calls.map(([name]) => name), ["view", "network", "usage"]);
  assert.equal(Object.hasOwn(f.calls[0][1], "tokenUsage"), false);
  assert.equal(Object.hasOwn(f.calls[0][1], "network"), false);
  assert.deepEqual(f.calls[2][1].removedTurnIds, ["a"]);
  assert.deepEqual(f.calls[2][1].updates, f.state.usage.turns);
  f.calls.length = 0;
  f.session.reset();
  await f.session.requestWidgetUpdate();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0][1].tokenUsage, f.state.usage);
  assert.deepEqual(f.calls[0][1].network, f.state.network);
});

test("只更新模型检测时保留模型专用通道", async () => {
  const f = fixture();
  await f.push();
  f.calls.length = 0;
  f.state.models = { platforms: [], operation: { state: "loading", step: 2 } };
  await f.push();
  assert.deepEqual(f.calls.map(([name]) => name), ["models"]);
  assert.deepEqual(f.calls[0][1], f.state.models);
});

test("新会话首次快照不会与幸存页面的旧 revision 冲突", async () => {
  const f = fixture();
  f.page.dataRevision = 1;
  await f.push();
  assert.equal(f.calls.length, 1);
  assert.equal(typeof f.calls[0][2], "string");
  const previousRevision = f.calls[0][2];
  f.state.account = { ...f.state.account, quotaUpdatedAt: 3 };
  f.session.reset();
  await f.push();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1][1].accounts[0].quotaUpdatedAt, 3);
  assert.notEqual(f.calls[1][2], previousRevision);
});

test("同步请求合并，发送期间的新数据仍会送达", async () => {
  const f = fixture();
  await f.push();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  f.state.beforeEvaluate = async () => { entered.resolve(); await release.promise; };
  f.state.account = { ...f.state.account, quotaUpdatedAt: 2 };
  const pending = f.push();
  await entered.promise;
  f.state.account = { ...f.state.account, quotaUpdatedAt: 3 };
  f.session.markWidgetDataDirty();
  const update = f.session.requestWidgetUpdate();
  assert.equal(update, f.session.requestWidgetUpdate());
  release.resolve();
  await Promise.all([pending, update]);
  assert.equal(f.calls.at(-1)[1].accounts[0].quotaUpdatedAt, 3);
  assert.equal(f.calls.length, 3);
});

test("安装期间连接被替换，旧连接不能发送快照或污染新连接", async () => {
  const f = fixture();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  f.state.beforeEvaluate = async () => { entered.resolve(); await release.promise; };
  const pending = f.push();
  await entered.promise;
  f.state.cdp = { ...f.cdp };
  release.resolve();
  assert.equal(await pending, false);
  assert.deepEqual(f.calls, []);
  f.state.beforeEvaluate = null;
  await f.push();
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0][1].tokenUsage);
});

test("发送期间同一连接重置，迟到结果不能提交到新会话", async () => {
  const f = fixture();
  await f.push();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  f.state.beforeEvaluate = async () => { entered.resolve(); await release.promise; };
  f.state.account = { ...f.state.account, quotaUpdatedAt: 2 };
  const pending = f.push();
  await entered.promise;
  f.session.reset();
  release.resolve();
  assert.equal(await pending, false);
  f.state.beforeEvaluate = null;
  f.calls.length = 0;
  await f.push();
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0][1].tokenUsage, "重置后必须发送完整基线");
});

test("页面在健康检查间隔内消失时，未确认的更新触发重装和完整恢复", async () => {
  const f = fixture();
  await f.push();
  delete f.window.__codexQuotaWidget;
  f.state.network = { latencyMs: 999 };
  f.calls.length = 0;
  assert.equal(await f.push(), true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], "view");
  assert.deepEqual(f.calls[0][1].network, f.state.network);
  assert.deepEqual(f.calls[0][1].tokenUsage, f.state.usage);
});

test("批次中途异常不确认基线，下次更新重发并收敛", async () => {
  const f = fixture();
  await f.push();
  const updateNetwork = f.page.updateNetwork;
  f.page.updateNetwork = () => { throw new Error("fixture render failure"); };
  f.state.account = { ...f.state.account, quotaUpdatedAt: 2 };
  f.state.network = { latencyMs: 999 };
  f.state.usage = { status: "ready", turns: [{ turnId: "b", totalTokens: 200 }] };
  await assert.rejects(f.push(), /fixture render failure/);
  f.page.updateNetwork = updateNetwork;
  f.calls.length = 0;
  assert.equal(await f.session.requestWidgetUpdate(), true);
  assert.deepEqual(f.calls.map(([name]) => name), ["view", "network", "usage"]);
  assert.deepEqual(f.calls[2][1].updates, f.state.usage.turns);
});

test("安装失败不会留下已安装状态", async () => {
  const f = fixture();
  f.state.beforeEvaluate = () => { throw new Error("fixture install failure"); };
  await assert.rejects(f.push(), /fixture install failure/);
  f.state.beforeEvaluate = null;
  assert.equal(await f.session.requestWidgetUpdate(), true);
  assert.equal(f.calls.length, 1);
});

test("无数据变化时仍按健康间隔恢复被替换的运行时", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 100_000 });
  const f = fixture();
  await f.push();
  f.page.version = -1;
  f.calls.length = 0;
  t.mock.timers.tick(15_000);
  await f.session.requestWidgetUpdate();
  assert.equal(f.page.version, widget.WIDGET_RUNTIME_VERSION);
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0][1].tokenUsage);
});

test("保留 rollout 重建的短时空视图保护，到期后传递真实删除", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 100_000 });
  const f = fixture();
  await f.push();
  f.calls.length = 0;
  f.state.usage = { status: "ready", turns: [] };
  await f.push();
  assert.deepEqual(f.calls, []);
  t.mock.timers.tick(5_001);
  await f.push();
  assert.deepEqual(f.calls[0][1].removedTurnIds, ["a"]);
});

test("停止或断开连接时不安装或发送数据", async () => {
  const f = fixture();
  f.state.stopped = true;
  assert.equal(await f.push(), false);
  f.state.stopped = false;
  f.cdp.isConnected = false;
  assert.equal(await f.push(), false);
  assert.deepEqual(f.sent, []);
});
