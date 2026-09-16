import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { CodexContextManager } from "../src/codex-context.mjs";
import { startBrowser, fixtureData, SHADOW } from "./support/browser.mjs";
import { ExtraModelManager } from "../src/extra-model-manager.mjs";

test("[A UI-02 MOD-02 MOD-04] 页面上下文保存和重置的动作交给实际管理器后正确持久化", { timeout: 30_000 }, async t => {
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

test("[A UI-02 WK-01 MOD-03] 唤醒和模型管理页面在刷新后保留草稿，动作完整且不执行真实请求", { timeout: 30_000 }, async t => {
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
