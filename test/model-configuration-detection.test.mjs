import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { useTempDir } from "./helpers.mjs";
import { customPlatform, extraModelManager, detectedCompatibility, detectAndSave, baseCatalog } from "./model-configuration/support.mjs";

test("保存后的检测错误不会清除尚未生效的模型配置状态", async (t) => {
  const dataDir = await useTempDir(t);
  const manager = extraModelManager(dataDir);
  await manager.initialize();
  manager.setError("首次检测失败");
  assert.equal(manager.getViewModel().pendingRestart, false);
  await manager.savePlatform(customPlatform());
  const saved = await readFile(manager.settingsPath, "utf8");
  manager.setError("重新检测超时");
  assert.equal(manager.getViewModel().pendingRestart, true);
  assert.equal(manager.getViewModel().messageState, "error");
  assert.equal(await readFile(manager.settingsPath, "utf8"), saved);
  assert.equal(manager.markRestarted().pendingRestart, false);
});

test("逐模型检测填回参数后单独保存，保存和修改目标不隐式检测", async (t) => {
  const dataDir = await useTempDir(t);
  const probes = [];
  const operations = [];
  const manager = extraModelManager(dataDir, {
    probeModel: async (target) => {
      probes.push({ baseUrl: target.baseUrl, apiKey: target.apiKey, modelId: target.modelId });
      target.onProgress?.({
        current: 1,
        total: 8,
        stage: "responses",
        message: "正在验证 Responses 连接与工具续接",
        retry: false,
      });
      target.onProgress?.({
        current: 4,
        total: 8,
        stage: "reasoning",
        message: "正在检测推理强度 high",
        retry: false,
      });
      return detectedCompatibility({
        protocol: probes.length === 1 ? "responses" : "chat",
        routes: probes.length === 1
          ? { default: "responses", imageInput: "chat" }
          : { default: "chat", imageInput: "chat" },
        historyMode: probes.length === 1 ? "reasoning-text-only" : "chat",
        supportsImage: probes.length === 1,
        imageStatus: probes.length === 1 ? "supported" : "unsupported",
        capabilities: probes.length === 1
          ? { imageInput: "bridged", transport: { responses: "native", chat: "native" } }
          : {},
      });
    },
  });
  manager.onChange((view) => {
    if (view.operation) operations.push(view.operation);
    operations.push(...view.modelDetections.map(item => item.operation).filter(Boolean));
  });
  await manager.initialize();
  const first = await detectAndSave(manager, customPlatform());
  const platform = first.platforms.find((item) => item.name === "Local Provider");
  assert.equal(platform.models[0].compatibility.historyMode, "reasoning-text-only");
  assert.equal(platform.models[0].compatibility.supportsImage, true);
  assert.deepEqual(platform.models[0].compatibility.routes, {
    default: "responses",
    imageInput: "chat",
  });
  assert.deepEqual(platform.models[0].compatibility.capabilities.nativeCustomTools, ["*"]);
  assert.deepEqual(platform.models[0].reasoningEfforts, ["low", "high", "max"]);
  assert.equal(platform.models[0].defaultReasoningEffort, "high");
  assert.equal(probes.length, 1);
  assert.ok(operations.some((operation) => operation.phase === "detecting" && operation.current === 1 && operation.total === 1));
  assert.ok(operations.some((operation) =>
    operation.probeStage === "reasoning" &&
    operation.step === 4 &&
    operation.steps === 8 &&
    operation.detail === "正在检测推理强度 high"));
  assert.ok(operations.some((operation) => operation.phase === "saving"));

  await manager.savePlatform(platform);
  assert.equal(probes.length, 1, "目标未变化时必须复用检测结果，避免重复消耗 Token");
  const changed = {
    ...platform,
    apiKey: "replacement-key",
    models: platform.models.map((model) => ({ ...model, compatibility: { ...model.compatibility } })),
  };
  const unverified = await manager.savePlatform(changed);
  assert.equal(probes.length, 1, "修改 Key 后保存也不得隐式检测");
  assert.equal(unverified.platforms.find(item => item.id === platform.id).models[0].compatibility.status, "manual");
  const second = await detectAndSave(manager, changed);
  assert.equal(probes.length, 2);
  const secondPlatform = second.platforms.find((item) => item.name === "Local Provider");
  assert.equal(secondPlatform.models[0].compatibility.protocol, "chat");
  assert.equal(secondPlatform.models[0].compatibility.supportsImage, false);
  assert.deepEqual(secondPlatform.models[0].compatibility.capabilities.nativeCustomTools, []);
  assert.deepEqual(secondPlatform.models[0].reasoningEfforts, ["low", "high", "max"]);

  await manager.detectModel(secondPlatform, secondPlatform.models[0].id);
  assert.equal(probes.length, 3, "用户重新检测必须忽略缓存");
});

