import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  liveBudget,
  liveProfiles,
  publicProfile,
  selectLiveProfiles,
} from "../live-tests/runtime.mjs";
import {
  WSL_NATIVE,
  currentRuntimeTarget,
  resolveRuntimeSelection,
  runWslTestSuite,
  runtimeTargetLabel,
  runtimeTargetsForPlatform,
  waitForTestProcess,
} from "./test-runtime-targets.mjs";
import { requireFreeResult, RESULTS, ROOT, sourceSnapshot, writeReport } from "./test-support.mjs";
import {
  backendComponentId,
  combineBStatuses,
  desktopComponentId,
} from "./desktop-host-evidence.mjs";

const args = new Set(process.argv.slice(2));
const known = new Set(["--plan", "--confirm-token-use", "--wakeup"]);
const profileArguments = [...args].filter((argument) => argument.startsWith("--profile="));
const stageArguments = [...args].filter((argument) => argument.startsWith("--stage="));
const runtimeArguments = [...args].filter((argument) => argument.startsWith("--runtime="));
if (profileArguments.length > 1) throw new Error("一次只能选择一个真实测试配置");
if (stageArguments.length > 1) throw new Error("一次只能选择一个真实测试场景");
if (runtimeArguments.length > 1) throw new Error("一次只能选择一个真实测试运行环境");
for (const argument of args) {
  if (!known.has(argument) && !argument.startsWith("--profile=") &&
    !argument.startsWith("--stage=") && !argument.startsWith("--runtime=")) {
    throw new Error(`未知参数 ${argument}`);
  }
}

const profileFilter = argumentValue(profileArguments, "--profile");
const requestedStageFilter = argumentValue(stageArguments, "--stage");
const stageFilter = requestedStageFilter === "host" ? "callbacks" : requestedStageFilter;
const requestedRuntime = argumentValue(runtimeArguments, "--runtime") ?? "current";
const liveStageFiles = new Map([
  ["tools", "live-tests/tools.test.mjs"],
  ["history", "live-tests/history.test.mjs"],
  ["compaction", "live-tests/compaction.test.mjs"],
  ["callbacks", "live-tests/callbacks.test.mjs"],
]);
if (stageFilter && !liveStageFiles.has(stageFilter)) {
  throw new Error(`未知真实测试场景 ${stageFilter}；可用场景：${[...liveStageFiles.keys()].join("、")}`);
}
if (stageFilter && args.has("--wakeup")) throw new Error("单场景定向测试不能同时执行账号唤醒");
if (!args.has("--plan") && !args.has("--confirm-token-use")) {
  throw new Error("会消耗真实 Token。先查看 B1/B2 计划并取得对应批次的本次明确同意；查看计划不会发送模型请求。");
}
if (!args.has("--plan") && !profileFilter) {
  throw new Error("付费测试必须分批指定 --profile=official 或 --profile=deepseek；不得一次执行全部供应商");
}

const availableRuntimes = runtimeTargetsForPlatform();
const activeRuntime = availableRuntimes.length ? await currentRuntimeTarget() : null;
const [runtimeTarget] = !availableRuntimes.length && args.has("--plan") && requestedRuntime === "current"
  ? ["unsupported"]
  : resolveRuntimeSelection(requestedRuntime, {
      currentTarget: activeRuntime,
      allowAll: false,
    });
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
  ["callbacks", describeCallbacksStage(profiles)],
]);
const backendComponent = profileFilter && ["official", "deepseek"].includes(profileFilter)
  ? backendComponentId(profileFilter, runtimeTarget)
  : `${batch}-backend/${runtimeTarget}`;
const desktopComponent = profileFilter && ["official", "deepseek"].includes(profileFilter)
  ? desktopComponentId(profileFilter, runtimeTarget)
  : `${batch}-desktop/${runtimeTarget}`;
