import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { CodexContextManager } from "../src/codex-context.mjs";
import { ExtraModelManager } from "../src/extra-model-manager.mjs";
import { MODEL_CAPABILITY_PROBE_VERSION } from "../src/model-capability-probe.mjs";
import { widgetInstallExpression, WIDGET_RUNTIME_VERSION,
  widgetExtraModelsUpdateExpressionJson, widgetTokenUsageDeltaUpdateExpressionJson,
  widgetTokenUsageUpdateExpressionJson } from "../src/widget.mjs";
import { fixtureData, SHADOW, startBrowser } from "./support/browser.mjs";

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

test("[A UI-02 ACC-01 ACC-02 ACC-05] 页面刷新、迁移、恢复、导入和授权取消产生唯一且完整的动作", { timeout: 30_000 }, async t => {
  const b = await startBrowser(t);
  await b.click(".quota-chip");
  for (const [selector, type] of [[".refresh-all", "refresh-all"], [".local-import", "local-import"], [".oauth-add", "oauth-add"]]) {
    await b.click(selector);
    const [action, ...extra] = await b.drain();
    assert.equal(action.type, type);
    assert.ok(action.id);
    assert.deepEqual(extra, []);
    assert.deepEqual(await b.drain(), []);
  }
  await b.click(".migration-open");
  assert.match(await b.value(".provider-note"), /access token 和 refresh token 都写回本机加密账户库/);
  await b.click('.migration-form button[type="submit"]');
  const [temporary] = await b.drain();
  assert.equal(temporary.type, "account-transfer");
  assert.equal(temporary.mode, "temporary");
  assert.deepEqual(temporary.accountIds, ["account-1"]);
  await b.click('.migration-mode[value="handoff"]');
  await b.client.evaluate("window.confirm=()=>true");
  await b.click('.migration-form button[type="submit"]');
  const [handoff] = await b.drain();
  assert.equal(handoff.type, "account-transfer");
  assert.equal(handoff.mode, "handoff");
  assert.deepEqual(handoff.accountIds, ["account-1"]);
  await b.click(".migration-back");
  await b.update(fixtureData({
    currentAccountId: null,
    accounts: [{ ...fixtureData().accounts[0], current: false, authStatus: "transferred",
      transferredAt: Date.now(), canTransfer: false, canTemporaryTransfer: false }],
  }));
  await b.client.evaluate("window.confirmMessages=[];window.confirm=message=>{confirmMessages.push(message);return false}");
  await b.click(".restore-transferred");
  assert.deepEqual(await b.drain(), []);
  assert.match(await b.client.evaluate("confirmMessages[0]"), /新设备已经停止使用/);
  assert.match(await b.client.evaluate("confirmMessages[0]"), /可能使新设备登录失效/);
  await b.client.evaluate("window.confirm=()=>true");
  await b.click(".restore-transferred");
  assert.equal((await b.drain())[0].type, "restore-transferred");
  await b.click("details:has(.token-form) > summary");
  await b.fill('.token-form [name="token"]', '{"fake":"凭据材料"}');
  await b.click('.token-form button[type="submit"]');
  assert.equal((await b.drain())[0].token, '{"fake":"凭据材料"}');
  await b.click("details:has(.api-key-form) > summary");
  await b.fill('.api-key-form [name="name"]', "测试账号");
  await b.fill('.api-key-form [name="apiKey"]', "sk-offline-fixture");
  await b.click('.api-key-form button[type="submit"]');
  const [added] = await b.drain();
  assert.equal(added.type, "api-key-add");
  assert.equal(added.name, "测试账号");
  assert.equal(added.apiKey, "sk-offline-fixture");
  await b.update(fixtureData({ operation: { state: "loading", cancellable: "oauth", message: "等待测试授权" } }));
  assert.equal(await b.value(".refresh-all", "disabled"), true);
  await b.click(".oauth-cancel");
  assert.equal((await b.drain())[0].type, "oauth-cancel");
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
  assert.equal(await b.value('[name="supportsImage"]'), null);
  assert.equal(await b.value('[name="chatCompatibility"]'), null);
  assert.match(await b.value(".extra-model-capabilities"), /待检测/);
  assert.match(await b.value(".extra-model-reasoning"), /自动检测/);
  assert.equal(await b.value('[name="contextWindow"]', "value"), "128");
  await b.fill('[name="contextWindow"]', "256");
  await b.click(".extra-model-add");
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelectorAll('.extra-model-row').length`), 2);
  await b.click('.extra-model-row[data-model-index="1"] .extra-model-remove');
  await b.click('.extra-platform-form button[type="submit"]');
  const [action] = await b.drain();
  assert.equal(action.type, "extra-platform-save");
  assert.equal(action.platform.models[0].contextWindow, 256_000);
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
  await manager.savePlatform(action.platform);
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
  assert.match(await b.value(".pending-restart"), /等待重启生效/);
  await b.click(".extra-platform-cancel");
  assert.equal(await b.value(".extra-platform-form"), null);
  assert.deepEqual(await b.drain(), []);
  const platformStatus = `.extra-platform-card[data-platform-id="${platform.id}"] .extra-platform-model-status`;
  assert.match(await b.value(platformStatus), /Responses/);
  assert.match(await b.value(platformStatus), /工具已自动适配/);
  assert.match(await b.value(platformStatus), /推理：支持/);
  assert.match(await b.value(platformStatus), /推理强度：low \/ high \/ max（实测接受）/);
  assert.match(await b.value(platformStatus), /内置联网不可用/);
  assert.match(await b.value(platformStatus), /支持图片/);
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
    operation: {
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
    },
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
  const failedView = { ...progressView, operation: null, messageState: "error", message: "fixture 检测失败" };
  await b.client.evaluate(widgetExtraModelsUpdateExpressionJson(JSON.stringify(failedView), 902));
  assert.equal(await b.client.evaluate(`window.__extraModelCard === ${SHADOW}.querySelector('.extra-platform-card[data-platform-id="${platform.id}"]')`), true);
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelector('.panel-scroll').scrollTop`), originalCard.scrollTop);
  assert.match(await b.value(".extra-model-feedback"), /fixture 检测失败/);
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelector('.extra-platform-detect[data-platform-id="${platform.id}"]').disabled`), false,
    "存在待重启配置时仍必须允许继续检测");
  await b.click(`.extra-platform-detect[data-platform-id="${platform.id}"]`);
  assert.equal((await b.drain())[0].type, "extra-platform-detect");
});

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
  assert.match(await b.value(".extra-platform-model-status"), /检测规则已更新 · 需重新检测/,
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
  assert.ok(cardButtonSizes.buttons.length >= 3);
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

test("[A UI-03 UI-04 OBS-01 OBS-03] 页面大小、长列表、主题、任务切换和用量增量不串到另一任务", { timeout: 30_000 }, async t => {
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

test("[A UI-04] 请求明细按实际滚动条宽度补齐右侧间距", { timeout: 30_000 }, async t => {
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

test("[A UI-03] 二级页面继承主窗口尺寸、可临时拖大且返回后不保存", { timeout: 30_000 }, async t => {
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