test("DeepSeek 预设实时读取官方模型并只检测和发布用户选中的模型", async (t) => {
  const dataDir = await useTempDir(t);
  const requests = [];
  const probes = [];
  const manager = extraModelManager(dataDir, {
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), authorization: options.headers.Authorization });
      return new Response(JSON.stringify({
        object: "list",
        data: [
          { id: "deepseek-flash", object: "model", owned_by: "deepseek" },
          { id: "deepseek-v4-flash", object: "model", owned_by: "deepseek" },
          { id: "deepseek-v4-flash-vision-exp", object: "model", owned_by: "deepseek" },
          { id: "deepseek-v4-pro", object: "model", owned_by: "deepseek" },
        ],
      }));
    },
    probeModel: async ({ modelId }) => {
      probes.push(modelId);
      return detectedCompatibility(modelId === "deepseek-v4-pro"
        ? { supportsImage: false, imageStatus: "unsupported" }
        : {
            supportsImage: true,
            imageStatus: "supported",
            capabilities: {
              hostedTools: { web_search: "unsupported" },
              functionTools: "native",
              parallelTools: "native",
            },
          });
    },
  });
  const initial = await manager.initialize();
  const preset = initial.platforms.find((platform) => platform.preset === "deepseek");
  assert.equal(preset.baseUrl, "https://api.deepseek.com/");
  assert.equal(preset.enabled, false);
  assert.equal(preset.models.length, 2);
  assert.equal(preset.models[0].id, "deepseek-flash");
  assert.equal(preset.models[0].displayName, "DeepSeek Flash");
  assert.equal(preset.models[0].documentedSupportsImage, true);
  assert.equal(preset.models[1].id, "deepseek-v4-pro");
  assert.equal(preset.models[1].displayName, "DeepSeek Pro");
  assert.equal(preset.models[1].documentedSupportsImage, false);

  const configuredPreset = {
    ...preset,
    apiKey: "ds-live-key",
    models: preset.models.map((model) => ({
      ...model,
      selected: model.id === "deepseek-flash",
    })),
  };
  const discovered = await manager.refreshPresetModels(configuredPreset);
  assert.deepEqual(discovered.modelDiscovery.models.map((model) => model.id), [
    "deepseek-flash",
    "deepseek-v4-pro",
  ]);
  assert.deepEqual(probes, [], "读取模型列表本身不得发送推理请求或消耗模型 Token");
  const saved = await detectAndSave(manager, { ...configuredPreset, enabled: true });
  const enabledPreset = saved.platforms.find((platform) => platform.preset === "deepseek");
  assert.deepEqual(enabledPreset.models.map((model) => [model.id, model.selected]), [
    ["deepseek-flash", true],
    ["deepseek-v4-pro", false],
  ]);
  assert.deepEqual(probes, ["deepseek-flash"]);
  assert.deepEqual(requests.map((request) => request.url), [
    "https://api.deepseek.com/models",
  ]);
  assert.ok(requests.every((request) => request.authorization === "Bearer ds-live-key"));

  const runtime = await manager.writeRuntimeCatalog(baseCatalog());
  const deepseek = runtime.catalog.models.find((model) => model.slug === "deepseek-flash");
  assert.ok(deepseek);
  assert.equal(deepseek.priority, 8);
  assert.equal(deepseek.supports_parallel_tool_calls, true);
  assert.equal(deepseek.tool_mode, null);
  assert.equal(deepseek.supports_search_tool, false);
  assert.equal(deepseek.display_name, "DeepSeek Flash");
  assert.deepEqual(deepseek.input_modalities, ["text", "image"]);
  assert.equal(runtime.catalog.models.some((model) => model.slug === "deepseek-v4-pro"), false,
    "未选择的 Pro 只保留在平台配置中，不能进入本次运行时目录");
  assert.ok(runtime.generation.length >= 32);
  await assert.rejects(manager.removePlatform(preset.id), /预设不能删除/);
});

