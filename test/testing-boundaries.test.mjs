import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  isolatedEnv,
  ROOT,
} from "../runtime-tests/support/offline-runtime.mjs";
import {
  liveSandboxConfigLines,
  liveProfiles,
  liveRouterConfiguration,
  publicProfile,
  selectLiveProfiles,
  summarizeLiveEvidence,
  summarizeMcpRequests,
} from "../live-tests/runtime.mjs";
import {
  DEEPSEEK_CANONICAL_MODEL_ID,
  DEEPSEEK_FLASH_MODEL_IDS,
  DEEPSEEK_PRO_MODEL_ID,
} from "../src/deepseek-model-profile.mjs";
import { MODEL_CAPABILITY_PROBE_VERSION } from "../src/model-capability-probe.mjs";
import { ModelRouterManager } from "../src/model-router.mjs";
import { scenarioCoverage } from "../scripts/test-support.mjs";
import { selectedRuntime } from "../scripts/test-desktop-host.mjs";
import { useTempDir } from "./helpers.mjs";
const exec = promisify(execFile);

function verifiedCompatibility({ protocol = "responses", supportsImage = false } = {}) {
  return {
    status: "verified",
    protocol,
    routes: { default: protocol, imageInput: protocol },
    historyMode: protocol === "chat" ? "chat" : "responses-full",
    toolContinuation: true,
    supportsImage,
    imageStatus: supportsImage ? "supported" : "unsupported",
    capabilities: {
      transport: {
        responses: protocol === "responses" ? "native" : "unsupported",
        chat: protocol === "chat" ? "native" : "unsupported",
      },
      streaming: "native",
      functionTools: "native",
      customTools: "bridged",
      namespaceTools: "bridged",
      nativeCustomTools: [],
      parallelTools: "native",
      toolChoice: "unsupported",
      reasoning: "native",
      reasoningToolChoice: "auto-only",
      reasoningHistory: "native",
      imageInput: supportsImage ? "native" : "unsupported",
      hostedTools: { web_search: "unsupported" },
    },
    codexConformance: "passed",
    checkedAt: 1,
    probeVersion: MODEL_CAPABILITY_PROBE_VERSION,
    targetFingerprint: "fixture-target",
  };
}

test("[A HAR-01 HAR-04] 桌面付费计划在无支持运行环境的平台只报告 unsupported", async () => {
  assert.equal(await selectedRuntime("current", {
    platform: "linux",
    allowUnsupportedCurrent: true,
  }), "unsupported");
  await assert.rejects(selectedRuntime("current", { platform: "linux" }),
    /没有完整测试运行环境/);
  await assert.rejects(selectedRuntime("all", {
    platform: "linux",
    allowUnsupportedCurrent: true,
  }), /没有完整测试运行环境/);
});

test("[platform:windows-native] [A HAR-04] Windows 原生真实测试显式启用可写的受限令牌沙箱", () => {
  assert.deepEqual(liveSandboxConfigLines("windows-native"), [
    'sandbox_mode="workspace-write"',
    'approval_policy="never"',
    'windows.sandbox="unelevated"',
  ]);
  for (const runtimeTarget of ["wsl-native", "macos-native"]) {
    assert.deepEqual(liveSandboxConfigLines(runtimeTarget), [
      'sandbox_mode="workspace-write"',
      'approval_policy="never"',
    ]);
  }
});

test("[A RPC-02 HAR-04] 完整场景清单绑定证据文件，未执行与真实宿主不能自动变成通过", async () => {
  const coverage = await scenarioCoverage();
  assert.equal(new Set(coverage.map(s => s.id)).size, coverage.length);
  assert.ok(coverage.every(s => s.status !== "free-evidence-passed"));
  assert.equal(coverage.find(s => s.id === "TOOL-05").liveStatus, "not-run");
  assert.equal(coverage.find(s => s.id === "ACC-04").status, "not-verified");
  assert.equal(coverage.find(s => s.id === "ACC-04").liveRequired, "lifecycle");
});

