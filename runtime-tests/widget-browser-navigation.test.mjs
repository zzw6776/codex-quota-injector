import assert from "node:assert/strict";
import test from "node:test";
import { ExtraModelManager } from "../src/extra-model-manager.mjs";
import { fixtureData, startBrowser, SHADOW } from "./support/browser.mjs";
import { MODEL_CAPABILITY_PROBE_VERSION } from "../src/model-capability-probe.mjs";

test("[UI-02 MOD-03] 平台设置和新增平台逐层返回模型列表，再返回首页", { timeout: 30_000 }, async t => {
  const b = await startBrowser(t);
  const manager = new ExtraModelManager({ dataDir: b.directory });
  const view = await manager.initialize();
  view.platforms.push({ id: "fixture-platform", name: "自定义平台", baseUrl: "https://example.invalid/",
    apiKey: "", enabled: false, models: [{ id: "fixture-model", displayName: "测试模型",
      contextWindow: 128000, compatibility: { status: "pending" } }] });
  await b.update(fixtureData({ extraModels: view }));
  await b.click('.quota-chip');
  await b.click('.extra-models-open');
  for (const enter of [
    '.extra-platform-edit[data-platform-id="d33f5ee0-0000-4000-8000-000000000001"]',
    '.extra-platform-edit[data-platform-id="fixture-platform"]',
    '.extra-platform-add',
  ]) {
    await b.click(enter);
    assert.notEqual(await b.value('.extra-platform-form'), null);
    assert.equal(await b.value('.extra-models-back', 'ariaLabel'), "返回模型管理");
    await b.click('.extra-models-back');
    assert.equal(await b.value('.extra-platform-form'), null);
    assert.notEqual(await b.value('.extra-platform-list'), null, "退出表单不能跳过模型列表");
    assert.equal(await b.value('.extra-models-back', 'ariaLabel'), "返回账号额度");
    assert.deepEqual(await b.drain(), [], "返回不能自动保存或触发检测");
  }
  await b.click('.extra-models-back');
  assert.equal(await b.value('.extra-platform-list'), null);
  assert.notEqual(await b.value('.extra-models-open'), null);
});

