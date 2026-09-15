import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { CodexContextManager } from "../src/codex-context.mjs";
import { selectBridgeMode } from "../src/codex-bridge.mjs";
import { ExtraModelManager } from "../src/extra-model-manager.mjs";
import { MODEL_CAPABILITY_PROBE_VERSION } from "../src/model-capability-probe.mjs";
import { fetchOfficialModelCatalog } from "../src/official-model-catalog.mjs";
import { useTempDir } from "./helpers.mjs";

const execFileAsync = promisify(execFile);
const PLATFORM_ID = "123e4567-e89b-42d3-a456-426614174010";

test("[platform:macos-native] macOS 仅在模型目录需要注入时接管", () => {
  assert.equal(selectBridgeMode({
    platform: "darwin",
    staticModelCatalog: false,
    customRoutingRequired: false,
  }), "direct");
  assert.equal(selectBridgeMode({
    platform: "darwin",
    staticModelCatalog: true,
    customRoutingRequired: false,
  }), "macos-shim");
  assert.equal(selectBridgeMode({
    platform: "darwin",
    staticModelCatalog: true,
    customRoutingRequired: true,
  }), "macos-router");
});

test("[platform:windows-native] Windows 持续通过 Relay 观察模型流量", () => {
  assert.equal(selectBridgeMode({
    platform: "win32",
    staticModelCatalog: false,
    customRoutingRequired: false,
  }), "windows-relay");
  assert.equal(selectBridgeMode({
    platform: "win32",
    staticModelCatalog: true,
    customRoutingRequired: true,
  }), "windows-relay");
});

test("未适配的平台不会选择桌面桥接模式", () => {
  assert.equal(selectBridgeMode({
    platform: "linux",
    staticModelCatalog: true,
    customRoutingRequired: true,
  }), "unsupported");
});

function baseCatalog() {
  return {
    fetched_at: "ignored metadata",
    models: [{
      slug: "official-model",
      display_name: "Official Model",
      context_window: 128_000,
      max_context_window: 256_000,
      priority: 7,
      input_modalities: ["text", "image"],
      supports_parallel_tool_calls: true,
    }],
  };
}

function customPlatform(overrides = {}) {
  return {
    id: overrides.id ?? "",
    name: "Local Provider",
    baseUrl: "https://example.test/v1",
    apiKey: "secret",
    enabled: true,
    models: [{
      id: "custom-model",
      displayName: "Custom Model",
      contextWindow: 64_000,
      compatibility: { status: "pending" },
      reasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "high",
    }],
    ...overrides,
  };
}

function detectedCompatibility(overrides = {}) {
  const { capabilities: capabilityOverrides = {}, ...fields } = overrides;
  const protocol = fields.protocol ?? "responses";
  const historyMode = fields.historyMode ?? (protocol === "chat" ? "chat" : "responses-full");
  const supportsImage = fields.supportsImage ?? true;
  const routes = fields.routes ?? { default: protocol, imageInput: protocol };
  const reasoningEfforts = fields.reasoningEfforts ?? ["low", "high", "max"];
  return {
    status: "verified",
    protocol,
    routes,
    historyMode,
    toolContinuation: true,
    supportsImage,
    imageStatus: fields.imageStatus ?? (supportsImage ? "supported" : "unsupported"),
    imageDetail: null,
    supportsReasoning: reasoningEfforts.length > 0,
    reasoningEfforts,
    capabilities: {
      transport: {
        responses: protocol === "responses" ? "native" : "inconclusive",
        chat: protocol === "chat" ? "native" : "inconclusive",
      },
      streaming: "native",
      functionTools: "native",
      customTools: protocol === "chat" ? "bridged" : "native",
      namespaceTools: protocol === "chat" ? "bridged" : "native",
      nativeCustomTools: protocol === "chat" ? [] : ["*"],
      parallelTools: "native",
      toolChoice: "native",
      reasoning: reasoningEfforts.length > 0 ? "native" : "unsupported",
      reasoningToolChoice: "native",
      reasoningHistory: historyMode === "responses-full" ? "native" : "bridged",
      imageInput: supportsImage ? "native" : "unsupported",
      hostedTools: { web_search: "unsupported" },
      ...capabilityOverrides,
    },
    codexConformance: "passed",
    checkedAt: 1234,
    probeVersion: MODEL_CAPABILITY_PROBE_VERSION,
    ...fields,
  };
}