test("[A HAR-01 HAR-04] 实测付费测试未授权时只列计划或跳过，不要求当前账号或启动官方程序", async t => {
  const directory = await useTempDir(t);
  const providerData = join(directory, "provider-data");
  await mkdir(providerData);
  await writeFile(join(providerData, "extra-model-settings.json"), JSON.stringify({
    version: 11,
    generation: 1,
    platforms: [{
      id: "d33f5ee0-0000-4000-8000-000000000001",
      preset: "deepseek",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com/",
      apiKey: "sk-fixture-deepseek",
      enabled: true,
      models: [{
        id: DEEPSEEK_CANONICAL_MODEL_ID,
        selected: true,
        documentedSupportsImage: true,
        compatibility: verifiedCompatibility({ supportsImage: true }),
      }, {
        id: DEEPSEEK_PRO_MODEL_ID,
        selected: true,
        documentedSupportsImage: false,
        compatibility: verifiedCompatibility({ supportsImage: false }),
      }],
    }, {
      id: "123e4567-e89b-42d3-a456-426614174099",
      name: "TokenHub",
      baseUrl: "https://tokenhub.example/v1/",
      apiKey: "sk-fixture-tokenhub",
      enabled: true,
      models: [{
        id: "kimi-k3",
        selected: true,
        compatibility: verifiedCompatibility({ supportsImage: true }),
      }],
    }],
  }));
  const options = { cwd: ROOT, env: isolatedEnv(directory, {
    CODEX_TEST_CLI: join(directory, "must-not-start"),
    CODEX_QUOTA_DATA_DIR: providerData,
  }), timeout: 10000 };
  const plan = JSON.parse((await exec(process.execPath, ["scripts/test-live.mjs", "--plan"], options)).stdout);
  assert.equal(plan.batch, "B-overview");
  assert.deepEqual(plan.profiles.map(p => p.id), ["official", "deepseek"]);
  const selectedPlan = JSON.parse((await exec(process.execPath,
    ["scripts/test-live.mjs", "--plan", "--profile=official"], options)).stdout);
  assert.equal(selectedPlan.profileFilter, "official");
  assert.equal(selectedPlan.batch, "B1-official");
  assert.equal(selectedPlan.runtimeTarget, process.platform === "darwin"
    ? "macos-native"
    : process.platform === "win32"
      ? selectedPlan.currentRuntime
      : "unsupported");
  assert.equal(selectedPlan.changesDesktopRuntime, false);
  assert.equal(selectedPlan.component, `B1-official-backend/${selectedPlan.runtimeTarget}`);
  assert.deepEqual(selectedPlan.components.map(component => [component.kind, component.status]), [
    ["backend", "planned"],
    ["desktop-entry", "not-run"],
  ]);
  assert.deepEqual(selectedPlan.profiles.map(p => p.id), ["official"]);
  assert.deepEqual(selectedPlan.perProfile, [
    "独立任务的文件、命令、补丁与 MCP 调用",
    "独立短任务的历史恢复与分叉",
    "独立短任务的显式压缩与压缩后历史恢复",
    "独立 app-server 的网页/浏览器宿主适配、用户输入、图片、官方原生搜索回调",
  ]);
  assert.equal(selectedPlan.maxObservedTokensPerStage, 500000);
  assert.equal(selectedPlan.maxTurnsPerStage, 40);
  const toolsPlan = JSON.parse((await exec(process.execPath,
    ["scripts/test-live.mjs", "--plan", "--profile=official", "--stage=tools"], options)).stdout);
  assert.deepEqual(toolsPlan.perProfile, ["独立任务的文件、命令、补丁与 MCP 调用"]);
  const historyPlan = JSON.parse((await exec(process.execPath,
    ["scripts/test-live.mjs", "--plan", "--profile=official", "--stage=history"], options)).stdout);
  assert.equal(historyPlan.stageFilter, "history");
  assert.deepEqual(historyPlan.perProfile, ["独立短任务的历史恢复与分叉"]);
  const compactionPlan = JSON.parse((await exec(process.execPath,
    ["scripts/test-live.mjs", "--plan", "--profile=official", "--stage=compaction"], options)).stdout);
  assert.equal(compactionPlan.stageFilter, "compaction");
  assert.deepEqual(compactionPlan.perProfile, ["独立短任务的显式压缩与压缩后历史恢复"]);
  const hostPlan = JSON.parse((await exec(process.execPath,
    ["scripts/test-live.mjs", "--plan", "--profile=official", "--stage=host"], options)).stdout);
  assert.equal(hostPlan.stageFilter, "callbacks");
  assert.deepEqual(hostPlan.perProfile,
    ["独立 app-server 的网页/浏览器宿主适配、用户输入、图片、官方原生搜索回调"]);
  const callbacksPlan = JSON.parse((await exec(process.execPath,
    ["scripts/test-live.mjs", "--plan", "--profile=official", "--stage=callbacks"], options)).stdout);
  assert.equal(callbacksPlan.stageFilter, "callbacks");
  const deepseekPlan = JSON.parse((await exec(process.execPath,
    ["scripts/test-live.mjs", "--plan", "--profile=deepseek"], options)).stdout);
  assert.deepEqual(deepseekPlan.perProfile, [
    "独立任务的文件、命令、补丁与 MCP 调用",
    "独立短任务的历史恢复与分叉",
    "独立短任务的显式压缩与压缩后历史恢复",
    "独立 app-server 的网页/浏览器宿主适配、用户输入、图片回调",
  ]);
  const desktopPlan = JSON.parse((await exec(process.execPath,
    ["scripts/test-desktop-host.mjs", "--plan", "--profile=deepseek"], options)).stdout);
  assert.equal(desktopPlan.batch, "B2-deepseek");
  assert.equal(desktopPlan.component, `B2-deepseek-desktop/${desktopPlan.runtimeTarget}`);
  assert.equal(desktopPlan.expectedModel, DEEPSEEK_CANONICAL_MODEL_ID);
  await assert.rejects(exec(process.execPath,
    ["scripts/test-desktop-host.mjs", "--profile=official"], options), error => {
    assert.match(error.stderr, /追加 --confirm-token-use/); return true;
  });
  await assert.rejects(exec(process.execPath,
    ["scripts/test-desktop-host.mjs", "--plan", "--profile=official", "--runtime=all"], options), error => {
    assert.match(error.stderr, /一次只能选择一个运行环境|没有完整测试运行环境/); return true;
  });
  await assert.rejects(exec(process.execPath,
    ["scripts/test-live.mjs", "--plan", "--profile=missing"], options), error => {
    assert.match(error.stderr, /未找到真实测试配置 missing/); return true;
  });
  await assert.rejects(exec(process.execPath,
    ["scripts/test-live.mjs", "--plan", "--stage=missing"], options), error => {
    assert.match(error.stderr, /未知真实测试场景 missing/); return true;
  });
  await assert.rejects(exec(process.execPath,
    ["scripts/test-live.mjs", "--plan", "--runtime=all"], options), error => {
    assert.match(error.stderr, /一次只能选择一个运行环境|没有完整测试运行环境/); return true;
  });
  await assert.rejects(exec(process.execPath, ["scripts/test-live.mjs", "--plan"], {
    ...options, env: { ...options.env, CODEX_TEST_LIVE_MAX_TOKENS: "invalid" },
  }), error => { assert.match(error.stderr, /上限必须是正整数/); return true; });
  await assert.rejects(exec(process.execPath, ["scripts/test-live.mjs"], options), error => {
    assert.match(error.stderr, /取得对应批次的本次明确同意/); return true;
  });
  await assert.rejects(exec(process.execPath,
    ["scripts/test-live.mjs", "--confirm-token-use"], options), error => {
    assert.match(error.stderr, /必须分批指定 --profile=official 或 --profile=deepseek/); return true;
  });
  const skipped = await exec(process.execPath, ["--test", "live-tests/tools.test.mjs", "live-tests/current-account-smoke.test.mjs",
    "live-tests/history.test.mjs", "live-tests/compaction.test.mjs", "live-tests/callbacks.test.mjs"], options);
  assert.match(skipped.stdout, /skip|跳过/i);
  await assert.rejects(readFile(join(options.env.CODEX_HOME, "auth.json")), { code: "ENOENT" });
});

