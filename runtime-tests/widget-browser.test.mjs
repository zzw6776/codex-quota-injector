import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { widgetInstallExpression, WIDGET_RUNTIME_VERSION } from "../src/widget.mjs";
import { SHADOW, startBrowser, fixtureData } from "./support/browser.mjs";

test("[A UI-01 UI-02] 正式包压缩后的 Widget 可序列化功能模块并完成页面动作", { timeout: 30_000 }, async t => {
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

test("[A UI-01 UI-03 TOOL-06] 真实浏览器挂载、重复注入、换节点、版本替换和销毁不拦截原生输入", { timeout: 30_000 }, async t => {
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

test("[A LCH-04 UI-02] codex_app 降级会显示常驻入口、诊断与恢复动作", { timeout: 30_000 }, async t => {
  const b = await startBrowser(t);
  await b.update(fixtureData({
    hostHealth: {
      required: true,
      status: "degraded",
      code: "required-tool-missing",
      message: "Codex 任务工具不完整",
      detail: "fixture <unsafe>",
      missingTools: ["read_thread"],
      updatedAt: Date.UTC(2026, 8, 13, 12, 0, 0),
      canRestart: true,
      canOpenLogs: true,
    },
  }));
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelector('.host-health-dot.degraded') != null`), true);
  await b.click(".quota-chip");
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelector('.host-health-status.status-degraded') != null`), true);
  assert.equal(await b.client.evaluate(`getComputedStyle(${SHADOW}.querySelector('.host-health-status .host-health-dot')).backgroundColor`), "rgb(220, 76, 63)");
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelector('.panel-controls .host-health-status + .close-panel') != null`), true);
  const statusRect = await b.client.evaluate(`(() => {const r=${SHADOW}.querySelector('.host-health-status').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await b.client.request("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: statusRect.x,
    y: statusRect.y,
  });
  await b.client.evaluate("new Promise(resolve => setTimeout(resolve, 350))");
  assert.match(await b.value(".account-tooltip"), /任务功能异常/);
  assert.match(await b.value(".account-tooltip"), /缺少 1 项功能/);
  assert.match(await b.value(".account-tooltip"), /✕ 读取会话内容/);
  assert.match(await b.value(".account-tooltip"), /建议：先重新加载并检查，仍异常则重启 Codex/);
  assert.match(await b.value(".account-tooltip"), /诊断：read_thread 未注册/);
  assert.match(await b.value(".account-tooltip"), /状态码：required-tool-missing/);
  assert.match(await b.value(".account-tooltip"), /详情：fixture <unsafe>/);
  assert.match(await b.value(".account-tooltip"), /状态更新：/);
  assert.match(await b.value(".host-health-banner"), /Codex 任务工具不可用/);
  assert.match(await b.value(".host-health-banner"), /read_thread/);
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelector('.host-health-banner unsafe')`), null,
    "诊断文本不能作为 HTML 注入");
  await b.click(".host-health-recheck");
  await b.click(".host-health-recheck");
  await b.click(".host-health-restart");
  await b.click(".host-health-open-logs");
  assert.deepEqual((await b.drain()).map((action) => action.type), [
    "host-health-recheck",
    "host-health-recheck",
    "host-health-restart",
    "host-health-open-logs",
  ]);
  await b.update(fixtureData({
    hostHealth: {
      required: true,
      status: "ready",
      message: "Codex 任务工具已就绪",
      requiredTools: ["list_threads", "read_thread", "list_projects", "get_usage_limits"],
      missingTools: [],
      toolsVerified: true,
      canRestart: true,
      canOpenLogs: true,
    },
  }));
  assert.equal(await b.value(".host-health-banner"), null);
  assert.equal(await b.value(".quota-chip > .host-health-dot"), null);
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelector('.host-health-status.status-ready') != null`), true);
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelector('.host-health-status .host-health-dot.ready') != null`), true);
  assert.equal(await b.client.evaluate(`getComputedStyle(${SHADOW}.querySelector('.host-health-status .host-health-dot.ready')).backgroundColor`), "rgb(67, 166, 101)");
  const readyStatusRect = await b.client.evaluate(`(() => {const r=${SHADOW}.querySelector('.host-health-status').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await b.client.request("Input.dispatchMouseEvent", { type: "mouseMoved", x: 0, y: 0 });
  await b.client.request("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: readyStatusRect.x,
    y: readyStatusRect.y,
  });
  await b.client.evaluate("new Promise(resolve => setTimeout(resolve, 350))");
  const readyTooltip = await b.value(".account-tooltip");
  assert.match(readyTooltip, /任务功能正常/);
  assert.match(readyTooltip, /4 项常用功能已加载/);
  assert.match(readyTooltip, /✓ 查看任务列表/);
  assert.match(readyTooltip, /✓ 读取会话内容/);
  assert.match(readyTooltip, /✓ 查看项目列表/);
  assert.match(readyTooltip, /✓ 查看用量额度/);
  assert.doesNotMatch(readyTooltip, /状态码：|list_threads|read_thread|list_projects|get_usage_limits/);
});
