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
    usage: { status: "ready", turns: [{ turnId: "a", totalTokens: 100, updatedAt: 1 }] },
  };
  const page = {
    version: widget.WIDGET_RUNTIME_VERSION,
    update: (...args) => calls.push(["view", ...args]),
    updateNetwork: (...args) => calls.push(["network", ...args]),
    updateExtraModels: (...args) => calls.push(["models", ...args]),
    updateTokenUsageDelta: (...args) => calls.push(["usage", ...args]),
  };
  const cdp = { isConnected: true, async evaluate(expression) {
    sent.push(expression);
    return Function("window", `return (${expression})`)({ __codexQuotaWidget: page });
  } };
  const session = createWidgetSession({
    cdp, widget, appDisplayVersion: "fixture", injectionMode: "macos",
    accountManager: { getViewModel: () => ({ accounts: [state.account], windows: [] }) },
    contextManager: { getViewModel: () => ({ models: [] }) },
    extraModelManager: { getViewModel: () => ({ platforms: [] }) },
    modelRouterManager: { getNetworkViewModel: () => state.network },
    tokenUsageManager: { getViewModel: () => state.usage },
    wakeupManager: { getViewModel: () => null },
  });
  session.widgetInstalled = true;
  session.lastWidgetHealthCheckAt = Date.now();
  return { session, state, calls, sent, async push() {
    session.markWidgetDataDirty();
    await session.requestWidgetUpdate();
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
  assert.ok(f.sent[0].length < 250, "小包不携带历史");
  f.calls.length = 0;
  await f.push();
  assert.deepEqual(f.calls, [], "无变化时不发送页面更新");
});

test("账号与用量同时变化时，静态数据和回合增量分别发送，重连恢复完整快照", async () => {
  const f = fixture();
  await f.push();
  f.calls.length = 0;
  f.state.account = { ...f.state.account, quotaUpdatedAt: 2 };
  f.state.usage = { status: "ready", turns: [{ turnId: "b", totalTokens: 200, updatedAt: 2 }] };
  await f.push();
  assert.deepEqual(f.calls.map(([name]) => name), ["view", "usage"]);
  assert.equal(Object.hasOwn(f.calls[0][1], "tokenUsage"), false);
  assert.equal(Object.hasOwn(f.calls[0][1], "network"), false);
  assert.deepEqual(f.calls[1][1].removedTurnIds, ["a"]);
  assert.deepEqual(f.calls[1][1].updates, f.state.usage.turns);
  assert.ok(f.calls[1][2] > f.calls[0][2]);
  f.calls.length = 0;
  f.session.lastStaticJson = null;
  await f.push();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0][1].tokenUsage, f.state.usage);
  assert.deepEqual(f.calls[0][1].network, f.state.network);
});