test("[A HAR-04 OBS-03] 真实失败证据保留阶段、用量和工具类型但不复制正文", () => {
  const evidence = summarizeLiveEvidence({ profile: "fixture", model: "model-a", stage: "模型驱动 MCP 调用",
    budget: { tokens: 321, turns: 2 }, sanitize: text => text.replaceAll("PRIVATE", "[隐藏]"), events: [
      { method: "item/completed", params: { item: { type: "agentMessage", status: "completed", text: "PRIVATE" } } },
      { method: "item/completed", params: { item: { type: "mcpToolCall", status: "failed", server: "fixture", tool: "record",
        arguments: { text: "PRIVATE", count: 1 }, result: "PRIVATE", error: { message: "PRIVATE tool failure" } } } },
      { method: "error", params: { error: { message: "PRIVATE failure" } } },
    ] });
  assert.deepEqual(evidence, { profile: "fixture", model: "model-a", stage: "模型驱动 MCP 调用",
    observedTokens: 321, regularTurns: 2, completedItems: [
      { type: "agentMessage", status: "completed" },
      { type: "mcpToolCall", status: "failed", server: "fixture", tool: "record",
        arguments: { kind: "object", keys: ["count", "text"], valueTypes: { count: "number", text: "string" } },
        error: "[隐藏] tool failure" },
    ], errors: ["[隐藏] failure"] });
  assert.ok(!JSON.stringify(evidence).includes("PRIVATE"));
  const mcp = summarizeMcpRequests([
    JSON.stringify({ method: "tools/call", params: { name: "record", arguments: { text: "PRIVATE" } } }),
    JSON.stringify({ method: "resources/read", params: { uri: "PRIVATE" } }),
  ].join("\n"));
  assert.deepEqual(mcp, [{ name: "record", arguments: { kind: "object", keys: ["text"], valueTypes: { text: "string" } } }]);
  assert.ok(!JSON.stringify(mcp).includes("PRIVATE"));
});

