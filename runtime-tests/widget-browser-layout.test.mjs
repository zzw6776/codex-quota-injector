import assert from "node:assert/strict";
import test from "node:test";
import { widgetTokenUsageDeltaUpdateExpressionJson, widgetTokenUsageUpdateExpressionJson } from "../src/widget.mjs";
import { fixtureData, SHADOW, startBrowser } from "./support/browser.mjs";

test("[UI-03 UI-04 OBS-01 OBS-03] 页面大小、长列表、主题、任务切换和用量增量不串到另一任务", { timeout: 30_000 }, async t => {
  const b = await startBrowser(t);
  const accounts = Array.from({ length: 40 }, (_, i) => ({ ...fixtureData().accounts[0], id: `a-${i}`, current: i === 0, email: `${i}-${"long".repeat(18)}@example.test` }));
  await b.update(fixtureData({ accounts }));
  await b.click(".quota-chip");
  for (const [width, height] of [[1280,900], [800,600], [480,420]]) {
    await b.client.request("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await b.settled();
    const bounds = await b.client.evaluate(`(() => {const e=${SHADOW}.querySelector('.quota-popover');const s=e.querySelector('.panel-scroll');const r=e.getBoundingClientRect();return {top:r.top,left:r.left,right:r.right,bottom:r.bottom,scroll:s.scrollHeight,client:s.clientHeight};})()`);
    assert.ok(bounds.top >= 40 && bounds.left >= 0 && bounds.right <= width + 1 && bounds.bottom <= height, JSON.stringify(bounds));
    assert.ok(bounds.scroll > bounds.client);
  }
  await b.client.evaluate('document.documentElement.className = "electron-light"');
  await b.update(fixtureData({ accounts }));
  assert.match(await b.value(".quota-wrap", "className"), /is-light/);
  const usage = { turnId: "turn-a", totalTokens: 100, inputTokens: 90, outputTokens: 10, updatedAt: 1, completed: true, cost: { available: false } };
  await b.client.evaluate(widgetTokenUsageUpdateExpressionJson(JSON.stringify({ status: "ready", turns: [usage] }), "revision-1"));
  await b.settled();
  assert.equal(await b.client.evaluate('document.querySelectorAll("[data-codex-token-usage]").length'), 1);
  await b.client.evaluate(widgetTokenUsageDeltaUpdateExpressionJson(JSON.stringify({ status: "ready", updates: [{ ...usage, turnId: "turn-b", totalTokens: 200 }], removedTurnIds: ["turn-a"] }), "revision-2"));
  await b.settled();
  assert.deepEqual(await b.client.evaluate('[...document.querySelectorAll("[data-codex-token-usage]")].map(e=>e.getAttribute("data-codex-token-usage"))'), ["turn-b"]);
  await b.client.evaluate('document.getElementById("conversation").innerHTML = `<article data-content-search-turn-key="turn-c"><div>另一个任务</div></article>`');
  await b.settled();
  assert.equal(await b.client.evaluate('document.querySelectorAll("[data-codex-token-usage]").length'), 0);
  await b.client.evaluate(widgetTokenUsageUpdateExpressionJson(JSON.stringify({ status: "ready", turns: [{ ...usage, turnId: "turn-c" }] }), "revision-3"));
  await b.settled();
  assert.equal(await b.client.evaluate('document.querySelector("[data-codex-token-usage]").getAttribute("data-codex-token-usage")'), "turn-c");
  await b.client.evaluate(widgetTokenUsageUpdateExpressionJson(JSON.stringify({ status: "ready", turns: [{ ...usage, turnId: "turn-late" }] }), "revision-4"));
  await b.client.evaluate('document.getElementById("conversation").innerHTML = `<article id="late-turn"><div>延迟设置回合标识</div></article>`');
  await b.settled();
  assert.equal(await b.client.evaluate('document.querySelectorAll("[data-codex-token-usage]").length'), 0);
  await b.client.evaluate('document.getElementById("late-turn").setAttribute("data-content-search-turn-key", "turn-late")');
  await b.settled();
  assert.equal(await b.client.evaluate('document.querySelector("[data-codex-token-usage]").getAttribute("data-codex-token-usage")'), "turn-late");
});

test("[UI-04] 请求明细按实际滚动条宽度补齐右侧间距", { timeout: 30_000 }, async t => {
  const b = await startBrowser(t);
  const generationDetails = Array.from({ length: 30 }, (_, sequence) => ({
    sequence,
    hasVisibleText: true,
    firstTokenLatencyMs: 1_000 + sequence,
    generationDurationMs: 2_000,
    outputSpeed: 50,
    networkLatency: { status: "stable", latencyMs: 200 },
  }));
  await b.update(fixtureData({
    tokenUsage: { status: "ready", turns: [{
      turnId: "turn-b", totalTokens: 100, inputTokens: 90, outputTokens: 10,
      cacheWriteInputTokens: 0, reasoningOutputTokens: 0,
      cumulativeTotalTokens: 100, completed: true, updatedAt: 1,
      cost: { available: false }, generationDetails,
    }] },
  }));
  const pointer = await b.client.evaluate(`(() => {
    const line=document.querySelector('[data-codex-token-usage="turn-b"]');
    const rect=line.getBoundingClientRect();
    return {x:rect.left+40,y:rect.top+rect.height/2};
  })()`);
  await b.client.request("Input.dispatchMouseEvent", { type: "mouseMoved", ...pointer });
  await b.client.evaluate("new Promise(resolve => setTimeout(resolve, 600))");
  await b.client.evaluate(`(() => {
    const tooltip=document.querySelector('#codex-token-usage-tooltip:not([hidden])');
    const section=[...tooltip.querySelectorAll('details')]
      .find(item=>item.querySelector(':scope > summary')?.textContent.startsWith('请求明细'));
    section.open=true;
  })()`);
  await b.settled();
  const layout = await b.client.evaluate(`(() => {
    const tooltip=document.querySelector('#codex-token-usage-tooltip:not([hidden])');
    const section=[...tooltip.querySelectorAll('details')]
      .find(item=>item.querySelector(':scope > summary')?.textContent.startsWith('请求明细'));
    const list=section.querySelector(':scope > div');
    const metrics=list.querySelector(':scope > * span:last-child');
    const style=getComputedStyle(list);
    const borderWidth=(parseFloat(style.borderLeftWidth)||0)+(parseFloat(style.borderRightWidth)||0);
    const scrollbarWidth=Math.max(0,list.offsetWidth-list.clientWidth-borderWidth);
    const listRect=list.getBoundingClientRect();
    const metricsRect=metrics.getBoundingClientRect();
    return {
      scrollbarWidth,
      paddingRight:parseFloat(style.paddingRight),
      contentEndGap:listRect.right-metricsRect.right,
    };
  })()`);
  assert.equal(layout.paddingRight, Math.max(0, 16 - layout.scrollbarWidth), JSON.stringify(layout));
  assert.ok(layout.contentEndGap >= 15 && layout.contentEndGap <= 17, JSON.stringify(layout));
});

test("[UI-03] 二级页面继承主窗口尺寸、可临时拖大且返回后不保存", { timeout: 30_000 }, async t => {
  const b = await startBrowser(t);
  await b.client.request("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await b.click(".quota-chip");
  const size = () => b.client.evaluate(`(() => {
    const panel = ${SHADOW}.querySelector('.quota-popover');
    return { width: panel.offsetWidth, height: panel.offsetHeight };
  })()`);
  const accountSize = await size();
  assert.equal(accountSize.width, 430, "主账号窗口必须保留原来的宽度");
  for (const [open, back] of [
    [".extra-models-open", ".extra-models-back"],
    [".context-open", ".context-back"],
    [".wakeup-open", ".wakeup-back"],
  ]) {
    await b.click(open);
    assert.deepEqual(await size(), accountSize, `${open} 打开的二级页面必须继承主窗口尺寸`);
    assert.equal(await b.client.evaluate(`${SHADOW}.querySelector('.panel-resize-handle')`), null,
      "二级页面不得显示额外的缩放按钮");
    await b.click(back);
  }

  await b.click(".extra-models-open");
  assert.equal(await b.client.evaluate(`getComputedStyle(${SHADOW}.querySelector('.quota-popover')).borderRadius`),
    "16px", "二级页面拖大后仍必须保留圆角外框");
  const edges = await b.client.evaluate(`(() => {
    const rect = ${SHADOW}.querySelector('.quota-popover').getBoundingClientRect();
    return {
      top: { x: rect.x + rect.width / 2, y: rect.y + 2 },
      right: { x: rect.right - 2, y: rect.y + rect.height / 2 },
      corner: { x: rect.right - 6, y: rect.y + 6 },
    };
  })()`);
  const moveTo = async ({ x, y }) => {
    await b.client.request("Input.dispatchMouseEvent", {
      type: "mouseMoved", x, y, button: "none", buttons: 0,
    });
    return b.client.evaluate(`getComputedStyle(${SHADOW}.querySelector('.quota-popover')).cursor`);
  };
  assert.equal(await moveTo(edges.top), "ns-resize", "顶部边缘必须显示纵向缩放光标");
  assert.equal(await moveTo(edges.right), "ew-resize", "右侧边缘必须显示横向缩放光标");
  assert.equal(await moveTo(edges.corner), "nesw-resize", "右上角必须显示斜向缩放光标");
  await b.client.request("Input.dispatchMouseEvent", {
    type: "mousePressed", x: edges.corner.x, y: edges.corner.y, button: "left", buttons: 1, clickCount: 1,
  });
  await b.client.request("Input.dispatchMouseEvent", {
    type: "mouseMoved", x: edges.corner.x + 50, y: edges.corner.y - 50, button: "left", buttons: 1,
  });
  await b.client.request("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: edges.corner.x + 50, y: edges.corner.y - 50, button: "left", buttons: 0, clickCount: 1,
  });
  const enlarged = await size();
  assert.ok(enlarged.width > accountSize.width && enlarged.height > accountSize.height,
    `拖动后必须在两个方向放大：${JSON.stringify(enlarged)}`);
  await b.click(".extra-models-back");
  assert.deepEqual(await size(), accountSize, "返回后主窗口尺寸不得受拖动影响");
  await b.click(".extra-models-open");
  assert.deepEqual(await size(), accountSize, "重新打开二级页面时不得保留上次拖动尺寸");
  await b.click(".extra-models-back");

  await b.client.request("Emulation.setDeviceMetricsOverride", {
    width: 480,
    height: 420,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await b.settled();
  const compactAccountSize = await size();
  await b.click(".extra-models-open");
  assert.deepEqual(await size(), compactAccountSize, "小窗口中的二级页面也必须继承主窗口实际尺寸");
});

test("[UI-02] 标题与返回状态关闭按钮固定在滚动内容之外", { timeout: 30_000 }, async t => {
  const b = await startBrowser(t);
  const data = fixtureData();
  data.accounts = Array.from({ length: 12 }, (_, index) => ({ ...data.accounts[0], id: `account-${index}` }));
  data.extraModels.platforms = Array.from({ length: 12 }, (_, index) => ({
    id: `platform-${index}`, name: `平台 ${index}`, enabled: false, baseUrl: 'https://example.invalid/',
    models: [{ id: `model-${index}`, displayName: `模型 ${index}`, compatibility: { status: 'pending' } }],
  }));
  await b.update(data);
  await b.click('.quota-chip');
  for (const page of ['accounts', 'models']) {
    if (page === 'models') await b.click('.extra-models-open');
    const before = await b.client.evaluate(`(() => {
      const panel=${SHADOW}.querySelector('.quota-popover');
      const head=panel.querySelector(':scope > .panel-head');
      const scroller=panel.querySelector('.panel-scroll');
      return {headTop:head.getBoundingClientRect().top, headBottom:head.getBoundingClientRect().bottom,
        bodyTop:scroller.getBoundingClientRect().top, height:panel.getBoundingClientRect().height};
    })()`);
    assert.ok(before.headBottom <= before.bodyTop + 1, '标题独立占位，不遮挡正文');
    await b.client.evaluate(`${SHADOW}.querySelector('.panel-scroll').scrollTop = 100000`);
    const after = await b.client.evaluate(`(() => {
      const panel=${SHADOW}.querySelector('.quota-popover');
      const head=panel.querySelector(':scope > .panel-head');
      return {headTop:head.getBoundingClientRect().top, height:panel.getBoundingClientRect().height,
        scrollTop:panel.querySelector('.panel-scroll').scrollTop,
        controls:head.contains(panel.querySelector('.close-panel')) && head.contains(panel.querySelector('.host-health-status'))};
    })()`);
    assert.ok(after.scrollTop > 0, '必须实际产生正文滚动');
    assert.equal(after.headTop, before.headTop);
    assert.equal(after.height, before.height, '固定标题不能放大外层窗口');
    assert.equal(after.controls, true);
  }
  await b.click('.extra-models-back');
  assert.notEqual(await b.value('.accounts-head'), null, '滚动到底后仍能直接返回');
  await b.click('.close-panel');
  assert.match(await b.value('.quota-wrap', 'className'), /is-dismissed/);
});
