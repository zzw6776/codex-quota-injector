import assert from "node:assert/strict";
import test from "node:test";
import { ExtraModelManager } from "../src/extra-model-manager.mjs";
import { MODEL_CAPABILITY_PROBE_VERSION } from "../src/model-capability-probe.mjs";
import { fixtureData, SHADOW, startBrowser } from "./support/browser.mjs";
import { widgetExtraModelsUpdateExpressionJson } from "../src/widget.mjs";

test("[A UI-02 MOD-05] DeepSeek 预设在窄布局只暴露开关、Key 和模型选择", { timeout: 30_000 }, async t => {
  const b = await startBrowser(t);
  const manager = new ExtraModelManager({
    dataDir: b.directory,
    fetchImpl: async () => new Response(JSON.stringify({
      data: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }],
    })),
    probeModel: async () => ({
      status: "verified",
      protocol: "responses",
      historyMode: "reasoning-text-only",
      toolContinuation: true,
      supportsImage: true,
      imageStatus: "supported",
      supportsReasoning: true,
      reasoningEfforts: ["low", "high", "max"],
      capabilities: {
        transport: { responses: "native", chat: "inconclusive" },
        streaming: "native",
        functionTools: "native",
        customTools: "native",
        namespaceTools: "native",
        nativeCustomTools: ["*"],
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
  const initialView = manager.getViewModel();
  initialView.platforms[0].models[0].compatibility = {
    ...initialView.platforms[0].models[0].compatibility,
    status: "pending",
    probeVersion: MODEL_CAPABILITY_PROBE_VERSION - 1,
  };
  await b.update(fixtureData({ extraModels: initialView }));
  await b.click(".quota-chip");
  assert.equal(await b.value(".provider-open"), null,
    "账号页不能再保留独立 DeepSeek 入口");
  await b.click(".extra-models-open");
  assert.match(await b.value(".extra-platform-model-status"), /检测规则已更新/,
    "旧探测结果应说明版本已更新，不能伪装成从未检测");
  await b.click('.extra-platform-edit[data-platform-id="d33f5ee0-0000-4000-8000-000000000001"]');
  assert.equal(await b.value('.preset-platform-form [name="name"]'), null);
  assert.equal(await b.value('.preset-platform-form [name="baseUrl"]'), null);
  assert.equal(await b.value('.preset-platform-form [name="apiKey"]', "placeholder"), "sk-...");
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelectorAll('[name="presetModel"]').length`), 2);
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelectorAll('[name="presetContextWindow"]').length`), 2);
  assert.match(await b.value(".preset-model-count"), /已选 2 \/ 2/);
  assert.match(await b.value(".preset-model-options"), /DeepSeek Flash/);
  assert.match(await b.value(".preset-model-options"), /DeepSeek Pro/);
  await b.fill('[name="presetContextWindow"][data-model-id="deepseek-flash"]', "1024");
  await b.fill('.preset-platform-form [name="apiKey"]', "fixture-deepseek-key");
  await b.click(".preset-model-refresh");
  const [refreshAction] = await b.drain();
  assert.equal(refreshAction.type, "extra-platform-models-refresh");
  assert.equal(refreshAction.platform.apiKey, "fixture-deepseek-key");
  assert.equal(refreshAction.platform.models.find((model) => model.id === "deepseek-flash").contextWindow, 1_024_000);
  await manager.refreshPresetModels(refreshAction.platform);
  await b.update(fixtureData({ extraModels: manager.getViewModel() }));
  assert.equal(await b.value('.preset-platform-form [name="apiKey"]', "value"),
    "fixture-deepseek-key", "读取模型后的状态更新必须保留 Key 草稿");
  await b.click('.preset-platform-form [name="enabled"]');
  await b.click('.preset-platform-form button[type="submit"]');
  const [action] = await b.drain();
  assert.equal(action.type, "extra-platform-save");
  assert.equal(action.platform.preset, "deepseek");
  assert.equal(action.platform.baseUrl, "https://api.deepseek.com/");
  assert.equal(action.platform.models.find((model) => model.id === "deepseek-flash").selected, true);
});

test("[A UI-02 MOD-03] 模型发现与其他状态一起更新时也必须更新下拉列表并保留表单", { timeout: 30_000 }, async t => {
  const b = await startBrowser(t);
  const manager = new ExtraModelManager({ dataDir: b.directory });
  const view = await manager.initialize();
  const preset = view.platforms.find(platform => platform.preset === "deepseek");
  const discoveredModels = structuredClone(preset.models);
  preset.models = preset.models.slice(0, 1);
  await b.update(fixtureData({ extraModels: view }));
  await b.click(".quota-chip");
  await b.click(".extra-models-open");
  await b.click(`.extra-platform-edit[data-platform-id="${preset.id}"]`);
  await b.fill('[name="apiKey"]', "draft-fixture-key");
  await b.client.evaluate(`window.__modelForm = ${SHADOW}.querySelector('.extra-platform-form')`);
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelectorAll('[name="presetModel"]').length`), 1);
  await b.update(fixtureData({
    windows: [{ label: "5h", remainingPercent: 64 }],
    extraModels: { ...view, modelDiscovery: { revision: 1, platformId: preset.id,
      models: discoveredModels, modelsUpdatedAt: 1234 } },
  }));
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelectorAll('[name="presetModel"]').length`), 2);
  assert.equal(await b.client.evaluate(`window.__modelForm === ${SHADOW}.querySelector('.extra-platform-form')`), true);
  assert.equal(await b.value('[name="apiKey"]', "value"), "draft-fixture-key");
  await b.click('.preset-platform-form button[type="submit"]');
  const [action] = await b.drain();
  assert.deepEqual(action.platform.models.map(model => model.id), discoveredModels.map(model => model.id));
  assert.ok(action.platform.models.every(model => model.selected));
});

