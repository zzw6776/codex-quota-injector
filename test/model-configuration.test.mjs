import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { CodexContextManager } from "../src/codex-context.mjs";
import { DeepSeekManager } from "../src/deepseek-manager.mjs";
import { ExtraModelManager } from "../src/extra-model-manager.mjs";
import { fetchOfficialModelCatalog } from "../src/official-model-catalog.mjs";
import { useTempDir } from "./helpers.mjs";

const execFileAsync = promisify(execFile);
const PLATFORM_ID = "123e4567-e89b-42d3-a456-426614174010";

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
      supportsImage: true,
      chatCompatibility: false,
      reasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "high",
    }],
    ...overrides,
  };
}

test("DeepSeek 配置持久化、余额刷新和删除不会泄漏旧状态", async (t) => {
  const dataDir = await useTempDir(t);
  const requests = [];
  const manager = new DeepSeekManager({
    dataDir,
    fetchImpl: async (url, options) => {
      requests.push({ url, authorization: options.headers.Authorization });
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
  await manager.initialize();
  await assert.rejects(manager.save({ enabled: true, apiKey: "" }), /必须填写 API Key/);
  const saved = await manager.save({ enabled: true, apiKey: " ds-key " });
  assert.equal(saved.enabled, true);
  assert.equal(saved.apiKey, "ds-key");
  assert.equal(saved.balance.items[0].totalBalance, "10.00");
  assert.equal(requests[0].authorization, "Bearer ds-key");
  assert.equal((await readFile(manager.settingsPath, "utf8")).includes("ds-key"), true);

  const reloaded = new DeepSeekManager({ dataDir, fetchImpl: null });
  assert.equal((await reloaded.initialize()).configured, true);
  const removed = await reloaded.remove();
  assert.equal(removed.configured, false);
  assert.equal(removed.balance, null);
  assert.equal(JSON.parse(await readFile(manager.settingsPath, "utf8")).apiKey, "");
});

test("DeepSeek 运行时目录仅在启用时追加一次模型并保持官方字段", async (t) => {
  const dataDir = await useTempDir(t);
  const manager = new DeepSeekManager({
    dataDir,
    fetchImpl: async () => new Response(JSON.stringify({ is_available: true, balance_infos: [] })),
  });
  await manager.initialize();
  await manager.save({ enabled: true, apiKey: "key" });
  const runtime = await manager.writeRuntimeCatalog({
    ...baseCatalog(),
    models: [
      ...baseCatalog().models,
      { slug: "deepseek-v4-flash", priority: 1, stale: true },
    ],
  });
  assert.deepEqual(runtime.catalog.models.map((model) => model.slug), [
    "official-model", "deepseek-v4-flash",
  ]);
  const deepseek = runtime.catalog.models[1];
  assert.equal(deepseek.priority, 8);
  assert.equal(deepseek.supports_parallel_tool_calls, true);
  assert.equal(deepseek.tool_mode, null);
  assert.equal(deepseek.supports_search_tool, false,
    "直接工具模式必须直接暴露 MCP；启用延迟搜索会让 DeepSeek 找到工具后仍无法调用");
  assert.equal(deepseek.input_modalities.includes("image"), false);
  assert.ok(runtime.generation.length >= 32);
});

test("额外模型验证 URL、密钥、推理档位、保留 ID 和跨平台重复 ID", async (t) => {
  const manager = new ExtraModelManager({ dataDir: await useTempDir(t) });
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

test("额外模型目录准确映射上下文、图片和推理能力并隔离官方冲突", async (t) => {
  const dataDir = await useTempDir(t);
  const manager = new ExtraModelManager({ dataDir });
  await manager.initialize();
  const saved = await manager.savePlatform(customPlatform());
  const id = saved.platforms[0].id;
  assert.match(id, /^[0-9a-f-]{36}$/);
  const runtime = await manager.writeRuntimeCatalog(baseCatalog());
  const custom = runtime.catalog.models.find((model) => model.slug === "custom-model");
  assert.equal(custom.context_window, 64_000);
  assert.equal(custom.max_context_window, 64_000);
  assert.deepEqual(custom.input_modalities, ["text", "image"]);
  assert.deepEqual(custom.supported_reasoning_levels.map((item) => item.effort), ["low", "high"]);
  assert.equal(custom.default_reasoning_level, "high");
  assert.equal(JSON.parse(await readFile(runtime.settingsPath, "utf8")).platforms[0].apiKey, "secret");

  await manager.removePlatform(id);
  assert.equal(manager.getViewModel().platforms.length, 0);

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
    JSON.parse(await readFile(conflicting.settingsPath, "utf8")).platforms[0].models.length,
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

test("官方模型目录探测为 OAuth 隔离 refresh token，为 API Key 使用 CLI 输出", {
  skip: process.platform === "win32" ? "Windows 不能直接执行测试用 mjs 假 CLI" : false,
}, async (t) => {
  const directory = await useTempDir(t);
  const executable = join(directory, "fake-codex.mjs");
  const capturePath = join(directory, "capture.json");
  await writeFile(executable, `#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const auth = JSON.parse(await readFile(join(process.env.CODEX_HOME, "auth.json"), "utf8"));
await writeFile(process.env.CATALOG_CAPTURE, JSON.stringify({ auth, args: process.argv.slice(2) }));
const catalog = { models: [{ slug: "catalog-model" }] };
if (auth.tokens) await writeFile(join(process.env.CODEX_HOME, "models_cache.json"), JSON.stringify(catalog));
process.stdout.write(JSON.stringify(catalog));
`);
  await chmod(executable, 0o755);
  const previousCapture = process.env.CATALOG_CAPTURE;
  process.env.CATALOG_CAPTURE = capturePath;
  t.after(() => {
    if (previousCapture == null) delete process.env.CATALOG_CAPTURE;
    else process.env.CATALOG_CAPTURE = previousCapture;
  });

  const oauth = await fetchOfficialModelCatalog({
    executable,
    account: {
      authMode: "oauth",
      accountId: "account",
      tokens: { idToken: "id", accessToken: "access", refreshToken: "must-not-copy" },
    },
  });
  assert.equal(oauth.source, "online");
  let captured = JSON.parse(await readFile(capturePath, "utf8"));
  assert.equal(captured.auth.tokens.refresh_token, "");
  assert.deepEqual(captured.args, ["-c", "cli_auth_credentials_store=\"file\"", "debug", "models"]);

  const apiKey = await fetchOfficialModelCatalog({
    executable,
    account: { authMode: "apiKey", openaiApiKey: "sk-local" },
  });
  assert.equal(apiKey.source, "bundled");
  captured = JSON.parse(await readFile(capturePath, "utf8"));
  assert.equal(captured.auth.OPENAI_API_KEY, "sk-local");
  assert.equal(captured.auth.auth_mode, "apikey");
});

test("macOS shim 将 Router app-server 交给 RPC 中继并保留启动边界", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const directory = await useTempDir(t, "codex-shim-test-");
  const shim = join(directory, "shim");
  const fakeCodex = join(directory, "fake-codex.mjs");
  const fakeRelay = join(directory, "fake-relay.mjs");
  const capturePath = join(directory, "capture.json");
  const statePath = join(directory, "relay-state.json");
  const catalogPath = join(directory, "catalog with spaces.json");
  const configPath = join(directory, "relay-config.json");
  await writeFile(catalogPath, JSON.stringify(baseCatalog()));
  await writeFile(fakeCodex, "#!/usr/bin/env node\n");
  await chmod(fakeCodex, 0o755);
  await writeFile(fakeRelay, `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
await writeFile(process.env.SHIM_CAPTURE, JSON.stringify({
  args: process.argv.slice(2),
  env: {
    cliPath: process.env.CODEX_CLI_PATH,
    relayConfig: process.env.CODEX_QUOTA_RELAY_CONFIG ?? null,
    upstream: process.env.CODEX_QUOTA_UPSTREAM_CODEX_CLI ?? null,
    role: process.env.CODEX_QUOTA_ROLE ?? null,
    routerToken: process.env.CODEX_QUOTA_ROUTER_TOKEN ?? null,
  },
}));
`);
  await chmod(fakeRelay, 0o755);
  await writeFile(configPath, JSON.stringify({
    version: 4,
    upstreamExecutable: fakeCodex,
    relayExecutable: fakeRelay,
    relayArguments: ["relay-entry"],
    modelCatalogPath: catalogPath,
    relayStatePath: statePath,
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
  await execFileAsync(shim, ["app-server", "--listen", "stdio"], {
    env: {
      ...process.env,
      SHIM_CAPTURE: capturePath,
      CODEX_QUOTA_RELAY_CONFIG: configPath,
      CODEX_QUOTA_UPSTREAM_CODEX_CLI: fakeCodex,
      CODEX_QUOTA_ROUTER_TOKEN: "router-secret",
    },
  });
  const capture = JSON.parse(await readFile(capturePath, "utf8"));
  assert.deepEqual(capture.args, ["relay-entry", "app-server", "--listen", "stdio"]);
  assert.deepEqual(capture.args.slice(-2), ["--listen", "stdio"]);
  assert.equal(capture.env.cliPath, fakeCodex);
  assert.equal(capture.env.relayConfig, configPath);
  assert.equal(capture.env.upstream, fakeCodex);
  assert.equal(capture.env.role, "app-server-relay");
  assert.equal(capture.env.routerToken, "router-secret");
});