function extraModelManager(dataDir, overrides = {}) {
  return new ExtraModelManager({
    dataDir,
    now: () => 1234,
    probeModel: async () => detectedCompatibility(),
    ...overrides,
  });
}

test("模型配置平台统一持久化 DeepSeek 预设、余额和停用状态", async (t) => {
  const dataDir = await useTempDir(t);
  const requests = [];
  const manager = extraModelManager(dataDir, {
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), authorization: options.headers.Authorization });
      if (String(url).endsWith("/models")) {
        return new Response(JSON.stringify({
          data: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        is_available: true,
        balance_infos: [{
          currency: "CNY",
          total_balance: "10.00",
          granted_balance: "2.00",
          topped_up_balance: "8.00",
        }],
      }), { status: 200 });
    },
  });
  const initial = await manager.initialize();
  const preset = initial.platforms.find((platform) => platform.preset === "deepseek");
  await assert.rejects(
    manager.savePlatform({ ...preset, enabled: true, apiKey: "" }),
    /必须填写 API Key/,
  );
  const saved = await manager.savePlatform({ ...preset, enabled: true, apiKey: " ds-key " });
  assert.equal(saved.platforms[0].enabled, true);
  assert.equal(saved.platforms[0].apiKey, "ds-key");
  assert.ok(saved.platforms[0].models.every((model) =>
    model.compatibility.status === "verified" &&
    model.compatibility.probeVersion === MODEL_CAPABILITY_PROBE_VERSION));
  const refreshed = await manager.refreshDeepSeekBalance();
  assert.equal(refreshed.deepSeekBalance.balance.items[0].totalBalance, "10.00");
  assert.ok(requests.every((request) => request.authorization === "Bearer ds-key"));
  assert.equal((await readFile(manager.settingsPath, "utf8")).includes("ds-key"), true);

  const reloaded = extraModelManager(dataDir, {
    fetchImpl: null,
    probeModel: async () => {
      throw new Error("初始化不得重新发送模型探测请求");
    },
  });
  const reloadedPreset = (await reloaded.initialize()).platforms[0];
  assert.equal(reloadedPreset.enabled, true);
  assert.equal(reloadedPreset.apiKey, "ds-key");
  assert.ok(reloadedPreset.models.every((model) =>
    model.compatibility.status === "verified" &&
    model.compatibility.probeVersion === MODEL_CAPABILITY_PROBE_VERSION),
  "同一探测版本的检测结果必须跨管理器进程重建保留");

  const applied = manager.markRestarted();
  assert.equal(applied.pendingRestart, false);
  assert.ok(applied.platforms[0].models.every((model) =>
    model.compatibility.status === "verified"),
  "重启完成只能清除待生效标记，不能清除模型检测结果");

  const cleared = await manager.savePlatform({
    ...saved.platforms[0],
    enabled: false,
    apiKey: "",
  });
  assert.equal(cleared.platforms[0].enabled, false);
  assert.equal(cleared.platforms[0].apiKey, "");
  assert.equal(cleared.deepSeekBalance.balance, null);
  assert.equal(cleared.deepSeekBalance.updatedAt, null);
  assert.equal(JSON.parse(await readFile(manager.settingsPath, "utf8")).platforms[0].apiKey, "");
  await assert.rejects(readFile(join(dataDir, "provider-settings.json"), "utf8"), /ENOENT/,
    "DeepSeek 不能再生成独立入口的配置文件");
  manager.close();
  reloaded.close();
});