for (const destination of ["home", "other-platform"]) {
  test(`[UI-02 MOD-03] 检测退出到 ${destination} 后结果仍回填对应草稿，保存保留检测参数`, { timeout: 30_000 }, async t => {
    const b = await startBrowser(t);
    let finishProbe;
    const manager = new ExtraModelManager({ dataDir: b.directory,
      probeModel: async ({ onProgress }) => {
        onProgress({ stage: "image", message: "图片检测，第 2 次尝试", current: 4, total: 8, retry: true });
        return new Promise(resolve => { finishProbe = resolve; });
      },
    });
    await manager.initialize();
    const preset = manager.getViewModel().platforms.find(item => item.preset === "deepseek");
    await manager.savePlatform({ ...preset, apiKey: "fixture-key", enabled: false });
    await manager.savePlatform({ name: "另一平台", baseUrl: "https://example.invalid/", apiKey: "other-key", enabled: false,
      models: [{ id: preset.models[0].id, displayName: "同名模型", contextWindow: 64000 }] });
    const other = manager.getViewModel().platforms.find(item => item.name === "另一平台");
    await b.update(fixtureData({ extraModels: manager.getViewModel() }));
    await b.click('.quota-chip');
    await b.click('.extra-models-open');
    const openPreset = `.extra-platform-edit[data-platform-id="${preset.id}"]`;
    await b.click(openPreset);
    await b.fill(`[name="presetContextWindow"][data-model-id="${preset.models[0].id}"]`, '256');
    await b.click('[data-model-index="0"] .extra-model-detect');
    const [action] = await b.drain();
    const pending = manager.detectModel(action.platform, action.modelId, { requestId: action.requestId });
    await b.update(fixtureData({ extraModels: manager.getViewModel() }));
    assert.match(await b.value('[data-model-index="0"] .extra-model-detect + .extra-model-inline-progress'), /第 2 次尝试/);
    assert.equal(await b.value('[data-model-index="1"] .extra-model-inline-progress'), "");
    assert.equal(await b.value('.extra-model-feedback .extra-model-progress'), null);
    await b.click('.extra-models-back');
    assert.equal(await b.value(openPreset, 'disabled'), false, "检测期间必须允许重新进入设置");
    await b.click(openPreset);
    assert.equal(await b.value('[data-model-index="0"] .extra-model-main-status'), "检测中…");
    assert.equal(await b.value('[data-model-index="0"] .extra-model-detect', 'disabled'), false);
    assert.match(await b.value('[data-model-index="0"] .extra-model-inline-progress'), /第 2 次尝试/);
    await b.click('.extra-models-back');
    if (destination === "home") await b.click('.extra-models-back');
    else await b.click(`.extra-platform-edit[data-platform-id="${other.id}"]`);
    finishProbe({ status: "verified", protocol: "responses", historyMode: "reasoning-text-only",
      toolContinuation: true, supportsImage: true, imageStatus: "supported", reasoningEfforts: ["low", "high"],
      capabilities: { transport: { responses: "native" }, streaming: "native", functionTools: "native",
        customTools: "bridged", namespaceTools: "bridged", reasoning: "native", reasoningToolChoice: "auto-only" },
      warnings: [], codexConformance: "passed", probeVersion: MODEL_CAPABILITY_PROBE_VERSION, checkedAt: Date.now() });
    await pending;
    // Full updates while on the homepage must consume results too, not only the model delta path.
    await b.update(fixtureData({ extraModels: manager.getViewModel() }));
    assert.deepEqual(await b.drain(), [], "后台检测完成不能自动保存");
    if (destination === "home") await b.click('.extra-models-open');
    else {
      assert.equal(await b.client.evaluate(`${SHADOW}.querySelector('.extra-platform-form').dataset.platformId`), other.id);
      assert.notEqual(await b.value('.extra-model-main-status'), "检测通过", "同名模型不能收到其他平台的检测结果");
      await b.click('.extra-models-back');
    }
    assert.equal(await b.value(`.extra-platform-card[data-platform-id="${preset.id}"] [data-model-index="0"] .extra-model-main-status`), "检测通过");
    assert.equal(await b.value(`.extra-platform-card[data-platform-id="${preset.id}"] .extra-model-unsaved`), "未保存");
    const layout = await b.client.evaluate(`(() => {
      const row = ${SHADOW}.querySelector('.extra-platform-card[data-platform-id="${preset.id}"] [data-model-index="0"]');
      const [heading, parameters] = row.children;
      const unsaved = row.querySelector('.extra-model-unsaved');
      return { gap: parameters.getBoundingClientRect().top - heading.getBoundingClientRect().bottom,
        color: getComputedStyle(unsaved).color, labelColor: getComputedStyle(heading.querySelector('.model-label')).color,
        background: getComputedStyle(unsaved).backgroundColor };
    })()`);
    assert.ok(layout.gap >= 8, "状态行与参数区须留出可见间距，不能紧贴或重叠");
    assert.notEqual(layout.color, layout.labelColor, "未保存必须与次要文字区分");
    assert.notEqual(layout.background, "rgba(0, 0, 0, 0)", "未保存应有显眼的标签背景");
    await b.click(openPreset);
    assert.equal(await b.value('[data-model-index="0"] .extra-model-main-status'), "检测通过");
    assert.equal(await b.value('[data-model-index="0"] .extra-model-unsaved'), "未保存");
    assert.equal(await b.value(`[name="presetContextWindow"][data-model-id="${preset.models[0].id}"]`, 'value'), '256');
    await b.click('.extra-platform-form button[type="submit"]');
    const [save] = await b.drain();
    assert.equal(save.type, "extra-platform-save");
    assert.equal(save.platform.models[0].compatibility.status, "verified");
    assert.equal(save.platform.models[0].compatibility.targetFingerprint,
      manager.getViewModel().modelDetections.find(item => item.requestId === action.requestId).model.compatibility.targetFingerprint);
    await manager.savePlatform(save.platform, { requestId: save.requestId });
    assert.equal(manager.getViewModel().platforms.find(item => item.id === preset.id).models[0].compatibility.status, "verified");
    await b.update(fixtureData({ extraModels: manager.getViewModel() }));
    assert.equal(await b.value('.extra-model-unsaved'), null);
    await b.click('.extra-models-back');
    await b.click(openPreset);
    assert.equal(await b.value('[data-model-index="0"] .extra-model-main-status'), "检测通过");
    assert.equal(await b.value('.extra-model-unsaved'), null);
  });
}