const plan = {
  batch,
  component: backendComponent,
  platform: process.platform,
  arch: process.arch,
  profiles,
  profileFilter,
  stageFilter,
  currentRuntime: activeRuntime,
  runtimeTarget,
  runtimeLabel: runtimeTargetLabel(runtimeTarget),
  availableRuntimes,
  changesDesktopRuntime: false,
  maxObservedTokensPerStage: budget.maxTokens,
  maxTurnsPerStage: budget.maxTurns,
  perProfile: stageFilter
    ? [stageDescriptions.get(stageFilter)]
    : [...stageDescriptions.values()],
  components: [
    {
      id: backendComponent,
      kind: "backend",
      status: "planned",
      stages: stageFilter ? [stageFilter] : [...liveStageFiles.keys()],
    },
    {
      id: desktopComponent,
      kind: "desktop-entry",
      status: "not-run",
      command: profileFilter
        ? `npm run test:desktop -- --profile=${profileFilter} --runtime=${runtimeTarget} --plan`
        : null,
    },
  ],
  desktopHostChecks: "后台通过后使用 test:desktop，由选择同一供应商模型的真实 Codex 桌面任务调用 web.run、computer use 等宿主工具",
  wakeup: args.has("--wakeup"),
  lifecycle: "关闭、重启、接管、安装更新、Windows/WSL 自动切换和真实账号往返另由 C 批执行",
  note: "一次授权只运行一个供应商和一个运行环境。每个隔离阶段分别应用 Token 与轮次阈值；任一阶段失败后停止后续付费阶段。",
};
console.log(JSON.stringify(plan, null, 2));
if (args.has("--plan")) process.exit(0);

const free = await requireFreeResult({ runtimeTarget });
await mkdir(RESULTS, { recursive: true });
const report = {
  ...plan,
  status: "incomplete",
  backendStatus: "running",
  desktopHostStatus: "not-run",
  overallStatus: "incomplete",
  components: plan.components.map((component) => ({
    ...component,
    status: component.kind === "backend" ? "running" : "not-run",
  })),
  startedAt: new Date().toISOString(),
  snapshot: free.snapshot,
  freeComponent: {
    id: free.selectedRuntimeComponent.id,
    status: free.selectedRuntimeComponent.status,
    runtimeSnapshot: free.selectedRuntimeComponent.runtimeSnapshot,
  },
};
const profileArtifact = safeArtifact(profileFilter);
const artifact = [profileArtifact, runtimeTarget, stageFilter].filter(Boolean).join("-");
const reportPath = join(RESULTS, `live-${artifact}.json`);
await writeReport(reportPath, report);
try {
  report.events = [];
  const stages = selectedStages(profileArtifact);
  let code;
  if (runtimeTarget === WSL_NATIVE) {
    const result = await runWslTestSuite({
      root: ROOT,
      resultDirectory: RESULTS,
      stages: stages.map((stage) => ({ id: stage.name, files: [stage.file], eventFile: stage.eventFile })),
      sourceSha256: free.snapshot.sha256,
      kind: `live-${profileArtifact}`,
      liveProfile: profileFilter,
      expectedCliSha256: free.selectedRuntimeComponent.runtimeSnapshot?.cli?.sha256,
      expectedRelaySha256: free.selectedRuntimeComponent.artifact?.sha256,
      existingRelayPath: free.selectedRuntimeComponent.artifact?.path,
      browserPath: free.runtimeSnapshot.browser?.path,
      expectedBrowserSha256: free.runtimeSnapshot.browser?.sha256,
    });
    report.wslRuntimeSnapshot = result.runtimeSnapshot ?? null;
    code = result.status === "passed" ? 0 : 1;
    if (result.error) report.runtimeError = result.error;
    for (const stage of stages) report.events.push(...await readEvents(join(RESULTS, stage.eventFile)));
  } else {
    code = await runLocalStages(stages, free.selectedRuntimeComponent.artifact?.path);
  }
  if (args.has("--wakeup")) {
    const wakeup = stages.find((stage) => stage.name === "live-wakeup");
    const wakeupResult = runtimeTarget === WSL_NATIVE
      ? report.events.some((event) => event.file?.endsWith("current-account-smoke.test.mjs") && event.type === "test:pass")
      : code === 0 && Boolean(wakeup);
    report.wakeupStatus = wakeupResult ? "passed" : code === 0 ? "not-run" : "failed-or-not-run";
  }
  report.backendStatus = code === 0 ? "passed" : "failed";
  report.components.find((component) => component.kind === "backend").status = report.backendStatus;
  report.overallStatus = combineBStatuses(report.backendStatus, report.desktopHostStatus);
  report.status = report.overallStatus;
  if (code !== 0) process.exitCode = 1;
} catch (error) {
  report.backendStatus = "blocked";
  report.components.find((component) => component.kind === "backend").status = "blocked";
  report.overallStatus = "blocked";
  report.status = "blocked";
  report.error = error.message;
  process.exitCode = 1;
}
const finishedSnapshot = await sourceSnapshot();
if (finishedSnapshot.sha256 !== report.snapshot.sha256) {
  report.backendStatus = "failed";
  report.components.find((component) => component.kind === "backend").status = "failed";
  report.overallStatus = "failed";
  report.status = "stale";
  report.sourceChangedDuringTest = true;
  report.error = [report.error, "真实测试期间源码发生变化，报告不能用于当前源码"].filter(Boolean).join("；");
  process.exitCode = 1;
}
report.finishedAt = new Date().toISOString();
await writeReport(reportPath, report);
console.log(`真实测试报告：${reportPath}。运行环境：${runtimeTargetLabel(runtimeTarget)}。桌面宿主结果须另行记录。`);
if (report.backendStatus === "passed") {
  console.log(`${backendComponent}: passed；${desktopComponent}: not-run；${batch}: incomplete`);
  console.log(`桌面入口计划：npm run test:desktop -- --profile=${profileFilter} --runtime=${runtimeTarget} --plan`);
}