test("模型管理中的 DeepSeek 余额使用预设 Key 查询并在换 Key 后清空", async (t) => {
  const dataDir = await useTempDir(t);
  const requests = [];
  const manager = extraModelManager(dataDir, {
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), authorization: options.headers.Authorization });
      return new Response(JSON.stringify({
        is_available: true,
        balance_infos: [{
          currency: "CNY",
          total_balance: "9.49",
          granted_balance: "0.50",
          topped_up_balance: "8.99",
        }],
      }), { status: 200 });
    },
  });
  const initial = await manager.initialize();
  const preset = initial.platforms.find((platform) => platform.preset === "deepseek");
  await manager.savePlatform({ ...preset, apiKey: " managed-key ", enabled: false });
  const changeStates = [];
  const stop = manager.onChange((view) => {
    changeStates.push(view.deepSeekBalance.refreshing);
  });

  const refreshed = await manager.refreshDeepSeekBalance();
  assert.deepEqual(changeStates, [true, false]);
  assert.equal(refreshed.deepSeekBalance.refreshing, false);
  assert.equal(refreshed.deepSeekBalance.updatedAt, 1234);
  assert.deepEqual(refreshed.deepSeekBalance.balance, {
    available: true,
    items: [{
      currency: "CNY",
      totalBalance: "9.49",
      grantedBalance: "0.50",
      toppedUpBalance: "8.99",
    }],
  });
  assert.deepEqual(requests, [{
    url: "https://api.deepseek.com/user/balance",
    authorization: "Bearer managed-key",
  }]);

  const savedPreset = manager.getViewModel().platforms.find((platform) => platform.preset === "deepseek");
  const changed = await manager.savePlatform({
    ...savedPreset,
    apiKey: "replacement-key",
    enabled: false,
  });
  assert.equal(changed.deepSeekBalance.balance, null);
  assert.equal(changed.deepSeekBalance.updatedAt, null);
  stop();
  manager.close();
});

test("额外模型验证 URL、密钥、推理档位、保留 ID 和跨平台重复 ID", async (t) => {
  const manager = extraModelManager(await useTempDir(t));
  await manager.initialize();
  await assert.rejects(
    manager.savePlatform(customPlatform({ baseUrl: "ftp://example.test/v1" })),
    /仅支持 http 或 https/,
  );
  await assert.rejects(
    manager.savePlatform(customPlatform({ apiKey: "" })),
    /必须填写 API Key/,
  );
  await assert.rejects(
    manager.savePlatform(customPlatform({
      models: [{
        ...customPlatform().models[0],
        reasoningEfforts: ["impossible"],
      }],
    })),
    /推理强度不受支持/,
  );
  await assert.rejects(
    manager.savePlatform(customPlatform(), { reservedModelIds: ["custom-model"] }),
    /模型 ID 与现有模型冲突/,
  );
  await manager.savePlatform(customPlatform());
  await assert.rejects(
    manager.savePlatform(customPlatform({
      name: "Second",
      models: [{ ...customPlatform().models[0] }],
    })),
    /模型 ID custom-model.*重复/,
  );
});

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

test("额外模型目录准确映射上下文、图片和推理能力并隔离官方冲突", async (t) => {
  const dataDir = await useTempDir(t);
  const manager = extraModelManager(dataDir, {
    probeModel: async () => detectedCompatibility({
      capabilities: { hostedTools: { web_search: "native" } },
    }),
  });
  await manager.initialize();
  const saved = await manager.savePlatform(customPlatform());
  assert.equal(saved.pendingRestart, true);
  assert.match(saved.message, /等待重启 Codex 后生效/);
  const savedPlatform = saved.platforms.find((platform) => platform.name === "Local Provider");
  const id = savedPlatform.id;
  assert.match(id, /^[0-9a-f-]{36}$/);
  const runtime = await manager.writeRuntimeCatalog(baseCatalog());
  const custom = runtime.catalog.models.find((model) => model.slug === "custom-model");
  assert.equal(custom.context_window, 64_000);
  assert.equal(custom.max_context_window, 64_000);
  assert.deepEqual(custom.input_modalities, ["text", "image"]);
  assert.deepEqual(custom.supported_reasoning_levels.map((item) => item.effort), ["low", "high", "max"]);
  assert.equal(custom.default_reasoning_level, "high");
  assert.equal(custom.supports_parallel_tool_calls, true);
  assert.equal(custom.supports_search_tool, true);
  assert.equal(custom.web_search_tool_type, "text");
  assert.equal(JSON.parse(await readFile(runtime.settingsPath, "utf8")).platforms
    .find((platform) => platform.name === "Local Provider").apiKey, "secret");

  const removed = await manager.removePlatform(id);
  assert.equal(removed.pendingRestart, true);
  assert.match(removed.message, /等待重启 Codex 后生效/);
  assert.equal(manager.getViewModel().platforms.length, 1);
  assert.equal(manager.getViewModel().platforms[0].preset, "deepseek");

  await manager.savePlatform(customPlatform({
    id: "",
    models: [{ ...customPlatform().models[0], id: "official-model" }],
  }));
  const conflicting = await manager.writeRuntimeCatalog(baseCatalog());
  assert.deepEqual(conflicting.catalog.models.map((model) => model.slug), ["official-model"]);
  assert.deepEqual(conflicting.catalogConflicts, [{
    modelId: "official-model",
    platformName: "Local Provider",
  }]);
  assert.equal(
    JSON.parse(await readFile(conflicting.settingsPath, "utf8")).platforms
      .find((platform) => platform.name === "Local Provider").models.length,
    0,
  );
});

