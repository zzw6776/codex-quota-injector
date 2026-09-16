import assert from "node:assert/strict";
import test from "node:test";
import { useTempDir } from "./helpers.mjs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { customPlatform, extraModelManager, PLATFORM_ID } from "./model-configuration/support.mjs";

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
