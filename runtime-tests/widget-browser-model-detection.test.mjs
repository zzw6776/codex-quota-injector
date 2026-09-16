import assert from "node:assert/strict";
import test from "node:test";
import { ExtraModelManager } from "../src/extra-model-manager.mjs";
import { fixtureData, SHADOW, startBrowser } from "./support/browser.mjs";
import { widgetExtraModelsUpdateExpressionJson } from "../src/widget.mjs";

test("[A UI-02 MOD-03] 逐模型检测失败显示在外层，保存不检测，收起保留编辑状态", { timeout: 30_000 }, async t => {
  const b = await startBrowser(t);
  const probed = [];
  const manager = new ExtraModelManager({ dataDir: b.directory,
    probeModel: async ({ modelId }) => { probed.push(modelId); throw new Error("图片请求连续超时"); },
    fetchImpl: async () => { throw new Error("保存不能发送请求"); },
  });
  const view = await manager.initialize();
  const preset = view.platforms.find(platform => platform.preset === "deepseek");
  await manager.savePlatform({ ...preset, apiKey: "fixture-key", enabled: true });
  await b.update(fixtureData({ extraModels: manager.getViewModel() }));
  await b.click(".quota-chip");
  await b.click(".extra-models-open");
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelectorAll('.extra-model-detect').length`), 0);
  await b.click(".extra-platform-edit");
  await b.fill('[name="apiKey"]', "fixture-key");
  await b.click('[data-model-index="1"] .extra-model-detect');
  const [action] = await b.drain();
  assert.equal(action.type, "extra-model-detect");
  assert.equal(action.modelId, "deepseek-v4-pro");
  await manager.detectModel(action.platform, action.modelId, { requestId: action.requestId });
  await b.update(fixtureData({ extraModels: manager.getViewModel() }));
  assert.deepEqual(probed, ["deepseek-v4-pro"]);
  assert.match(await b.value('[data-model-index="1"] .extra-model-detection-error'), /连续超时/);
  await b.fill('[name="presetContextWindow"][data-model-id="deepseek-v4-pro"]', "256");
  await b.client.evaluate(`(() => {
    window.__savedModelForm = ${SHADOW}.querySelector('.extra-platform-form');
    const panel = ${SHADOW}.querySelector('.panel-scroll');
    panel.scrollTop = panel.scrollHeight;
    window.__savedModelScroll = panel.scrollTop;
  })()`);
  await b.click(".close-panel");
  await b.update(fixtureData({ version: "background-refresh", extraModels: manager.getViewModel() }));
  await b.click(".quota-chip");
  assert.equal(await b.client.evaluate(`window.__savedModelForm === ${SHADOW}.querySelector('.extra-platform-form')`), true);
  assert.equal(await b.value('[name="presetContextWindow"][data-model-id="deepseek-v4-pro"]', "value"), "256");
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelector('.panel-scroll').scrollTop`),
    await b.client.evaluate('window.__savedModelScroll'));
  await b.click('.extra-platform-form button[type="submit"]');
  const [save] = await b.drain();
  assert.equal(save.type, "extra-platform-save");
  await manager.savePlatform(save.platform, { requestId: save.requestId });
  assert.deepEqual(probed, ["deepseek-v4-pro"], "保存不能隐式再检测");
  await b.update(fixtureData({ extraModels: manager.getViewModel() }));
  await b.click(".extra-platform-cancel");
  assert.equal(await b.value('.extra-platform-card [data-model-index="1"] .extra-model-main-status'), "检测失败");
  assert.equal(await b.value('.extra-platform-card .extra-model-detection-error'), null);
  await b.click('.extra-platform-edit');
  assert.match(await b.value('[data-model-index="1"] .extra-model-detection-error'), /连续超时/);
  assert.match(await b.value('[data-model-index="1"] .extra-model-detection-error'), /原配置保留/);
  await b.click('.extra-platform-cancel');
  await b.click(".close-panel");
  await b.click(".quota-chip");
  assert.notEqual(await b.value(".extra-platform-card"), null, "重新打开必须仍在模型管理");
});