test("模型管理自动检测并缓存连接、工具续接和图片能力，目标变化后重新检测", async (t) => {
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
  });
  await manager.initialize();
  const first = await manager.savePlatform(customPlatform());
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
  const second = await manager.savePlatform(changed);
  assert.equal(probes.length, 2);
  const secondPlatform = second.platforms.find((item) => item.name === "Local Provider");
  assert.equal(secondPlatform.models[0].compatibility.protocol, "chat");
  assert.equal(secondPlatform.models[0].compatibility.supportsImage, false);
  assert.deepEqual(secondPlatform.models[0].compatibility.capabilities.nativeCustomTools, []);
  assert.deepEqual(secondPlatform.models[0].reasoningEfforts, ["low", "high", "max"]);

  await manager.redetectPlatform(secondPlatform.id);
  assert.equal(probes.length, 3, "用户重新检测必须忽略缓存");
});

test("旧版图片和 Chat 选项只作为兼容状态迁移，不再要求用户继续选择", async (t) => {
  const dataDir = await useTempDir(t);
  await writeFile(join(dataDir, "extra-model-settings.json"), JSON.stringify({
    version: 5,
    generation: 2,
    platforms: [{
      ...customPlatform({ id: PLATFORM_ID, enabled: false }),
      models: [{
        id: "legacy-model",
        displayName: "Legacy",
        contextWindow: 32000,
        supportsImage: true,
        chatCompatibility: true,
        reasoningEfforts: [],
        defaultReasoningEffort: "",
      }],
    }],
  }));
  const manager = extraModelManager(dataDir);
  const view = await manager.initialize();
  const legacy = view.platforms.find((platform) => platform.name === "Local Provider");
  assert.equal(legacy.models[0].compatibility.status, "legacy");
  assert.equal(legacy.models[0].compatibility.protocol, "chat");
  assert.equal(legacy.models[0].compatibility.historyMode, "chat");
  assert.equal(legacy.models[0].compatibility.toolContinuation, null);
  assert.equal(legacy.models[0].compatibility.supportsImage, true);
  assert.equal(legacy.models[0].compatibility.capabilities.customTools, "inconclusive");
  assert.equal(legacy.models[0].compatibility.codexConformance, "inconclusive");
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
  const saved = await manager.savePlatform({ ...configuredPreset, enabled: true });
  const enabledPreset = saved.platforms.find((platform) => platform.preset === "deepseek");
  assert.deepEqual(enabledPreset.models.map((model) => [model.id, model.selected]), [
    ["deepseek-flash", true],
    ["deepseek-v4-pro", false],
  ]);
  assert.deepEqual(probes, ["deepseek-flash"]);
  assert.deepEqual(requests.map((request) => request.url), [
    "https://api.deepseek.com/models",
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

test("DeepSeek 预设只合并退役的 Flash 别名并保留 Pro API 入口", async (t) => {
  const dataDir = await useTempDir(t);
  await writeFile(join(dataDir, "extra-model-settings.json"), JSON.stringify({
    version: 7,
    generation: 3,
    platforms: [{
      id: "d33f5ee0-0000-4000-8000-000000000001",
      preset: "deepseek",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com/",
      apiKey: "fixture-key",
      enabled: true,
      models: [
        { id: "deepseek-v4-flash", selected: false },
        { id: "deepseek-v4-flash-vision-exp", selected: true },
        {
          id: "deepseek-v4-pro",
          selected: false,
          documentedSupportsImage: true,
          compatibility: {
            status: "verified",
            protocol: "responses",
            historyMode: "responses-full",
            toolContinuation: true,
            supportsImage: null,
            imageStatus: "inconclusive",
            imageDetail: "图片请求已被接受，但本次图像识别答案不符合校验要求",
            checkedAt: 1234,
            probeVersion: 4,
            targetFingerprint: "legacy-pro-fixture",
          },
        },
      ],
    }],
  }));

  const manager = extraModelManager(dataDir);
  const preset = (await manager.initialize()).platforms[0];
  assert.deepEqual(preset.models.map((model) => model.id), ["deepseek-flash", "deepseek-v4-pro"]);
  assert.equal(preset.models[0].selected, true);
  assert.equal(preset.models[0].displayName, "DeepSeek Flash");
  assert.equal(preset.models[0].documentedSupportsImage, true);
  assert.equal(preset.models[1].selected, false);
  assert.equal(preset.models[1].displayName, "DeepSeek Pro");
  assert.equal(preset.models[1].documentedSupportsImage, false);
  assert.equal(preset.models[1].compatibility.imageStatus, "unsupported");
  assert.equal(preset.models[1].compatibility.supportsImage, false);
  assert.equal(preset.models[1].compatibility.probeVersion, 5);
});

test("上下文覆盖只改变运行时目录，不把 model_catalog_json 写入用户配置", async (t) => {
  const codexHome = await useTempDir(t, "codex-home-test-");
  const dataDir = await useTempDir(t);
  await writeFile(join(codexHome, "models_cache.json"), JSON.stringify(baseCatalog()));
  await writeFile(join(codexHome, "config.toml"), "model = \"official-model\"\n");
  const manager = new CodexContextManager({ codexHome, dataDir });
  const initial = await manager.initialize();
  assert.equal(initial.status, "system-default");
  assert.equal(initial.models[0].effectiveContextWindow, 128_000);

  const changed = await manager.setOverride("official-model", 192_000, 384_000);
  assert.equal(changed.status, "applied");
  assert.equal(changed.models[0].effectiveContextWindow, 192_000);
  const effective = manager.getEffectiveCatalog();
  assert.equal(effective.models[0].context_window, 192_000);
  assert.equal(effective.models[0].max_context_window, 384_000);
  assert.deepEqual(Object.keys(effective), ["models"]);
  assert.doesNotMatch(await readFile(join(codexHome, "config.toml"), "utf8"), /model_catalog_json/);

  await manager.resetOverride("official-model");
  assert.equal(manager.getViewModel().status, "system-default");
});

test("用户自有 model_catalog_json 保持外部状态，不会被注入器接管", async (t) => {
  const codexHome = await useTempDir(t, "codex-home-test-");
  const dataDir = await useTempDir(t);
  const externalPath = join(codexHome, "external models.json");
  await writeFile(externalPath, JSON.stringify(baseCatalog()));
  await writeFile(
    join(codexHome, "config.toml"),
    `model_catalog_json = ${JSON.stringify("./external models.json")}\n[features]\nweb_search = true\n`,
  );
  const manager = new CodexContextManager({ codexHome, dataDir });
  const view = await manager.initialize();
  assert.equal(view.status, "external");
  assert.equal(view.currentCatalogPath, externalPath);
  assert.equal(view.catalogSource, "preserved-catalog");
  assert.match(await readFile(join(codexHome, "config.toml"), "utf8"), /external models\.json/);
});

test("损坏或未来版本的上下文存储只读保护，不会被覆盖", async (t) => {
  const codexHome = await useTempDir(t, "codex-home-test-");
  const dataDir = await useTempDir(t);
  const storePath = join(dataDir, "context-overrides.json");
  const original = JSON.stringify({ version: 999, overrides: {} });
  await writeFile(storePath, original);
  await writeFile(join(codexHome, "models_cache.json"), JSON.stringify(baseCatalog()));
  const manager = new CodexContextManager({ codexHome, dataDir });
  const view = await manager.initialize();
  assert.equal(view.messageState, "error");
  assert.match(view.message, /不支持.*版本/);
  await assert.rejects(manager.setOverride("official-model", 1, 1), /存储未修改/);
  assert.equal(await readFile(storePath, "utf8"), original);
});

test("官方模型目录探测为 OAuth 隔离 refresh token，为 API Key 使用 CLI 输出", async (t) => {
  const directory = await useTempDir(t);
  const executable = "fixture-codex";
  const capturePath = join(directory, "capture.json");
  const catalog = { models: [{ slug: "catalog-model" }] };
  const runCli = async (receivedExecutable, args, options) => {
    const auth = JSON.parse(await readFile(join(options.env.CODEX_HOME, "auth.json"), "utf8"));
    await writeFile(capturePath, JSON.stringify({ executable: receivedExecutable, auth, args }));
    if (auth.tokens) {
      await writeFile(join(options.env.CODEX_HOME, "models_cache.json"), JSON.stringify(catalog));
    }
    return { stdout: JSON.stringify(catalog), stderr: "" };
  };

  const oauth = await fetchOfficialModelCatalog({
    executable,
    runCli,
    account: {
      authMode: "oauth",
      accountId: "account",
      tokens: { idToken: "id", accessToken: "access", refreshToken: "must-not-copy" },
    },
  });
  assert.equal(oauth.source, "online");
  let captured = JSON.parse(await readFile(capturePath, "utf8"));
  assert.equal(captured.executable, executable);
  assert.equal(captured.auth.tokens.refresh_token, "");
  assert.deepEqual(captured.args, ["-c", "cli_auth_credentials_store=\"file\"", "debug", "models"]);

  const apiKey = await fetchOfficialModelCatalog({
    executable,
    runCli,
    account: { authMode: "apiKey", openaiApiKey: "sk-local" },
  });
  assert.equal(apiKey.source, "bundled");
  captured = JSON.parse(await readFile(capturePath, "utf8"));
  assert.equal(captured.auth.OPENAI_API_KEY, "sk-local");
  assert.equal(captured.auth.auth_mode, "apikey");
});

if (process.platform === "darwin") test(
  "[platform:macos-native] macOS shim 将 RPC 中继放到 sidecar 并让官方 app-server 保持桌面直系子进程",
  async (t) => {
  const directory = await useTempDir(t, "codex-shim-test-");
  const shim = join(directory, "shim");
  const fakeCodex = join(directory, "fake-codex.mjs");
  const fakeRelay = join(directory, "fake-relay.mjs");
  const relayCapturePath = join(directory, "relay-capture.json");
  const officialCapturePath = join(directory, "official-capture.json");
  const statePath = join(directory, "relay-state.json");
  const catalogPath = join(directory, "catalog with spaces.json");
  const configPath = join(directory, "relay-config.json");
  await writeFile(catalogPath, JSON.stringify(baseCatalog()));
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
await writeFile(process.env.SHIM_OFFICIAL_CAPTURE, JSON.stringify({
  pid: process.pid,
  ppid: process.ppid,
  args: process.argv.slice(2),
  env: {
    cliPath: process.env.CODEX_CLI_PATH,
    relayConfig: process.env.CODEX_QUOTA_RELAY_CONFIG ?? null,
    role: process.env.CODEX_QUOTA_ROLE ?? null,
    sidecar: process.env.CODEX_QUOTA_APP_SERVER_SIDECAR ?? null,
    upstreamStdinFd: process.env.CODEX_QUOTA_UPSTREAM_STDIN_FD ?? null,
    upstreamStdoutFd: process.env.CODEX_QUOTA_UPSTREAM_STDOUT_FD ?? null,
    primaryAppServer: process.env.CODEX_QUOTA_PRIMARY_APP_SERVER ?? null,
    routerToken: process.env.CODEX_QUOTA_ROUTER_TOKEN ?? null,
  },
}));
await new Promise(resolve => setTimeout(resolve, 150));
process.stdout.write("OFFICIAL_THROUGH_SIDECAR\\n");
`);
  await chmod(fakeCodex, 0o755);
  await writeFile(fakeRelay, `#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
await writeFile(process.env.SHIM_RELAY_CAPTURE, JSON.stringify({
  pid: process.pid,
  ppid: process.ppid,
  args: process.argv.slice(2),
  env: {
    cliPath: process.env.CODEX_CLI_PATH,
    relayConfig: process.env.CODEX_QUOTA_RELAY_CONFIG ?? null,
    upstream: process.env.CODEX_QUOTA_UPSTREAM_CODEX_CLI ?? null,
    role: process.env.CODEX_QUOTA_ROLE ?? null,
    sidecar: process.env.CODEX_QUOTA_APP_SERVER_SIDECAR ?? null,
    upstreamStdinFd: process.env.CODEX_QUOTA_UPSTREAM_STDIN_FD ?? null,
    upstreamStdoutFd: process.env.CODEX_QUOTA_UPSTREAM_STDOUT_FD ?? null,
    primaryAppServer: process.env.CODEX_QUOTA_PRIMARY_APP_SERVER ?? null,
    routerToken: process.env.CODEX_QUOTA_ROUTER_TOKEN ?? null,
  },
}));
const upstream = createReadStream(null, {
  fd: Number(process.env.CODEX_QUOTA_UPSTREAM_STDOUT_FD),
  autoClose: true,
  },
);
upstream.pipe(process.stdout);
`);
  await chmod(fakeRelay, 0o755);
  await writeFile(configPath, JSON.stringify({
    version: 5,
    upstreamExecutable: fakeCodex,
    relayExecutable: fakeRelay,
    relayArguments: ["relay-entry"],
    modelCatalogPath: catalogPath,
    relayStatePath: statePath,
    hostHealthPath: join(directory, "host-health.json"),
    hostToolsRequired: true,
    generation: "test-generation",
    router: {
      providerId: "codex_quota_router",
      baseUrl: "http://127.0.0.1:1234/token/v1/",
      tokenEnv: "CODEX_QUOTA_ROUTER_TOKEN",
      tokenHeader: "x-codex-quota-router-token",
      legacyProviderIds: ["deepseek"],
    },
  }));
  await execFileAsync("/usr/bin/xcrun", [
    "swiftc",
    "-target",
    `${process.arch === "x64" ? "x86_64" : "arm64"}-apple-macos12.0`,
    "-O",
    resolve("src/macos-codex-shim.swift"),
    "-o",
    shim,
  ]);
  const { stdout } = await execFileAsync(shim, ["app-server", "--listen", "stdio"], {
    env: {
      ...process.env,
      SHIM_RELAY_CAPTURE: relayCapturePath,
      SHIM_OFFICIAL_CAPTURE: officialCapturePath,
      CODEX_QUOTA_RELAY_CONFIG: configPath,
      CODEX_QUOTA_UPSTREAM_CODEX_CLI: fakeCodex,
      CODEX_QUOTA_PRIMARY_APP_SERVER: "1",
      CODEX_QUOTA_ROUTER_TOKEN: "router-secret",
    },
  });
  const relay = JSON.parse(await readFile(relayCapturePath, "utf8"));
  const official = JSON.parse(await readFile(officialCapturePath, "utf8"));
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.match(stdout, /OFFICIAL_THROUGH_SIDECAR/);
  assert.deepEqual(relay.args, ["relay-entry", "app-server", "--listen", "stdio"]);
  assert.equal(relay.env.cliPath, fakeCodex);
  assert.equal(relay.env.relayConfig, configPath);
  assert.equal(relay.env.upstream, fakeCodex);
  assert.equal(relay.env.role, "app-server-relay");
  assert.equal(relay.env.sidecar, "1");
  assert.match(relay.env.upstreamStdinFd, /^\d+$/);
  assert.match(relay.env.upstreamStdoutFd, /^\d+$/);
  assert.notEqual(relay.env.upstreamStdinFd, relay.env.upstreamStdoutFd);
  assert.equal(relay.env.primaryAppServer, "1");
  assert.equal(relay.env.routerToken, "router-secret");
  assert.equal(relay.ppid, official.pid,
    "RPC 中继必须是官方 app-server 的旁路子进程，不能成为其父进程");
  assert.equal(official.ppid, process.pid,
    "shim 必须原位 exec 官方 app-server，保留桌面 → 官方进程的直接祖先关系");
  assert.equal(official.env.cliPath, fakeCodex);
  assert.equal(official.env.relayConfig, null);
  assert.equal(official.env.role, null);
  assert.equal(official.env.sidecar, null);
  assert.equal(official.env.upstreamStdinFd, null);
  assert.equal(official.env.upstreamStdoutFd, null);
  assert.equal(official.env.primaryAppServer, null);
  assert.equal(official.env.routerToken, "router-secret");
  assert.ok(official.args.includes(`model_catalog_json=${JSON.stringify(catalogPath)}`));
  assert.ok(official.args.includes('model_provider="openai"'));
  assert.ok(official.args.includes('openai_base_url="http://127.0.0.1:1234/token/v1/"'));
  assert.equal(state.pid, relay.pid, "中继存活状态必须跟踪 sidecar，而不是官方 app-server");
  assert.equal(state.generation, "test-generation");

  const auxiliaryRelayCapture = join(directory, "relay-capture-auxiliary.json");
  const auxiliaryOfficialCapture = join(directory, "official-capture-auxiliary.json");
  const stateBeforeAuxiliary = `${JSON.stringify({ owner: "desktop-primary" })}\n`;
  await writeFile(statePath, stateBeforeAuxiliary);
  const auxiliaryEnv = {
    ...process.env,
    SHIM_RELAY_CAPTURE: auxiliaryRelayCapture,
    SHIM_OFFICIAL_CAPTURE: auxiliaryOfficialCapture,
    CODEX_QUOTA_RELAY_CONFIG: configPath,
    CODEX_QUOTA_UPSTREAM_CODEX_CLI: fakeCodex,
  };
  delete auxiliaryEnv.CODEX_QUOTA_PRIMARY_APP_SERVER;
  await execFileAsync(shim, ["app-server"], {
    env: auxiliaryEnv,
  });
  const auxiliaryRelay = JSON.parse(await readFile(auxiliaryRelayCapture, "utf8"));
  const auxiliaryOfficial = JSON.parse(await readFile(auxiliaryOfficialCapture, "utf8"));
  assert.equal(auxiliaryRelay.env.primaryAppServer, null);
  assert.equal(auxiliaryOfficial.env.primaryAppServer, null);
  assert.equal(await readFile(statePath, "utf8"), stateBeforeAuxiliary,
    "辅助 app-server 的 shim 不得覆盖桌面主中继状态");

  const noRouterRelayCapture = join(directory, "relay-capture-no-router.json");
  const noRouterOfficialCapture = join(directory, "official-capture-no-router.json");
  const noRouterConfig = {
    ...JSON.parse(await readFile(configPath, "utf8")),
    generation: "test-generation-no-router",
    router: null,
  };
  await writeFile(configPath, JSON.stringify(noRouterConfig));
  const noRouterEnv = {
    ...process.env,
    SHIM_RELAY_CAPTURE: noRouterRelayCapture,
    SHIM_OFFICIAL_CAPTURE: noRouterOfficialCapture,
    CODEX_QUOTA_RELAY_CONFIG: configPath,
    CODEX_QUOTA_UPSTREAM_CODEX_CLI: fakeCodex,
    CODEX_QUOTA_PRIMARY_APP_SERVER: "1",
  };
  delete noRouterEnv.CODEX_QUOTA_ROUTER_TOKEN;
  const noRouterRun = await execFileAsync(shim, ["app-server", "--listen", "stdio"], {
    env: noRouterEnv,
  });
  const noRouterRelay = JSON.parse(await readFile(noRouterRelayCapture, "utf8"));
  const noRouterOfficial = JSON.parse(await readFile(noRouterOfficialCapture, "utf8"));
  assert.match(noRouterRun.stdout, /OFFICIAL_THROUGH_SIDECAR/);
  assert.equal(noRouterRelay.ppid, noRouterOfficial.pid,
    "无 Router 的 shim 也必须启动观察 sidecar");
  assert.ok(noRouterOfficial.args.includes(`model_catalog_json=${JSON.stringify(catalogPath)}`));
  assert.equal(noRouterOfficial.args.some((argument) => argument.startsWith("model_provider=")), false);
  assert.equal(noRouterOfficial.env.routerToken, null);
});
