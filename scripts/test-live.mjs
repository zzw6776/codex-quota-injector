import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { liveBudget, liveProfiles, publicProfile, selectLiveProfiles } from "../live-tests/runtime.mjs";
import { requireFreeResult, RESULTS, ROOT, writeReport } from "./test-support.mjs";

const args = new Set(process.argv.slice(2));
const known = new Set(["--plan", "--confirm-token-use", "--wakeup"]);
const profileArguments = [...args].filter(arg => arg.startsWith("--profile="));
const stageArguments = [...args].filter(arg => arg.startsWith("--stage="));
if (profileArguments.length > 1) throw new Error("一次只能选择一个真实测试配置");
if (stageArguments.length > 1) throw new Error("一次只能选择一个真实测试场景");
for (const arg of args) if (!known.has(arg) && !arg.startsWith("--profile=") && !arg.startsWith("--stage=")) throw new Error(`未知参数 ${arg}`);
const profileFilter = profileArguments[0]?.slice("--profile=".length).trim() || null;
if (profileArguments.length && !profileFilter) throw new Error("--profile 必须指定配置 ID");
const stageFilter = stageArguments[0]?.slice("--stage=".length).trim() || null;
if (stageArguments.length && !stageFilter) throw new Error("--stage 必须指定场景 ID");
const liveStageFiles = new Map([
  ["tools", "live-tests/tools.test.mjs"],
  ["history", "live-tests/history.test.mjs"],
  ["compaction", "live-tests/compaction.test.mjs"],
  ["host", "live-tests/host.test.mjs"],
]);
if (stageFilter && !liveStageFiles.has(stageFilter)) {
  throw new Error(`未知真实测试场景 ${stageFilter}；可用场景：${[...liveStageFiles.keys()].join("、")}`);
}
if (stageFilter && args.has("--wakeup")) throw new Error("单场景定向测试不能同时执行账号唤醒");
const profiles = selectLiveProfiles(await liveProfiles(), profileFilter).map(publicProfile);
const budget = liveBudget();
const batch = profileFilter === "official"
  ? "B1-official"
  : profileFilter === "deepseek"
    ? "B2-deepseek"
    : profileFilter
      ? "B-provider"
      : "B-overview";
const stageDescriptions = new Map([
  ["tools", "独立任务的文件、命令、补丁与 MCP 调用"],
  ["history", "独立短任务的历史恢复与分叉"],
  ["compaction", "独立短任务的显式压缩与压缩后历史恢复"],
  ["host", "独立任务的网页/浏览器宿主适配、用户输入、图片及官方原生搜索"],
]);
const plan = { batch, platform: process.platform, arch: process.arch, profiles,
  profileFilter, stageFilter,
  maxObservedTokensPerStage: budget.maxTokens, maxTurnsPerStage: budget.maxTurns,
  perProfile: stageFilter
    ? [stageDescriptions.get(stageFilter)]
    : [...stageDescriptions.values()],
  desktopHostChecks: "另按 docs/testing-desktop-host.md 由当前 Codex 调用实际 web.run、computer use 等宿主工具；独立 app-server 不具有这些桌面工具",
  wakeup: args.has("--wakeup"),
  lifecycle: "关闭、重启、接管、安装更新和真实账号切换另由 C 批 npm run test:lifecycle 执行",
  note: "每个隔离阶段分别应用 Token 与轮次阈值；按返回用量停止时，在途请求可能超出。任一阶段失败后停止后续付费阶段。" };
console.log(JSON.stringify(plan, null, 2));
if (args.has("--plan")) process.exit(0);
if (!args.has("--confirm-token-use")) throw new Error("会消耗真实 Token。先查看 B1/B2 计划并取得对应批次的本次明确同意；查看计划不会发送模型请求。");
if (!profileFilter) {
  throw new Error("付费测试必须分批指定 --profile=official 或 --profile=deepseek；不得一次执行全部供应商");
}
const free = await requireFreeResult();
await mkdir(RESULTS, { recursive: true });
const report = { ...plan, status: "running", startedAt: new Date().toISOString(), snapshot: free.snapshot, runtimeSnapshot: free.runtimeSnapshot };
const profileArtifact = profileFilter
  ? profileFilter.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "profile"
  : null;
const artifact = [profileArtifact, stageFilter].filter(Boolean).join("-");
const reportPath = join(RESULTS, artifact ? `live-${artifact}.json` : "live.json");
await writeReport(reportPath, report);
try {
  report.events = [];
  let code = 0;
  const stages = stageFilter
    ? [{ name: `live-${stageFilter}`, file: liveStageFiles.get(stageFilter) }]
    : [...liveStageFiles].map(([name, file]) => ({ name: `live-${name}`, file })).concat(
      args.has("--wakeup")
        ? [{ name: "live-wakeup", file: "live-tests/current-account-smoke.test.mjs" }]
        : [],
    );
  for (const stage of stages) {
    if (code !== 0) { report.wakeupStatus = "not-run-after-failure"; break; }
    const eventPath = join(RESULTS, `${stage.name}${profileArtifact ? `-${profileArtifact}` : ""}-events.jsonl`);
    const child = spawn(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=spec", "--test-reporter=./scripts/test-json-reporter.mjs",
      "--test-reporter-destination=stdout", `--test-reporter-destination=${eventPath}`, stage.file],
    { cwd: ROOT, env: { ...process.env, CODEX_TEST_LIVE_APPROVED: "current-run",
      ...(profileFilter ? { CODEX_TEST_LIVE_PROFILE: profileFilter } : {}) }, stdio: "inherit" });
    const stop = () => child.kill("SIGTERM");
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); }); }
    finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
    report.events.push(...(await readFile(eventPath, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse));
    if (stage.name === "live-wakeup") report.wakeupStatus = code === 0 ? "passed" : "failed";
  }
  report.backendStatus = code === 0 ? "passed" : "failed";
  report.status = code === 0 ? "desktop-host-not-verified" : "failed";
  if (code !== 0) process.exitCode = 1;
} catch (error) { report.status = "blocked"; report.error = error.message; process.exitCode = 1; }
report.finishedAt = new Date().toISOString();
await writeReport(reportPath, report);
console.log(`真实测试报告：${reportPath}。桌面宿主结果须另行记录，不能凭后台通过判定主入口全部通过。`);
