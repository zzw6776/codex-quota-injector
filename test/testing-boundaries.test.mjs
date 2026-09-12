import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  isolatedEnv,
  ROOT,
} from "../runtime-tests/support/offline-runtime.mjs";
import {
  liveProfiles,
  liveRouterConfiguration,
  publicProfile,
  selectLiveProfiles,
  summarizeLiveEvidence,
  summarizeMcpRequests,
} from "../live-tests/runtime.mjs";
import { ModelRouterManager } from "../src/model-router.mjs";
import { scenarioCoverage } from "../scripts/test-support.mjs";
import { useTempDir } from "./helpers.mjs";
const exec = promisify(execFile);

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
  const options = { cwd: ROOT, env: isolatedEnv(directory, { CODEX_TEST_CLI: join(directory, "must-not-start") }), timeout: 10000 };
  const plan = JSON.parse((await exec(process.execPath, ["scripts/test-live.mjs", "--plan"], options)).stdout);
  assert.equal(plan.batch, "B-overview");
  assert.deepEqual(plan.profiles.map(p => p.id), ["official"]);
  const selectedPlan = JSON.parse((await exec(process.execPath,
    ["scripts/test-live.mjs", "--plan", "--profile=official"], options)).stdout);
  assert.equal(selectedPlan.profileFilter, "official");
  assert.equal(selectedPlan.batch, "B1-official");
  assert.deepEqual(selectedPlan.profiles.map(p => p.id), ["official"]);
  assert.deepEqual(selectedPlan.perProfile, [
    "独立任务的文件、命令、补丁与 MCP 调用",
    "独立短任务的历史恢复与分叉",
    "独立短任务的显式压缩与压缩后历史恢复",
    "独立任务的网页/浏览器宿主适配、用户输入、图片及官方原生搜索",
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
  assert.deepEqual(hostPlan.perProfile,
    ["独立任务的网页/浏览器宿主适配、用户输入、图片及官方原生搜索"]);
  await assert.rejects(exec(process.execPath,
    ["scripts/test-live.mjs", "--plan", "--profile=missing"], options), error => {
    assert.match(error.stderr, /未找到真实测试配置 missing/); return true;
  });
  await assert.rejects(exec(process.execPath,
    ["scripts/test-live.mjs", "--plan", "--stage=missing"], options), error => {
    assert.match(error.stderr, /未知真实测试场景 missing/); return true;
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
    "live-tests/history.test.mjs", "live-tests/compaction.test.mjs", "live-tests/host.test.mjs"], options);
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

test("[A HAR-04 MOD-03] 真实 DeepSeek profile 使用完整运行时契约并在请求前注册到 Router", async t => {
  const deepSeekManager = {
    settings: { enabled: true, apiKey: "fixture-deepseek-key", generation: 7 },
    messageState: null,
    async initialize() {},
    getViewModel() {
      return {
        enabled: true,
        configured: true,
        apiKey: this.settings.apiKey,
        model: {
          slug: "deepseek-v4-flash",
          displayName: "DeepSeek V4 Flash",
          reasoningEfforts: ["low", "high", "max"],
        },
      };
    },
  };
  const extraModelManager = {
    settings: { generation: 0, platforms: [] },
    messageState: null,
    async initialize() {},
  };
  const profiles = await liveProfiles({ deepSeekManager, extraModelManager });
  assert.deepEqual(selectLiveProfiles(profiles, "deepseek").map(item => item.id), ["deepseek"]);
  const profile = profiles.find(item => item.id === "deepseek");
  assert.ok(profile);
  assert.deepEqual(profile.deepSeek, {
    enabled: true,
    configured: true,
    apiKey: "fixture-deepseek-key",
    generation: 7,
    model: {
      slug: "deepseek-v4-flash",
      displayName: "DeepSeek V4 Flash",
      reasoningEfforts: ["low", "high", "max"],
    },
  });
  assert.doesNotMatch(JSON.stringify(publicProfile(profile)), /fixture-deepseek-key/);

  const router = new ModelRouterManager();
  t.after(() => router.close());
  const route = await router.configure({ deepSeek: profile.deepSeek, officialAuthMode: "oauth" });
  assert.deepEqual(route.routedModels, ["deepseek-v4-flash"]);
  assert.deepEqual(route.legacyProviderIds, ["deepseek"]);
  assert.deepEqual(liveRouterConfiguration(route).legacyProviderIds, ["deepseek"]);
  assert.equal(liveRouterConfiguration(route).tokenHeader, "x-codex-quota-router-token");
});