test("[A UI-02 MOD-03] 模型状态区分手动与部分可用，检测详情只在设置中显示", { timeout: 30_000 }, async t => {
  const b = await startBrowser(t);
  const manager = new ExtraModelManager({ dataDir: b.directory });
  const view = await manager.initialize();
  const platform = view.platforms.find(item => item.preset === "deepseek");
  platform.models[0].compatibility = { status: "manual", protocol: "responses" };
  platform.models[1].compatibility = {
    status: "verified", protocol: "responses", imageStatus: "inconclusive",
    warnings: ["图片请求连续超时，暂不可用"],
    capabilities: { functionTools: "native", reasoning: "native" },
  };
  await b.update(fixtureData({ extraModels: view }));
  await b.click('.quota-chip');
  await b.click('.extra-models-open');
  assert.equal(await b.value('[data-model-index="0"] .extra-model-main-status'), "手动配置");
  assert.equal(await b.value('[data-model-index="1"] .extra-model-main-status'), "部分可用");
  assert.doesNotMatch(await b.value('.extra-platform-model-status'), /超时|对话和工具/);
  assert.equal(await b.value('.extra-platform-model-status button'), null);
  await b.click('.extra-platform-edit');
  assert.match(await b.value('[data-model-index="0"] .extra-model-status'), /使用你填写的参数/);
  assert.match(await b.value('[data-model-index="1"] .extra-model-status'), /对话和工具可用/);
  assert.match(await b.value('[data-model-index="1"] .extra-model-status'), /图片请求连续超时/);
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelectorAll('.extra-model-detect').length`), 2);
  const progress = { ...view, modelDetections: [{ requestId: "progress-fixture", status: "loading", platformId: platform.id,
    modelId: platform.models[1].id, operation: { state: "loading", phase: "detecting", platformId: platform.id,
    modelId: platform.models[1].id, message: "正在重试图片检测", detail: "第 2 次尝试", step: 2, steps: 8 } }] };
  await b.client.evaluate(widgetExtraModelsUpdateExpressionJson(JSON.stringify(progress), 910));
  assert.equal(await b.value('[data-model-index="1"] .extra-model-main-status'), "检测中…");
  assert.equal(await b.value('[data-model-index="0"] .extra-model-main-status'), "手动配置");
  assert.match(await b.value('[data-model-index="1"] .extra-model-inline-progress'), /第 2 次尝试/);
  assert.equal(await b.value('.extra-model-feedback .extra-model-progress'), null);
  await b.client.evaluate(widgetExtraModelsUpdateExpressionJson(JSON.stringify(view), 911));
  await b.fill('[name="apiKey"]', 'fixture-key');
  await b.click('[data-model-index="1"] .extra-model-detect');
  const [detect] = await b.drain();
  const result = { requestId: detect.requestId, platformId: platform.id,
    modelId: platform.models[1].id, status: "passed", warnings: [],
    model: { ...platform.models[1], compatibility: { status: "verified", protocol: "responses",
      imageStatus: "supported", capabilities: { reasoning: "native" }, warnings: [] } } };
  await b.update(fixtureData({ extraModels: { ...view, modelDetections: [result] } }));
  assert.equal(await b.value('[data-model-index="1"] .extra-model-main-status'), "检测通过");
  assert.equal(await b.value('[data-model-index="1"] .extra-model-unsaved'), "未保存");
  assert.deepEqual(await b.drain(), [], "检测完成不得自动触发保存");
  await b.click('.extra-platform-form button[type="submit"]');
  const [save] = await b.drain();
  assert.equal(save.type, "extra-platform-save");
  await b.update(fixtureData({ extraModels: { ...view, platformSave: { requestId: save.requestId, platformId: platform.id } } }));
  assert.equal(await b.value('[data-model-index="1"] .extra-model-unsaved'), null);
});

test("[A UI-02 MOD-03] 多模型并行进度独立，迟到结果不覆盖手动参数，保存确认不吞掉新结果", { timeout: 30_000 }, async t => {
  const b = await startBrowser(t);
  const manager = new ExtraModelManager({ dataDir: b.directory });
  await manager.initialize();
  const preset = manager.getViewModel().platforms.find(item => item.preset === 'deepseek');
  await manager.savePlatform({ ...preset, apiKey: 'fixture-key', enabled: false });
  const view = manager.getViewModel();
  const platform = view.platforms.find(item => item.id === preset.id);
  await b.update(fixtureData({ extraModels: view }));
  await b.click('.quota-chip');
  await b.click('.extra-models-open');
  await b.click(`.extra-platform-edit[data-platform-id="${platform.id}"]`);
  await b.click('[data-model-index="0"] .extra-model-detect');
  await b.click('[data-model-index="1"] .extra-model-detect');
  const requests = await b.drain();
  assert.equal(requests.length, 2, '第二个检测不能等待第一个结束');
  assert.ok(requests.every(item => item.type === 'extra-model-detect'));
  const loading = requests.map((request, index) => ({ requestId: request.requestId, platformId: platform.id,
    modelId: request.modelId, status: 'loading', operation: { state: 'loading', phase: 'detecting',
      modelId: request.modelId, platformId: platform.id, step: index + 2, steps: 8,
      message: `model ${index}`, detail: `independent ${index}` } }));
  await b.update(fixtureData({ extraModels: { ...view, modelDetections: loading } }));
  assert.match(await b.value('[data-model-index="0"] .extra-model-inline-progress'), /independent 0/);
  assert.match(await b.value('[data-model-index="1"] .extra-model-inline-progress'), /independent 1/);
  assert.equal(await b.value('.extra-platform-form button[type="submit"]', 'disabled'), false);
  // A local edit made after the request must win over its eventual detection result.
  await b.client.evaluate(`${SHADOW}.querySelector('[data-model-index="0"] .extra-model-settings').open = true`);
  if (!await b.value('[data-model-index="0"] [name="supportsReasoning"]', 'checked')) {
    await b.click('[data-model-index="0"] [name="supportsReasoning"]');
  }
  await b.fill('[data-model-index="0"] [name="reasoningEfforts"]', 'low');
  const makeResult = (index) => ({ ...loading[index], status: 'passed', operation: null, warnings: [],
    model: { ...platform.models[index], reasoningEfforts: ['high'], defaultReasoningEffort: 'high',
      compatibility: { status: 'verified', protocol: 'responses', imageStatus: 'supported',
        capabilities: { reasoning: 'native' }, warnings: [] } } });
  const changed = { ...view, modelDetections: [makeResult(0), loading[1]] };
  await b.update(fixtureData({ extraModels: changed }));
  assert.equal(await b.value('[data-model-index="0"] [name="reasoningEfforts"]', 'value'), 'low');
  assert.match(await b.value('[data-model-index="1"] .extra-model-inline-progress'), /independent 1/);
  await b.click('.extra-platform-form button[type="submit"]');
  const [save] = await b.drain();
  assert.equal(save.type, 'extra-platform-save');
  // The second model completes between Save being sent and its acknowledgement.
  await b.update(fixtureData({ extraModels: { ...view, modelDetections: [makeResult(0), makeResult(1)] } }));
  await b.update(fixtureData({ extraModels: { ...view, modelDetections: [makeResult(0), makeResult(1)],
    platformSave: { requestId: save.requestId, platformId: platform.id } } }));
  assert.equal(await b.value('[data-model-index="1"] .extra-model-main-status'), '检测通过');
  assert.equal(await b.value('[data-model-index="1"] .extra-model-unsaved'), '未保存', '旧保存确认不能清除新检测结果的未保存状态');
  await b.click('.extra-platform-form button[type="submit"]');
  const [latest] = await b.drain();
  assert.deepEqual(latest.platform.models[0].reasoningEfforts, ['low']);
  assert.deepEqual(latest.platform.models[1].reasoningEfforts, ['high']);
  assert.equal(await b.value('[data-model-index="0"] .extra-model-inline-progress'), '');
  assert.equal(await b.value('[data-model-index="1"] .extra-model-inline-progress'), '');
});
