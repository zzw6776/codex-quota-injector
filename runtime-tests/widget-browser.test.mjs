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
  assert.match(await b.value(".host-health-details-content"), /读取任务内容未确认/);
  assert.match(await b.value(".host-health-details-content"), /检查超时 <unsafe>/);
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelector('unsafe')`), null);
  await b.click(".host-health-flyout .host-health-recheck");
  await b.click(".host-health-flyout .host-health-recheck");
  const checks = await b.drain();
  assert.ok(checks.every(action => typeof action.id === "string" && action.id));
  assert.deepEqual(checks.map(({ type, threadId }) => ({ type, threadId })), [{ type: "host-health-recheck", threadId: "task" }]);
  assert.equal(await b.value(".host-health-more"), null);
  await b.click(".host-health-reload");
  await b.click(".host-health-diagnose");
  assert.deepEqual((await b.drain()).map(({ type, threadId }) => ({ type, threadId })), [
    { type: "host-health-reload", threadId: "task" },
    { type: "host-health-diagnose", threadId: "task" },
  ]);
  const layoutBeforeHealthPatch = await b.client.evaluate(`(() => {
    const main = ${SHADOW}.querySelector('.quota-popover').getBoundingClientRect();
    const flyout = ${SHADOW}.querySelector('.host-health-flyout').getBoundingClientRect();
    return { main: { left: main.left, top: main.top, right: main.right },
      flyout: { left: flyout.left, top: flyout.top } };
  })()`);
  await b.update(fixtureData({ hostHealth: { ...health, status: "ready", message: "4 项任务工具检查通过",
    checks: Object.fromEntries(tools.map(tool => [tool, { status: "passed" }])) } }));
  assert.match(await b.value(".host-health-details-content"), /读取任务内容通过/);
  const layoutAfterHealthPatch = await b.client.evaluate(`(() => {
    const main = ${SHADOW}.querySelector('.quota-popover').getBoundingClientRect();
    const flyout = ${SHADOW}.querySelector('.host-health-flyout').getBoundingClientRect();
    return { main: { left: main.left, top: main.top, right: main.right },
      flyout: { left: flyout.left, top: flyout.top } };
  })()`);
  assert.equal(layoutAfterHealthPatch.flyout.left, layoutAfterHealthPatch.main.right + 10,
    "工具状态局部刷新替换浮窗后仍须位于主面板右侧");
  assert.ok(Math.abs(layoutAfterHealthPatch.flyout.top - layoutAfterHealthPatch.main.top) <= 0.5,
    "工具状态局部刷新替换浮窗后仍须与主面板顶部对齐");
  assert.equal(layoutBeforeHealthPatch.flyout.left, layoutBeforeHealthPatch.main.right + 10);
  assert.ok(Math.abs(layoutBeforeHealthPatch.flyout.top - layoutBeforeHealthPatch.main.top) <= 0.5);
  await b.click(".host-health-flyout-close");
  assert.equal(await b.value(".host-health-banner"), null);
  assert.equal(await b.client.evaluate(`getComputedStyle(${SHADOW}.querySelector('.host-health-status .host-health-dot')).backgroundColor`), "rgb(67, 166, 101)");
  const mainPanelBefore = await b.client.evaluate(`(() => {
    const rect = ${SHADOW}.querySelector('.quota-popover').getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  })()`);
  await b.click(".host-health-status");
  assert.equal(await b.value(".host-health-banner"), null);
  assert.match(await b.value(".host-health-flyout"), /4 项任务工具检查通过/);
  const panelLayout = await b.client.evaluate(`(() => {
    const main = ${SHADOW}.querySelector('.quota-popover').getBoundingClientRect();
    const flyout = ${SHADOW}.querySelector('.host-health-flyout').getBoundingClientRect();
    return {
      main: { left: main.left, top: main.top, width: main.width, height: main.height },
      flyout: { left: flyout.left, top: flyout.top, width: flyout.width, height: flyout.height },
    };
  })()`);
  assert.deepEqual(panelLayout.main, mainPanelBefore, "打开任务工具浮窗不能改变主面板位置或尺寸");
  assert.equal(panelLayout.flyout.width, 280, "浮窗采用紧凑宽度");
  assert.ok(panelLayout.flyout.left >= panelLayout.main.left + panelLayout.main.width,
    "任务工具详情必须从主面板右侧打开");
  await b.click(".host-health-flyout-close");
  assert.equal(await b.value(".host-health-flyout"), null);
  await b.click(".host-health-status");
  await b.click(".close-panel");
  assert.equal(await b.value(".host-health-flyout"), null, "关闭主面板必须同时移除任务工具浮窗");
  await b.click(".quota-chip");
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
  await b.click(".host-health-details");
  assert.match(await b.value(".host-health-restart"), /重启 Codex/);
});

test("[UI-02] 检查进度不挤占主面板，超时与异常才显示提醒", { timeout: 30000 }, async t => {
  const b = await startBrowser(t);
  const health = { required: true, threadId: "task", status: "ready", verification: "calls",
    message: "4 项任务工具检查通过", canCheck: true, requiredTools: ["read_thread"],
    checks: { read_thread: { status: "passed" } } };
  await b.update(fixtureData({ hostHealth: health }));
  await b.click(".quota-chip");
  const bounds = () => b.client.evaluate(`(() => {
    const r = ${SHADOW}.querySelector('.quota-popover').getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  })()`);
  const before = await bounds();
  await b.update(fixtureData({ hostHealth: { ...health, status: "starting", code: "tool-checking",
    message: "检查中：已通过 1/4 项", checks: { read_thread: { status: "checking" } } } }));
  assert.equal(await b.value(".host-health-banner"), null);
  assert.equal(await b.value(".host-health-flyout"), null, "检查不自动弹出浮窗");
  assert.deepEqual(await bounds(), before);
  await b.click(".host-health-status");
  assert.match(await b.value(".host-health-flyout"), /检查中：已通过 1\/4 项/);
  assert.deepEqual(await bounds(), before);
  for (const [status, code] of [["unconfirmed", "tool-check-unconfirmed"], ["degraded", "tool-call-failed"]]) {
    await b.update(fixtureData({ hostHealth: { ...health, status, code, message: "需要关注" } }));
    assert.match(await b.value(".host-health-banner"), /需要关注/);
  }
  await b.update(fixtureData({ hostHealth: health }));
  assert.equal(await b.value(".host-health-banner"), null);
  assert.deepEqual(await bounds(), before);
});

test("[UI-02] 紧凑检查浮窗保留主面板草稿、按钮平铺且窄窗口不溢出", { timeout: 30000 }, async t => {
  const b = await startBrowser(t);
  const tools = ["list_threads", "read_thread", "list_projects", "get_usage_limits"];
  const health = { required: true, threadId: "task", status: "ready", verification: "calls",
    message: "4 项任务工具检查通过", canCheck: true, canRestart: true, canOpenLogs: true,
    updatedAt: Date.now(), requiredTools: tools,
    checks: Object.fromEntries(tools.map(tool => [tool, { status: "passed", checkedAt: Date.now() }])) };
  await b.update(fixtureData({ hostHealth: health }));
  await b.click(".quota-chip");
  await b.click(".extra-models-open");
  await b.click(".extra-platform-add");
  await b.fill('[name="name"]', "未保存的草稿");
  await b.client.evaluate(`window.retainedPanel = ${SHADOW}.querySelector('.quota-popover')`);
  await b.click(".host-health-status");
  assert.equal(await b.client.evaluate(`window.retainedPanel === ${SHADOW}.querySelector('.quota-popover')`), true);
  assert.equal(await b.value('[name="name"]', "value"), "未保存的草稿");
  assert.deepEqual(await b.client.evaluate(`Array.from(${SHADOW}.querySelectorAll('.host-health-action-grid button'), el => el.textContent)`),
    ["重新检查", "诊断工具目录", "刷新工具配置", "重启 Codex"]);
  for (const selector of [".host-health-open-logs", ".host-health-restart"]) await b.click(selector);
  assert.deepEqual((await b.drain()).map(action => action.type), ["host-health-open-logs", "host-health-restart"]);
  await b.click(".host-health-flyout-close");
  assert.equal(await b.value('[name="name"]', "value"), "未保存的草稿");
  await b.click(".extra-models-back");
  await b.click(".extra-models-back");
  await b.click(".host-health-status");
  await b.client.request("Emulation.setDeviceMetricsOverride", { width: 560, height: 620, deviceScaleFactor: 1, mobile: false });
  await b.update(fixtureData({ hostHealth: { ...health, actionError: "长错误信息".repeat(120) } }));
  assert.equal(await b.client.evaluate(`(() => {
    const flyout = ${SHADOW}.querySelector('.host-health-flyout');
    const rect = flyout.getBoundingClientRect();
    const scroller = flyout.querySelector('.host-health-flyout-scroll');
    return rect.left >= 12 && rect.right <= innerWidth - 12 && rect.top >= 12 &&
      rect.bottom <= innerHeight - 11 && scroller.scrollWidth === scroller.clientWidth &&
      scroller.scrollHeight > scroller.clientHeight;
  })()`), true, "窄窗口下浮窗保持边距，长错误纵向滚动而不横向溢出");
  await b.client.request("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await b.client.evaluate("document.documentElement.className = 'electron-light'");
  await b.update(fixtureData({ hostHealth: health }));
});