test("[A HAR-04 MOD-03] B1/B2 从模型配置平台隔离官方与 DeepSeek Flash，排除 Pro 和 TokenHub", async (t) => {
  const extraModelManager = {
    settings: {
      generation: 9,
      platforms: [{
        id: "d33f5ee0-0000-4000-8000-000000000001",
        preset: "deepseek",
        name: "DeepSeek",
        baseUrl: "https://api.deepseek.com/",
        apiKey: "fixture-preset-key",
        enabled: true,
        models: [{
          id: DEEPSEEK_CANONICAL_MODEL_ID,
          selected: true,
          documentedSupportsImage: true,
          compatibility: verifiedCompatibility({ supportsImage: true }),
        }, {
          id: DEEPSEEK_PRO_MODEL_ID,
          selected: true,
          documentedSupportsImage: false,
          compatibility: verifiedCompatibility({ supportsImage: false }),
        }],
      }, {
        id: "123e4567-e89b-42d3-a456-426614174099",
        name: "TokenHub",
        baseUrl: "https://tokenhub.example/v1/",
        apiKey: "fixture-tokenhub-key",
        enabled: true,
        models: [{
          id: "kimi-k3",
          selected: true,
          compatibility: verifiedCompatibility({ supportsImage: true }),
        }],
      }],
    },
    messageState: null,
    async initialize() {},
  };
  const profiles = await liveProfiles({ extraModelManager });
  assert.deepEqual(profiles.map((value) => value.id), ["official", "deepseek"]);
  assert.deepEqual(profiles[0].extraModels.platforms, [],
    "B1 不能把任何第三方平台带入隔离运行时");
  const [profile] = selectLiveProfiles(
    profiles,
    "deepseek",
  );
  assert.equal(profile.model, DEEPSEEK_CANONICAL_MODEL_ID);
  assert.equal(profile.protocol, "responses");
  assert.equal(profile.images, true);
  assert.equal(profile.deepSeek, undefined);
  assert.equal(profile.configurationSource, "model-platform");
  assert.deepEqual(profile.extraModels.platforms.map((platform) => platform.preset), ["deepseek"]);
  assert.deepEqual(profile.extraModels.platforms[0].models.map((model) => model.id), [
    DEEPSEEK_CANONICAL_MODEL_ID,
  ]);
  assert.equal(profile.extraModels.generation, 9);
  assert.doesNotMatch(JSON.stringify(publicProfile(profile)), /fixture-preset-key/);

  const router = new ModelRouterManager();
  t.after(() => router.close());
  const route = await router.configure({
    extraModels: profile.extraModels,
    officialAuthMode: "oauth",
  });
  assert.deepEqual(route.routedModels, [...DEEPSEEK_FLASH_MODEL_IDS]);
  assert.equal(route.routedModels.includes(DEEPSEEK_PRO_MODEL_ID), false);
  assert.equal(route.routedModels.includes("kimi-k3"), false);
  assert.deepEqual(route.legacyProviderIds, ["custom_d33f5ee0000040008000000000000001"]);
  assert.deepEqual(liveRouterConfiguration(route).legacyProviderIds,
    ["custom_d33f5ee0000040008000000000000001"]);
  assert.equal(liveRouterConfiguration(route).tokenHeader, "x-codex-quota-router-token");
});

test("[A HAR-04 MOD-03] B2 在 DeepSeek Flash 检测结果过期时于发送 Token 前停止", async () => {
  const extraModelManager = {
    settings: {
      generation: 3,
      platforms: [{
        id: "d33f5ee0-0000-4000-8000-000000000001",
        preset: "deepseek",
        name: "DeepSeek",
        baseUrl: "https://api.deepseek.com/",
        apiKey: "fixture-key",
        enabled: true,
        models: [{
          id: DEEPSEEK_CANONICAL_MODEL_ID,
          selected: true,
          compatibility: {
            ...verifiedCompatibility({ supportsImage: true }),
            probeVersion: MODEL_CAPABILITY_PROBE_VERSION - 1,
          },
        }],
      }],
    },
    messageState: null,
    async initialize() {},
  };
  const profiles = await liveProfiles({ extraModelManager });
  assert.deepEqual(profiles.map((profile) => profile.id), ["official"]);
  assert.throws(() => selectLiveProfiles(profiles, "deepseek"),
    /未找到真实测试配置 deepseek/);
});
