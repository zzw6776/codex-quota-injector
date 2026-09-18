import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { widgetInstallExpression, WIDGET_RUNTIME_VERSION } from "../src/widget.mjs";
import { SHADOW, startBrowser, fixtureData } from "./support/browser.mjs";

test("[UI-01 UI-02] 正式包压缩后的 Widget 可序列化功能模块并完成页面动作", { timeout: 30_000 }, async t => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("../src/widget.mjs", import.meta.url))],
    bundle: true, platform: "node", format: "cjs", target: "node22",
    minify: true, write: false, legalComments: "none",
  });
  const module = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports });
  const b = await startBrowser(t);
  await b.client.evaluate("window.__codexQuotaWidget.destroy()");
  assert.equal(await b.client.evaluate(module.exports.widgetInstallExpression()), WIDGET_RUNTIME_VERSION);
  await b.update(fixtureData());
  await b.click(".quota-chip");
  assert.equal(await b.value(".quota-chip"), "77%");
  await b.click(".extra-models-open");
  await b.click(".extra-platform-add");
  await b.fill('[name="name"]', "Bundled platform");
  await b.fill('[name="baseUrl"]', "https://provider.example/v1/");
  await b.fill('[name="modelId"]', "bundled-model");
  await b.click('.extra-platform-form button[type="submit"]');
  const [action] = await b.drain();
  assert.equal(action.type, "extra-platform-save");
  assert.equal(action.platform.name, "Bundled platform");
  assert.equal(action.platform.models[0].id, "bundled-model");
  await b.click(".extra-models-back");
  await b.click(".extra-models-back");
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelector('.account-list') != null`), true);
});

test("[UI-01 UI-03 TOOL-06] 真实浏览器挂载、重复注入、换节点、版本替换和销毁不拦截原生输入", { timeout: 30_000 }, async t => {
  const b = await startBrowser(t);
  const count = () => b.client.evaluate('document.querySelectorAll("#codex-quota-injector-root").length');
  assert.equal(await count(), 1);
  await b.client.evaluate(widgetInstallExpression());
  assert.equal(await count(), 1);
  await b.click(".quota-chip");
  assert.match(await b.value(".quota-wrap", "className"), /is-open/);
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelector('.host-health-status.status-direct') != null`), true);
  assert.equal(await b.client.evaluate(`getComputedStyle(${SHADOW}.querySelector('.host-health-status .host-health-dot')).backgroundColor`), "rgb(91, 143, 201)");
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelector('.panel-controls .host-health-status + .close-panel') != null`), true,
    "宿主状态必须固定显示在关闭按钮左侧");
  await b.fill("#composer", "原生消息 中文", { shadow: false });
  await b.click("#send", { shadow: false });
  assert.deepEqual(await b.client.evaluate("nativeMessages"), ["原生消息 中文"]);
  assert.match(await b.value(".quota-wrap", "className"), /is-dismissed/);
  await b.click("#native-tool", { shadow: false });
  assert.equal(await b.client.evaluate("nativeToolClicks"), 1);
  await b.client.evaluate(`document.getElementById('profile-row').outerHTML='<div id="profile-row"><button id="profile" aria-label="打开设置">新节点</button></div>'`);
  await b.settled();
  assert.equal(await count(), 1);
  assert.equal(await b.value(".quota-chip"), "77%");
  await b.client.evaluate("window.__codexQuotaWidget.version = -1");
  await b.client.evaluate(widgetInstallExpression());
  assert.equal(await b.client.evaluate("window.__codexQuotaWidget.version"), WIDGET_RUNTIME_VERSION);
  assert.equal(await count(), 1);
  await b.client.evaluate("window.__codexQuotaWidget.destroy()");
  assert.equal(await count(), 0);
  assert.equal(await b.client.evaluate('document.getElementById("codex-quota-injector-global-style")'), null);
  await b.client.evaluate("document.getElementById('profile-row').append(document.createElement('span'))");
  await b.settled();
  assert.equal(await count(), 0, "销毁后观察器不能重新挂载");
});

test("[LCH-04 UI-02] 逐项检查详情、独立操作、超时颜色和缓存更新在浏览器生效", { timeout: 30000 }, async t => {
  const b = await startBrowser(t);
  const tools = ["list_threads", "read_thread", "list_projects", "get_usage_limits"];
  const health = { required: true, threadId: "task", status: "unconfirmed", verification: "calls",
    message: "3 项通过，1 项未确认", canCheck: true, canRestart: true, canOpenLogs: true,
    requiredTools: tools, checks: Object.fromEntries(tools.map(tool => [tool, {
      status: tool === "read_thread" ? "unconfirmed" : "passed",
      detail: tool === "read_thread" ? "检查超时 <unsafe>" : null,
    }])) };
  await b.update(fixtureData({ hostHealth: health }));
  await b.click(".quota-chip");
  assert.match(await b.value(".host-health-banner"), /3 项通过，1 项未确认/);
  assert.equal(await b.value(".host-health-restart"), null);
  assert.equal(await b.client.evaluate(`getComputedStyle(${SHADOW}.querySelector('.host-health-status .host-health-dot')).backgroundColor`), "rgb(217, 119, 6)");
  await b.click(".host-health-details");
  assert.match(await b.value(".host-health-details-content"), /读取任务内容：未确认/);
  assert.match(await b.value(".host-health-details-content"), /检查超时 <unsafe>/);
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelector('unsafe')`), null);
  await b.click(".host-health-recheck");
  await b.click(".host-health-recheck");
  const checks = await b.drain();
  assert.ok(checks.every(action => typeof action.id === "string" && action.id));
  assert.deepEqual(checks.map(({ type, threadId }) => ({ type, threadId })), [{ type: "host-health-recheck", threadId: "task" }]);
  await b.click(".host-health-more");
  await b.click(".host-health-reload");
  await b.click(".host-health-diagnose");
  assert.deepEqual((await b.drain()).map(({ type, threadId }) => ({ type, threadId })), [
    { type: "host-health-reload", threadId: "task" },
    { type: "host-health-diagnose", threadId: "task" },
  ]);
  await b.update(fixtureData({ hostHealth: { ...health, status: "ready", message: "4 项任务工具检查通过",
    checks: Object.fromEntries(tools.map(tool => [tool, { status: "passed" }])) } }));
  assert.match(await b.value(".host-health-details-content"), /读取任务内容：通过/);
  await b.click(".host-health-details");
  assert.equal(await b.value(".host-health-banner"), null);
  assert.equal(await b.client.evaluate(`getComputedStyle(${SHADOW}.querySelector('.host-health-status .host-health-dot')).backgroundColor`), "rgb(67, 166, 101)");
  await b.click(".host-health-status");
  assert.match(await b.value(".host-health-banner"), /4 项任务工具检查通过/);
  await b.update(fixtureData({ hostHealth: { ...health, threadId: "other", status: "degraded", message: "工具调用失败" } }));
  assert.equal(await b.value(".host-health-details-content"), null, "切换任务不展开旧任务详情");
  assert.equal(await b.value(".host-health-restart"), null, "切换任务不保留旧任务恢复菜单");
});

test("[LCH-04 UI-02] 待命不占据卡片，旧运行时不提供错误的检查按钮", { timeout: 30000 }, async t => {
  const b = await startBrowser(t);
  await b.update(fixtureData({ hostHealth: { required: true, status: "idle" } }));
  await b.click(".quota-chip");
  assert.equal(await b.value(".host-health-banner"), null);
  await b.update(fixtureData({ hostHealth: { required: true, status: "unconfirmed", code: "health-runtime-outdated",
    canCheck: false, canRestart: true, message: "检查服务待更新" } }));
  assert.match(await b.value(".host-health-banner"), /检查服务待更新/);
  assert.equal(await b.value(".host-health-recheck"), null);
  await b.click(".host-health-more");
  assert.match(await b.value(".host-health-restart"), /重启 Codex 应用/);
});