function selectedStages(profileArtifactName) {
  const selected = stageFilter
    ? [[stageFilter, liveStageFiles.get(stageFilter)]]
    : [...liveStageFiles];
  if (!stageFilter && args.has("--wakeup")) {
    selected.push(["wakeup", "live-tests/current-account-smoke.test.mjs"]);
  }
  return selected.map(([name, file]) => ({
    name: `live-${name}`,
    file,
    eventFile: `live-${name}-${profileArtifactName}-${runtimeTarget}-events.jsonl`,
  }));
}

async function runLocalStages(stages, relayExecutable) {
  let code = 0;
  for (const stage of stages) {
    if (code !== 0) break;
    const eventPath = join(RESULTS, stage.eventFile);
    const child = spawn(process.execPath, [
      "--test",
      "--test-concurrency=1",
      "--test-reporter=spec",
      "--test-reporter=./scripts/test-json-reporter.mjs",
      "--test-reporter-destination=stdout",
      `--test-reporter-destination=${eventPath}`,
      stage.file,
    ], {
      cwd: ROOT,
      env: {
        ...process.env,
        CODEX_TEST_LIVE_APPROVED: "current-run",
        CODEX_TEST_LIVE_PROFILE: profileFilter,
        CODEX_TEST_RUNTIME_TARGET: runtimeTarget,
        ...(relayExecutable ? { CODEX_TEST_RELAY_EXECUTABLE: relayExecutable } : {}),
      },
      stdio: "inherit",
    });
    const stop = () => child.kill("SIGTERM");
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      code = await waitForTestProcess(child);
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
    report.events.push(...await readEvents(eventPath));
  }
  return Number(code);
}

async function readEvents(path) {
  return (await readFile(path, "utf8").catch(() => ""))
    .trim().split("\n").filter(Boolean).map(JSON.parse);
}

function argumentValue(argumentsList, name) {
  if (!argumentsList.length) return null;
  const value = argumentsList[0].slice(`${name}=`.length).trim();
  if (!value) throw new Error(`${name} 必须指定值`);
  return value;
}

function safeArtifact(value) {
  return String(value ?? "profile")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "profile";
}

function describeCallbacksStage(selectedProfiles) {
  const checks = ["网页/浏览器宿主适配", "用户输入"];
  if (selectedProfiles.some((profile) => profile.images)) checks.push("图片");
  if (selectedProfiles.some((profile) => profile.id === "official")) checks.push("官方原生搜索");
  return `独立 app-server 的${checks.join("、")}回调`;
}
