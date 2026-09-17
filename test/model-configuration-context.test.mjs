import assert from "node:assert/strict";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { useTempDir } from "./helpers.mjs";
import { join } from "node:path";
import { CodexContextManager } from "../src/codex-context.mjs";
import { baseCatalog, customPlatform, detectedCompatibility, extraModelManager, detectAndSave } from "./model-configuration/support.mjs";

test("额外模型目录准确映射上下文、图片和推理能力并隔离官方冲突", async (t) => {
  const dataDir = await useTempDir(t);
  const manager = extraModelManager(dataDir, {
    probeModel: async () => detectedCompatibility({
      capabilities: { hostedTools: { web_search: "native" } },
    }),
  });
  await manager.initialize();
  const saved = await detectAndSave(manager, customPlatform());
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

test("上下文写入失败保持已发布状态，后续操作仍可保存", async (t) => {
  for (const operation of ["set", "reset", "resetAll"]) {
    await t.test(operation, async (t) => {
      const codexHome = await useTempDir(t, "codex-home-test-");
      const dataDir = await useTempDir(t);
      await writeFile(join(codexHome, "models_cache.json"), JSON.stringify(baseCatalog()));
      const manager = new CodexContextManager({ codexHome, dataDir });
      await manager.initialize();
      await manager.setOverride("official-model", 192_000, 384_000);
      const before = manager.getEffectiveCatalog();
      const storePath = join(dataDir, "context-overrides.json");
      const savedPath = `${storePath}.saved`;
      const saved = await readFile(storePath, "utf8");
      await rename(storePath, savedPath);
      await mkdir(storePath); // 真实触发原子替换失败，不依赖权限或 mock。
      const change = () => operation === "set"
        ? manager.setOverride("official-model", 256_000, 512_000)
        : operation === "reset" ? manager.resetOverride("official-model") : manager.resetAll();

      await assert.rejects(change(), (error) => ["EISDIR", "EPERM", "EACCES"].includes(error.code));
      assert.deepEqual(manager.getEffectiveCatalog(), before);
      assert.equal(await readFile(savedPath, "utf8"), saved);

      await rm(storePath, { recursive: true });
      await rename(savedPath, storePath);
      await change();
      assert.equal(manager.getEffectiveCatalog().models[0].context_window,
        operation === "set" ? 256_000 : 128_000);
      const reloaded = new CodexContextManager({ codexHome, dataDir });
      await reloaded.initialize();
      assert.deepEqual(reloaded.getEffectiveCatalog(), manager.getEffectiveCatalog());
    });
  }
});
