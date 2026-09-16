import assert from "node:assert/strict";
import test from "node:test";
import { ExtraModelManager } from "../src/extra-model-manager.mjs";
import { MODEL_CAPABILITY_PROBE_VERSION } from "../src/model-capability-probe.mjs";
import { widgetExtraModelsUpdateExpressionJson } from "../src/widget.mjs";
import { fixtureData, SHADOW, startBrowser } from "./support/browser.mjs";

test("[A UI-02 MOD-03 MOD-04] 页面平台配置的输入、能力、增删模型、取消和保存均使用真实 DOM", { timeout: 30_000 }, async t => {
  const b = await startBrowser(t);
  await b.click(".quota-chip");
  await b.click(".extra-models-open");
  await b.click(".extra-platform-add");
  await b.fill('.extra-platform-form [name="name"]', "本地平台");
  await b.fill('[name="baseUrl"]', "http://127.0.0.1:1/v1");
  await b.fill('.extra-platform-form [name="apiKey"]', "fixture-key");
  await b.fill('[name="modelId"]', "fixture-extra");
  await b.fill('[name="displayName"]', "测试模型");
  assert.notEqual(await b.value('[name="supportsImage"]'), null);
  assert.equal(await b.value('[name="chatCompatibility"]'), null);
  assert.match(await b.value(".extra-model-capabilities"), /未检测/);
  assert.match(await b.value(".extra-model-reasoning"), /手动配置/);
  assert.equal(await b.value('[name="contextWindow"]', "value"), "128");
  await b.fill('[name="contextWindow"]', "256");
  await b.click(".extra-model-add");
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelectorAll('.extra-model-row').length`), 2);
  await b.click('.extra-model-row[data-model-index="1"] .extra-model-remove');
  await b.click('.extra-platform-form button[type="submit"]');
  const [action] = await b.drain();
  assert.equal(action.type, "extra-platform-save");
  assert.equal(action.platform.models[0].contextWindow, 256_000);
  assert.equal(action.platform.models[0].compatibility.status, "manual", "未检测时直接保存默认参数应标为手动配置");
  const manager = new ExtraModelManager({
    dataDir: b.directory,
    now: () => 1234,
    probeModel: async () => ({
      status: "verified",
      protocol: "responses",
      historyMode: "reasoning-text-only",
      toolContinuation: true,
      supportsImage: true,
      imageStatus: "supported",
      imageDetail: null,
      supportsReasoning: true,
      reasoningEfforts: ["low", "high", "max"],
      capabilities: {
        transport: { responses: "native", chat: "inconclusive" },
        streaming: "native",
        functionTools: "native",
        customTools: "bridged",
        namespaceTools: "bridged",
        nativeCustomTools: ["apply_patch"],
        parallelTools: "native",
        toolChoice: "native",
        reasoning: "native",
        reasoningToolChoice: "native",
        reasoningHistory: "bridged",
        imageInput: "native",
        hostedTools: { web_search: "unsupported" },
      },
      codexConformance: "passed",
      checkedAt: 1234,
      probeVersion: MODEL_CAPABILITY_PROBE_VERSION,
    }),
  });
  await manager.initialize();
  const detected = await manager.detectModel(action.platform, action.platform.models[0].id);
  await manager.savePlatform({ ...action.platform, models: [detected.modelDetections.find(item => item.modelId === action.platform.models[0].id).model] }, { requestId: action.requestId });
  assert.equal(manager.getViewModel().pendingRestart, true);
  assert.match(manager.getViewModel().message, /等待重启 Codex 后生效/);
  const platform = manager.getViewModel().platforms.find((item) => item.name === "本地平台");
  assert.equal(platform.name, "本地平台");
  assert.equal(platform.models[0].compatibility.supportsImage, true);
  assert.equal(platform.models[0].compatibility.protocol, "responses");
  assert.deepEqual(platform.models[0].reasoningEfforts, ["low", "high", "max"]);
  assert.equal(platform.models[0].defaultReasoningEffort, "high");
  await b.update(fixtureData({ extraModels: manager.getViewModel() }));
  assert.equal(await b.value(".extra-platform-form") == null, false,
    "保存结果回传时必须保留正在查看的配置表单");
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelector('.extra-platform-form').dataset.platformId`), platform.id,
    "新平台首次保存后必须绑定服务器分配的 ID，后续保存不能重复添加");
  assert.match(await b.value(".pending-restart"), /等待重启生效/);
  await b.click(".extra-platform-cancel");
  assert.equal(await b.value(".extra-platform-form"), null);
  assert.deepEqual(await b.drain(), []);
  const platformStatus = `.extra-platform-card[data-platform-id="${platform.id}"] .extra-platform-model-status`;
  assert.match(await b.value(platformStatus), /检测通过/);
  for (const parameter of [/Responses/, /工具已自动适配/, /推理：支持/,
    /推理强度：low \/ high \/ max（实测接受）/, /内置联网不可用/, /支持图片/]) {
    assert.match(await b.value(platformStatus), parameter, "外层检测状态不能取代已有参数展示");
  }
  assert.equal(await b.value(`${platformStatus} .extra-model-detect`), null);
  const originalCard = await b.client.evaluate(`(() => {
    const card = ${SHADOW}.querySelector('.extra-platform-card[data-platform-id="${platform.id}"]');
    const scroller = ${SHADOW}.querySelector('.panel-scroll');
    const spacer = document.createElement('div');
    spacer.style.height = '600px';
    ${SHADOW}.querySelector('.extra-platform-list').append(spacer);
    window.__extraModelCard = card;
    scroller.scrollTop = scroller.scrollHeight;
    return { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight };
  })()`);
  assert.ok(originalCard.scrollTop > 0, "测试必须先建立真实滚动位置");
  const progressView = {
    ...manager.getViewModel(),
    modelDetections: [{ requestId: "progress-only", status: "loading", platformId: platform.id,
      modelId: "fixture-extra", operation: {
      state: "loading",
      phase: "detecting",
      platformId: platform.id,
      current: 1,
      total: 1,
      modelId: "fixture-extra",
      message: "正在检测 测试模型（1/1）",
      detail: "正在检测推理强度 high",
      step: 4,
      steps: 8,
      probeStage: "reasoning",
      retry: false,
    } }],
  };
  await b.client.evaluate(widgetExtraModelsUpdateExpressionJson(JSON.stringify(progressView), 901));
  assert.equal(await b.client.evaluate(`window.__extraModelCard === ${SHADOW}.querySelector('.extra-platform-card[data-platform-id="${platform.id}"]')`), true,
    "检测状态更新必须复用平台卡片 DOM，不能重绘整个 Widget");
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelector('.panel-scroll').scrollTop`), originalCard.scrollTop);
  assert.match(await b.value(`.extra-platform-card[data-platform-id="${platform.id}"] .extra-platform-progress`), /正在检测 测试模型（1\/1）/);
  assert.match(await b.value(`.extra-platform-card[data-platform-id="${platform.id}"] .extra-model-progress-detail`), /4\/8 · 正在检测推理强度 high/);
  assert.equal(await b.value(`.extra-platform-card[data-platform-id="${platform.id}"] .extra-model-progress-percent`), "50%");
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelector('.extra-platform-card[data-platform-id="${platform.id}"] .extra-model-progress-track i').style.width`), "50%");
  await b.update(fixtureData({ version: "background-update", extraModels: progressView }));
  assert.equal(await b.client.evaluate(`window.__extraModelCard === ${SHADOW}.querySelector('.extra-platform-card[data-platform-id="${platform.id}"]')`), true,
    "检测期间即使收到完整后台数据，也不能重绘模型管理页面");
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelector('.panel-scroll').scrollTop`), originalCard.scrollTop);
  const failedView = { ...progressView, modelDetections: [], operation: null, messageState: "error", message: "fixture 检测失败" };
  await b.client.evaluate(widgetExtraModelsUpdateExpressionJson(JSON.stringify(failedView), 902));
  assert.equal(await b.client.evaluate(`window.__extraModelCard === ${SHADOW}.querySelector('.extra-platform-card[data-platform-id="${platform.id}"]')`), true);
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelector('.panel-scroll').scrollTop`), originalCard.scrollTop);
  assert.match(await b.value(".extra-model-feedback"), /fixture 检测失败/);
  await b.click(`.extra-platform-edit[data-platform-id="${platform.id}"]`);
  assert.match(await b.value('.extra-platform-form .extra-model-status'), /参数由检测自动填写/);
  assert.match(await b.value('.extra-platform-form .extra-model-capabilities'), /检测通过/);
  assert.match(await b.value('.extra-platform-form .extra-model-status'), /支持图片/);
  const detectButton = '.extra-platform-form .extra-model-detect';
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelector('${detectButton}').disabled`), false,
    "存在待重启配置时仍必须允许继续检测");
  await b.click(detectButton);
  const [detect] = await b.drain();
  assert.equal(detect.type, "extra-model-detect");
  assert.equal(detect.modelId, "fixture-extra");

});