test("[A UI-02 MOD-05] DeepSeek 余额位于模型卡片内且异步刷新不移动底部汇总栏", { timeout: 30_000 }, async t => {
  const b = await startBrowser(t);
  const manager = new ExtraModelManager({ dataDir: b.directory });
  const initial = await manager.initialize();
  const preset = initial.platforms.find((platform) => platform.preset === "deepseek");
  const configured = {
    ...initial,
    platforms: initial.platforms.map((platform) => platform.id === preset.id
      ? {
          ...platform,
          apiKey: "managed-fixture-key",
          models: platform.models.map((model) => model.id === "deepseek-v4-pro"
            ? {
                ...model,
                compatibility: {
                  status: "verified",
                  protocol: "responses",
                  historyMode: "reasoning-text-only",
                  toolContinuation: true,
                  supportsImage: false,
                  imageStatus: "unsupported",
                  imageDetail: null,
                  checkedAt: 1234,
                  probeVersion: MODEL_CAPABILITY_PROBE_VERSION,
                },
              }
            : model),
        }
      : platform),
    deepSeekBalance: {
      balance: {
        available: true,
        items: [{
          currency: "CNY",
          totalBalance: "9.49",
          grantedBalance: "0.50",
          toppedUpBalance: "8.99",
        }],
      },
      updatedAt: Date.UTC(2026, 8, 14, 8, 0, 0),
      error: null,
      refreshing: false,
    },
  };
  await b.update(fixtureData({ extraModels: configured }));
  await b.client.evaluate('document.documentElement.className = "electron-light"');
  await b.click(".quota-chip");
  assert.match(await b.value(".panel-balance"), /DeepSeek 余额 CNY 9\.49/);
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelector('.panel-scroll > .panel-version:last-child') != null`), true,
    "窗口底部汇总栏必须保持为滚动内容的最后一项");

  await b.click(".extra-models-open");
  const cardSelector = `.extra-platform-card[data-platform-id="${preset.id}"]`;
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelector(${JSON.stringify(cardSelector)}).contains(${SHADOW}.querySelector('.managed-deepseek-balance'))`), true,
    "余额明细必须位于 DeepSeek 卡片内部");
  assert.match(await b.value(`${cardSelector} .managed-deepseek-balance`), /账户余额 · 账户可用/);
  assert.match(await b.value(`${cardSelector} .managed-deepseek-balance`), /赠送余额 0\.50 · 充值余额 8\.99/);
  assert.deepEqual(await b.client.evaluate(`(() => {
    const card = ${SHADOW}.querySelector(${JSON.stringify(`${cardSelector} .balance-card`)});
    const style = getComputedStyle(card);
    return {
      display: style.display,
      whiteSpace: style.whiteSpace,
      fontSizes: [...card.children].map((item) => getComputedStyle(item).fontSize),
    };
  })()`), { display: "flex", whiteSpace: "nowrap", fontSizes: ["10px", "10px", "10px"] },
  "币种、总额和余额明细必须使用相同小字号在一行展示");
  const unsupportedStyle = await b.client.evaluate(`(() => {
    const unsupported = [...${SHADOW}.querySelectorAll(${JSON.stringify(`${cardSelector} .extra-model-capabilities .badge`)})]
      .find((item) => item.textContent.trim() === "不支持图片");
    const platformCount = ${SHADOW}.querySelector('.provider-status > .badge');
    return {
      text: unsupported?.textContent ?? null,
      className: unsupported?.className ?? null,
      background: unsupported ? getComputedStyle(unsupported).backgroundColor : null,
      platformBackground: platformCount ? getComputedStyle(platformCount).backgroundColor : null,
    };
  })()`);
  assert.deepEqual(unsupportedStyle, {
    text: "不支持图片",
    className: "badge",
    background: "rgba(0, 0, 0, 0.055)",
    platformBackground: "rgba(0, 0, 0, 0.055)",
  }, "不支持图片必须使用与平台数量相同的普通灰色徽标背景");
  const cardButtonSizes = await b.client.evaluate(`(() => ({
    outerHeight: ${SHADOW}.querySelector('.extra-platform-add').getBoundingClientRect().height,
    buttons: [...${SHADOW}.querySelectorAll(${JSON.stringify(`${cardSelector} .btn`)})].map((button) => ({
      text: button.textContent.trim(),
      height: button.getBoundingClientRect().height,
      fontSize: getComputedStyle(button).fontSize,
      paddingBlock: getComputedStyle(button).paddingBlock,
    })),
  }))()`);
  assert.deepEqual(cardButtonSizes.buttons.map((button) => button.text), ["设置", "查询余额"],
    "DeepSeek 卡片提供设置和余额查询，模型检测在设置页执行");
  assert.ok(cardButtonSizes.buttons.every((button) =>
    button.height < cardButtonSizes.outerHeight &&
    button.fontSize === "10px" &&
    button.paddingBlock === "2px"),
  `卡片内按钮必须统一缩小：${JSON.stringify(cardButtonSizes)}`);
  await b.click(`${cardSelector} .extra-deepseek-refresh-balance`);
  assert.equal((await b.drain())[0].type, "extra-deepseek-refresh-balance");

  await b.client.evaluate(`window.__deepSeekCard=${SHADOW}.querySelector(${JSON.stringify(cardSelector)})`);
  const refreshing = {
    ...configured,
    deepSeekBalance: {
      ...configured.deepSeekBalance,
      balance: {
        available: true,
        items: [{
          currency: "CNY",
          totalBalance: "8.88",
          grantedBalance: "0.00",
          toppedUpBalance: "8.88",
        }],
      },
      refreshing: true,
    },
  };
  await b.client.evaluate(widgetExtraModelsUpdateExpressionJson(JSON.stringify(refreshing), 903));
  assert.equal(await b.client.evaluate(`window.__deepSeekCard === ${SHADOW}.querySelector(${JSON.stringify(cardSelector)})`), true,
    "余额刷新只能替换余额区，不能重绘 DeepSeek 卡片");
  assert.equal(await b.value(`${cardSelector} .extra-deepseek-refresh-balance`), "查询中");
  assert.match(await b.value(".panel-balance"), /DeepSeek 余额 CNY 8\.88/);

  await b.click(".extra-models-back");
  const completed = {
    ...refreshing,
    deepSeekBalance: {
      ...refreshing.deepSeekBalance,
      balance: {
        available: true,
        items: [{
          currency: "CNY",
          totalBalance: "7.77",
          grantedBalance: "0.00",
          toppedUpBalance: "7.77",
        }],
      },
      refreshing: false,
    },
  };
  await b.client.evaluate(widgetExtraModelsUpdateExpressionJson(JSON.stringify(completed), 904));
  assert.match(await b.value(".panel-balance"), /DeepSeek 余额 CNY 7\.77/,
    "停留在账号页时余额更新也只能更新底部汇总文字");
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelector('.panel-scroll > .panel-version:last-child') != null`), true);
});