test("保存手动参数不联网；逐模型失败持久展示且不阻止保存其他模型", async t => {
  const dataDir = await useTempDir(t);
  const requests = [];
  const manager = extraModelManager(dataDir, {
    fetchImpl: async () => { throw new Error("保存不能联网"); },
    probeModel: async ({ modelId }) => {
      requests.push(modelId);
      if (modelId === "broken") throw new Error("图片能力检测超时 secret");
      return detectedCompatibility();
    },
  });
  await manager.initialize();
  const input = customPlatform({ models: [
    { id: "broken", contextWindow: 64000, reasoningEfforts: [], compatibility: {
      status: "manual", protocol: "chat", historyMode: "chat", supportsImage: false,
      capabilities: { customTools: "bridged", namespaceTools: "bridged" } } },
    { id: "working", contextWindow: 128000 },
  ] });
  const saved = await manager.savePlatform(input);
  assert.deepEqual(requests, []);
  const platform = saved.platforms.find(item => item.name === "Local Provider");
  const before = structuredClone(manager.settings.platforms);
  manager.markRestarted();
  const failed = await manager.detectModel(platform, "broken", { requestId: "failure-request" });
  assert.equal(failed.modelDetections.find(item => item.requestId === "failure-request").requestId, "failure-request");
  assert.equal(failed.modelDetections.find(item => item.requestId === "failure-request").status, "failed");
  assert.match(failed.platforms.find(item => item.id === platform.id).models[0].lastDetection.message, /超时/);
  assert.ok(!failed.modelDetections.find(item => item.requestId === "failure-request").message.includes("secret"));
  assert.deepEqual(manager.settings.platforms, before, "检测不能保存或改写模型参数");
  assert.equal(failed.pendingRestart, false);
  const result = await manager.detectModel(platform, "working");
  assert.equal(result.modelDetections.find(item => item.modelId === "working").status, "passed");
  assert.deepEqual(requests, ["broken", "working"], "每次只检测指定模型");
  assert.deepEqual(manager.settings.platforms, before, "成功也要等待用户保存");
  const reloaded = extraModelManager(dataDir);
  const restored = (await reloaded.initialize()).platforms.find(item => item.id === platform.id);
  assert.equal(restored.models[0].lastDetection.status, "failed", "重启后外层仍能显示失败");
  assert.equal(restored.models[0].compatibility.status, "manual");
  const runtime = await reloaded.writeRuntimeCatalog(baseCatalog());
  assert.deepEqual(runtime.catalog.models.find(item => item.slug === "broken").input_modalities, ["text"]);
  await reloaded.savePlatform({ ...restored, models: restored.models.map(model =>
    model.id === "working" ? result.modelDetections.find(item => item.modelId === "working").model : model) });
  assert.equal(reloaded.settings.platforms.find(item => item.id === platform.id).models[1].compatibility.status, "verified");
});
