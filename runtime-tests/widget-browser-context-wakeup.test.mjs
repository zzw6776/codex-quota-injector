import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { CodexContextManager } from "../src/codex-context.mjs";
import { startBrowser, fixtureData, SHADOW } from "./support/browser.mjs";
import { ExtraModelManager } from "../src/extra-model-manager.mjs";
import { widgetNetworkUpdateExpressionJson } from "../src/widget.mjs";

test("[UI-02 WK-01] 网络与额度刷新不重建唤醒表单，实际状态变化后仍保持滚动和草稿", { timeout: 30_000 }, async t => {
  const b = await startBrowser(t);
  const data = fixtureData();
  data.accounts[0].wakeup.times = Array.from({ length: 12 }, (_, index) => `${String(index).padStart(2, "0")}:00`);
  await b.update(data);
  await b.click(".quota-chip");
  await b.click(".wakeup-open");
  const before = await b.client.evaluate(`(() => {
    const root=${SHADOW};
    window.savedWakeupForm=root.querySelector('.wakeup-form');
    const input=root.querySelector('[name="time"]');
    input.value='23:45'; input.dispatchEvent(new Event('input', {bubbles:true}));
    input.focus({preventScroll:true});
    const scroll=root.querySelector('.panel-scroll');
    scroll.scrollTop=scroll.scrollHeight;
    return {scroll:scroll.scrollTop,height:root.querySelector('.quota-popover').offsetHeight};
  })()`);
  assert.ok(before.scroll > 100, "实际滚动到底，覆盖先恢复滚动再恢复尺寸导致的截断");
  await b.client.evaluate(widgetNetworkUpdateExpressionJson(JSON.stringify({ latencyMs: 250, sampledAt: 1 })));
  data.accounts[0].quotaUpdatedAt = Date.now();
  data.accounts[0].windows[0].remainingPercent = 60;
  await b.update(data);
  assert.equal(await b.client.evaluate(`window.savedWakeupForm === ${SHADOW}.querySelector('.wakeup-form')`), true);
  data.accounts[0].wakeup.message = { status: "success", text: "后台状态已更新" };
  await b.update(data);
  assert.match(await b.value(".wakeup-popover"), /后台状态已更新/);
  assert.equal(await b.value('[name="time"]', "value"), "23:45");
  assert.equal(await b.client.evaluate(`${SHADOW}.activeElement?.id`), "wakeup-time-account-1-0");
  assert.equal(await b.value(".panel-scroll", "scrollTop"), before.scroll);
  assert.equal(await b.value(".quota-popover", "offsetHeight"), before.height);
});

test("[UI-02 MOD-02] 目录后台更新保留正在编辑的上下文值、展开状态与焦点", { timeout: 30_000 }, async t => {
  const b = await startBrowser(t);
  const data = fixtureData();
  await b.click(".quota-chip");
  await b.click(".context-open");
  await b.click(".context-edit-open");
  await b.fill('[name="contextWindow"]', "384000");
  await b.click(".context-advanced summary");
  await b.fill('[name="maxContextWindow"]', "512000");
  data.context.message = "目录已更新";
  await b.update(data);
  assert.equal(await b.value('[name="contextWindow"]', "value"), "384000");
  assert.equal(await b.value('[name="maxContextWindow"]', "value"), "512000");
  assert.equal(await b.value(".context-advanced", "open"), true);
  assert.equal(await b.client.evaluate(`${SHADOW}.activeElement?.name`), "maxContextWindow");
  await b.click('.context-edit-form button[type="submit"]');
  const actions = await b.drain();
  assert.equal(actions.length, 1);
  assert.equal(actions[0].contextWindow, 384000);
  assert.equal(actions[0].maxContextWindow, 512000);
  data.context.message = "保存完成";
  await b.update(data);
  assert.equal(await b.value(".context-edit-form", "hidden"), true, "保存后不重新展开已关闭的编辑器");
});

test("[UI-02 MOD-02 MOD-04] 页面上下文保存和重置的动作交给实际管理器后正确持久化", { timeout: 30_000 }, async t => {
  const b = await startBrowser(t);
  const manager = new CodexContextManager({ codexHome: b.directory, dataDir: b.directory });
  await writeFile(join(b.directory, "models_cache.json"), JSON.stringify({ models: [{ slug: "fixture-model", display_name: "Fixture", context_window: 128000, max_context_window: 128000 }] }));
  await manager.initialize();
  await b.click(".quota-chip");
  await b.click(".context-open");
  await b.click(".context-edit-open");
  await b.fill('[name="contextWindow"]', "384000");
  await b.click('.context-edit-form button[type="submit"]');
  const [action] = await b.drain();
  assert.equal(action.type, "context-save");
  assert.equal(action.maxContextWindow, 384000);
  await manager.setOverride(action.slug, action.contextWindow, action.maxContextWindow);
  assert.equal(manager.getEffectiveCatalog().models[0].context_window, 384000);
  const reloaded = new CodexContextManager({ codexHome: b.directory, dataDir: b.directory });
  await reloaded.initialize();
  assert.equal(reloaded.getViewModel().models[0].effectiveContextWindow, 384000);
  await b.click(".context-edit-open");
  await b.click(".context-reset");
  const [reset] = await b.drain();
  await manager.resetOverride(reset.slug);
  assert.equal(manager.getEffectiveCatalog().models[0].context_window, 128000);
  await b.click(".context-refresh");
  assert.equal((await b.drain())[0].type, "context-refresh");
  await b.click(".context-reset-all");
  assert.equal((await b.drain())[0].type, "context-reset-all");
});

test("[UI-02 WK-01 MOD-03] 唤醒和模型管理页面在刷新后保留草稿，动作完整且不执行真实请求", { timeout: 30_000 }, async t => {
  const b = await startBrowser(t);
  const manager = new ExtraModelManager({ dataDir: b.directory });
  await manager.initialize();
  await b.update(fixtureData({ extraModels: manager.getViewModel() }));
  await b.click(".quota-chip");
  await b.click(".extra-models-open");
  await b.click('.extra-platform-edit[data-platform-id="d33f5ee0-0000-4000-8000-000000000001"]');
  await b.fill('.preset-platform-form [name="apiKey"]', "changed-fixture-key");
  await b.update(fixtureData({
    windows: [{ label: "5h", remainingPercent: 65 }],
    extraModels: manager.getViewModel(),
  }));
  assert.equal(await b.value('.preset-platform-form [name="apiKey"]', "value"),
    "changed-fixture-key");
  await b.click('.preset-platform-form [name="enabled"]');
  await b.click('.preset-platform-form button[type="submit"]');
  const [action] = await b.drain();
  assert.equal(action.type, "extra-platform-save");
  assert.equal(action.platform.apiKey, "changed-fixture-key");
  assert.equal(action.platform.preset, "deepseek");
  await b.click(".extra-models-back");
  assert.notEqual(await b.value(".extra-platform-list"), null);
  await b.click(".extra-models-back");
  await b.click(".wakeup-open");
  await b.click(".wakeup-time-add");
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelectorAll('.wakeup-time-remove').length`), 2);
  await b.click('.wakeup-time-remove[data-time-index="1"]');
  await b.click('.wakeup-form button[type="submit"]');
  assert.equal((await b.drain())[0].type, "wakeup-save");
  await b.click(".wakeup-now");
  assert.equal((await b.drain())[0].type, "wakeup-now");
  assert.equal(await b.value(".wakeup-now", "disabled"), true);
});
