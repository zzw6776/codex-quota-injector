import assert from "node:assert/strict";
import test from "node:test";
import { fixtureData, SHADOW, startBrowser } from "./support/browser.mjs";
import { widgetNetworkUpdateExpressionJson, widgetUpdateExpressionJson } from "../src/widget.mjs";

test("[UI-02] 账号刷新保留导入草稿和焦点，提交只触发一次且清除凭据", { timeout: 30_000 }, async t => {
  const b = await startBrowser(t);
  assert.equal(await b.value(".panel-version-text"), "vtest", "首次快照在面板关闭时也必须展示已加载版本");
  const data = fixtureData();
  await b.click(".quota-chip");
  await b.client.evaluate(`${SHADOW}.querySelector('.token-form').closest('details').open=true`);
  await b.fill('[name="token"]', "fixture-token-draft");
  await b.client.evaluate(`window.savedImportForm=${SHADOW}.querySelector('.token-form')`);
  for (const remainingPercent of [65, 64]) {
    data.accounts[0].windows[0].remainingPercent = remainingPercent;
    await b.update(data);
    assert.equal(await b.client.evaluate(`window.savedImportForm === ${SHADOW}.querySelector('.token-form')`), true);
    assert.equal(await b.value('[name="token"]', "value"), "fixture-token-draft");
    assert.equal(await b.client.evaluate(`${SHADOW}.activeElement?.name`), "token");
    assert.match(await b.value(".account-list"), new RegExp(`${remainingPercent}%`));
  }
  data.hostHealth = { status: "starting", required: true };
  await b.update(data);
  assert.equal(await b.value('[name="token"]', "value"), "fixture-token-draft", "健康状态改变重建面板也保留输入");
  assert.equal(await b.client.evaluate(`${SHADOW}.activeElement?.name`), "token");
  await b.click('.token-form button[type="submit"]');
  const actions = await b.drain();
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, "token-add");
  assert.equal(actions[0].token, "fixture-token-draft");
  data.operation = { state: "success", message: "导入完成" };
  await b.update(data);
  assert.equal(await b.value('[name="token"]', "value"), "");
});

test("[UI-03 WK-01] 拖动中收到后台更新不打断缩放，松开后展示最新状态", { timeout: 30_000 }, async t => {
  const b = await startBrowser(t);
  const data = fixtureData();
  await b.click(".quota-chip");
  await b.click(".wakeup-open");
  const before = await b.client.evaluate(`(() => {
    window.resizingPanel=${SHADOW}.querySelector('.quota-popover');
    const r=window.resizingPanel.getBoundingClientRect();
    return {x:r.right-6,y:r.top+6,width:r.width,height:r.height};
  })()`);
  await b.client.request("Input.dispatchMouseEvent", { type: "mousePressed", x: before.x, y: before.y, button: "left", buttons: 1, clickCount: 1 });
  data.accounts[0].wakeup.message = { status: "success", text: "拖动期间收到状态" };
  await b.update(data);
  assert.equal(await b.client.evaluate(`window.resizingPanel === ${SHADOW}.querySelector('.quota-popover')`), true);
  await b.client.request("Input.dispatchMouseEvent", { type: "mouseMoved", x: before.x + 40, y: before.y - 40, button: "left", buttons: 1 });
  await b.client.request("Input.dispatchMouseEvent", { type: "mouseReleased", x: before.x + 40, y: before.y - 40, button: "left", buttons: 0, clickCount: 1 });
  await b.settled();
  assert.ok(await b.value(".quota-popover", "offsetWidth") > before.width);
  assert.ok(await b.value(".quota-popover", "offsetHeight") > before.height);
  assert.match(await b.value(".wakeup-popover"), /拖动期间收到状态/);
});

test("[OBS-01] 静态数据更新不抹掉独立通道的用量，关闭期间的账号更新在打开时可见", { timeout: 30_000 }, async t => {
  const b = await startBrowser(t);
  const data = fixtureData({ tokenUsage: { status: "ready", turns: [{
    turnId: "turn-a", totalTokens: 100, inputTokens: 90, outputTokens: 10,
    completed: true, updatedAt: 1, cost: { available: false },
  }] } });
  await b.update(data);
  await b.client.evaluate(widgetNetworkUpdateExpressionJson(JSON.stringify({ status: "stable", latencyMs: 123 })));
  const { tokenUsage, ...staticData } = data;
  staticData.accounts[0].email = "latest@example.test";
  await b.client.evaluate(widgetUpdateExpressionJson(JSON.stringify(staticData), "static-only"));
  await b.settled();
  assert.equal(await b.client.evaluate('document.querySelectorAll("[data-codex-token-usage]").length'), 1);
  await b.click(".quota-chip");
  assert.match(await b.value(".account-list"), /latest@example.test/);
});

test("[UI-02 UI-03] 模型编辑时公共状态继续更新，表单节点和焦点保持不变", { timeout: 30_000 }, async t => {
  const b = await startBrowser(t);
  await b.click('.quota-chip');
  await b.click('.extra-models-open');
  await b.click('.extra-platform-add');
  await b.fill('.extra-platform-form [name="name"]', '正在编辑的平台');
  await b.client.evaluate(`window.editingForm = ${SHADOW}.querySelector('.extra-platform-form')`);
  const data = fixtureData({ version: 'updated', windows: [{ remainingPercent: 42 }],
    hostHealth: { required: true, status: 'degraded', message: 'fixture unavailable', canOpenLogs: true } });
  await b.update(data);
  assert.match(await b.value('.quota-chip'), /42%/);
  assert.equal(await b.value('.panel-version-text'), 'vupdated');
  assert.match(await b.value('.host-health-status', 'className'), /degraded/);
  assert.match(await b.value('.host-health-banner'), /fixture unavailable/);
  assert.equal(await b.client.evaluate(`window.editingForm === ${SHADOW}.querySelector('.extra-platform-form')`), true);
  assert.equal(await b.value('.extra-platform-form [name="name"]', 'value'), '正在编辑的平台');
  assert.equal(await b.client.evaluate(`${SHADOW}.activeElement?.name`), 'name');
  await b.click('.host-health-recheck');
  assert.deepEqual((await b.drain()).map(action => action.type), ['host-health-recheck']);
  data.hostHealth = { required: true, status: 'ready' };
  await b.update(data);
  assert.equal(await b.value('.host-health-banner'), null);
  assert.match(await b.value('.host-health-status', 'className'), /ready/);
  assert.equal(await b.client.evaluate(`window.editingForm === ${SHADOW}.querySelector('.extra-platform-form')`), true);
});
