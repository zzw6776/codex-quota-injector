import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { testName, testCountsText } from "./test-labels.mjs";

import {
  activateOfflineNetworkIsolation,
  sandboxCommand,
} from "../runtime-tests/support/offline-runtime.mjs";
import {
  COMMON_COMPONENT,
  MACOS_NATIVE,
  WINDOWS_NATIVE,
  WSL_NATIVE,
  classifyContractTestTitles,
  currentRuntimeTarget,
  exactContractNamePattern,
  prepareWindowsNativeRelay,
  resolveRuntimeSelection,
  runWslTestSuite,
  runtimeComponentId,
  runtimeTargetLabel,
  runtimeTargetsForPlatform,
  summarizeFinalStageEvents,
  summarizeSelectedRuntimeComponents,
  summarizeRuntimeComponents,
} from "./test-runtime-targets.mjs";
import {
  RESULTS,
  ROOT,
  runtimeSnapshot,
  scenarioCoverage,
  sourceSnapshot,
  writeReport,
} from "./test-support.mjs";
import { resolveMacOSCodexShim } from "../src/macos-shim.mjs";

const COMMON_RUNTIME_FILES = new Set([
  "runtime-tests/browser-host.test.mjs",
  "runtime-tests/desktop-fixture.test.mjs",
  "runtime-tests/widget-browser.test.mjs",
]);

const PLATFORM_RUNTIME_TARGETS = new Map([
  ["runtime-tests/windows-computer-use-fixture.test.mjs", new Set([WINDOWS_NATIVE])],
]);

const runtimeArgument = process.argv.slice(2).find((argument) => argument.startsWith("--runtime="));
for (const argument of process.argv.slice(2)) {
  if (argument !== runtimeArgument) throw new Error(`未知参数 ${argument}`);
}

await mkdir(RESULTS, { recursive: true });
const snapshot = await sourceSnapshot();
const currentTarget = await currentRuntimeTarget();
const supportedTargets = runtimeTargetsForPlatform();
const selectedTargets = resolveRuntimeSelection(runtimeArgument?.slice("--runtime=".length), {
  currentTarget,
  allowAll: true,
});
const report = {
  name: testName("free"),
  version: 2,
  status: "running",
  batch: "free-regression",
  modelRequests: "scripted loopback service only",
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  startedAt: new Date().toISOString(),
  snapshot,
  currentRuntime: currentTarget,
  selectedRuntimes: selectedTargets,
  supportedRuntimes: supportedTargets,
  excluded: ["关闭或重启日常 Codex", "切换真实账号", "安装更新与进程接管"],
  components: [],
  tests: [],
};
const reportPath = join(RESULTS, "offline.json");
await writeReport(reportPath, report);

let networkIsolation = null;
const allEvents = [];
try {
  report.runtimeSnapshot = await runtimeSnapshot();
  networkIsolation = await activateOfflineNetworkIsolation([
    process.execPath,
    report.runtimeSnapshot.cli?.path,
    report.runtimeSnapshot.browser?.path,
  ]);

  const contractFiles = await testFiles("test");
  const contractFilesByScope = await groupContractFiles(contractFiles);
  const allRuntimeFiles = await testFiles("runtime-tests");
  for (const file of allRuntimeFiles) {
    if (file.startsWith("runtime-tests/widget-browser-")) COMMON_RUNTIME_FILES.add(file);
  }
  const commonRuntimeFiles = allRuntimeFiles.filter((file) => COMMON_RUNTIME_FILES.has(file));
  const relayRuntimeFiles = allRuntimeFiles.filter((file) => !COMMON_RUNTIME_FILES.has(file));
  const commonStages = [
    await runLocalStage({
      id: "common-contracts",
      files: contractFilesByScope.get(COMMON_COMPONENT).files,
      sandboxed: false,
      namePattern: contractFilesByScope.get(COMMON_COMPONENT).namePattern,
    }),
    await runLocalStage({
      id: "common-browser",
      files: commonRuntimeFiles,
      sandboxed: true,
    }),
  ];
  report.components.push(componentFromStages(COMMON_COMPONENT, commonStages, {
    scope: "shared-logic-router-protocol-pages",
    runtimeSnapshot: report.runtimeSnapshot,
  }));

  if (report.components[0].status === "passed") {
    for (const runtimeTarget of supportedTargets) {
      if (!selectedTargets.includes(runtimeTarget)) {
        report.components.push({
          id: runtimeComponentId(runtimeTarget),
          runtimeTarget,
          label: runtimeTargetLabel(runtimeTarget),
          status: "not-run",
          reason: "本次未选择该运行环境",
          stages: [],
        });
        continue;
      }
      const targetRuntimeFiles = runtimeFilesForTarget(relayRuntimeFiles, runtimeTarget);
      const targetContracts = contractFilesByScope.get(runtimeTarget);
      report.components.push(runtimeTarget === WSL_NATIVE
        ? await runWslComponent(targetRuntimeFiles, targetContracts)
        : await runLocalRuntimeComponent(runtimeTarget, targetRuntimeFiles, targetContracts));
    }
  } else {
    for (const runtimeTarget of supportedTargets) {
      report.components.push({
        id: runtimeComponentId(runtimeTarget),
        runtimeTarget,
        label: runtimeTargetLabel(runtimeTarget),
        status: "not-run",
        reason: "免费回归公共组件未通过",
        stages: [],
      });
    }
  }

  report.tests = allEvents.filter((event) => ["test:pass", "test:fail"].includes(event.type)).map((event) => ({
    name: event.name,
    file: event.file,
    line: event.line,
    nesting: event.nesting,
    component: event.component,
    runtimeTarget: event.runtimeTarget ?? null,
    status: event.skip ? "skipped" : event.type === "test:pass" ? "passed" : "failed",
    durationMs: event.details?.duration_ms,
    error: event.details?.error,
    scenarios: [...new Set(event.name.match(/\b[A-Z]{2,4}-\d{2}\b/g) ?? [])],
  }));
  report.summary = summarizeFinalStageEvents(allEvents);
  report.runtimeVersions = [...new Set(allEvents
    .filter((event) => event.type === "test:diagnostic" && /codex-cli|测试浏览器|Codex CLI/i.test(event.message))
    .map((event) => `${event.runtimeTarget ?? "common"}: ${event.message}`))];
  report.coverage = await scenarioCoverage(report.tests);
  report.mainEntryStatus = "not-verified";
  Object.assign(report, summarizeRuntimeComponents(report.components, {
    currentTarget,
    supportedTargets,
  }));
  report.selectedStatus = summarizeSelectedRuntimeComponents(report.components, selectedTargets);
  report.status = report.selectedStatus;
  report.isolation = {
    common: networkIsolation.mode,
    runtime: Object.fromEntries(report.components.filter((component) => component.runtimeTarget)
      .map((component) => [component.runtimeTarget,
        component.runtimeTarget === WSL_NATIVE
          ? "WSL 临时 HOME、Linux 依赖及本地模型材料"
          : networkIsolation.mode])),
  };
  if ((await sourceSnapshot()).sha256 !== report.snapshot.sha256) {
    markStale("测试期间代码发生变化，不能作为当前代码的通过报告");
  } else if (JSON.stringify(await runtimeSnapshot()) !== JSON.stringify(report.runtimeSnapshot)) {
    markStale("测试期间官方 CLI 或浏览器发生变化");
  }
} catch (error) {
  report.status = "blocked";
  report.currentRuntimeStatus = "blocked";
  report.allSupportedStatus = "blocked";
  report.error = error.message;
} finally {
  if (networkIsolation) {
    await networkIsolation.close().catch((error) => {
      report.status = "blocked";
      report.currentRuntimeStatus = "blocked";
      report.allSupportedStatus = "blocked";
      report.error = `临时测试环境清理失败：${error.message}`;
    });
  }
}

await writeFile(join(RESULTS, "offline-events.jsonl"), allEvents
  .map((event) => `${JSON.stringify(event)}\n`).join(""));
report.finishedAt = new Date().toISOString();
await writeReport(reportPath, report);
console.log(`\n${report.name}｜${testCountsText(report.summary?.counts)}｜状态：${report.selectedStatus ?? report.status}`);
console.log(`当前环境 ${report.currentRuntimeStatus}；全部支持环境 ${report.allSupportedStatus}；报告：${reportPath}`);
for (const component of report.components) {
  console.log(`- ${component.label ?? "公共组件"}: ${component.status}${component.reason ? ` (${component.reason})` : ""}`);
}
if (report.currentRuntimeStatus === "passed") {
  console.log("免费回归已通过。下一步分别展示官方模型、DeepSeek Flash 的后台功能测试与桌面集成测试，以及启停恢复测试计划；没有当次授权时不得执行。");
  console.log("计划命令：npm run test:live:official -- --plan；npm run test:live:deepseek -- --plan；npm run test:lifecycle -- --plan");
}
if (report.status !== "passed") {
  process.exitCode = 1;
}

async function runLocalRuntimeComponent(runtimeTarget, files, contracts) {
  try {
    let relayArtifact = null;
    if (runtimeTarget === WINDOWS_NATIVE) {
      relayArtifact = await prepareWindowsNativeRelay({ root: ROOT });
    }
    const runtimeEnv = {
      CODEX_TEST_RUNTIME_TARGET: runtimeTarget,
      ...(relayArtifact ? { CODEX_TEST_RELAY_EXECUTABLE: relayArtifact.path } : {}),
      ...(runtimeTarget === MACOS_NATIVE
        ? { CODEX_TEST_MACOS_SHIM: await resolveMacOSCodexShim() }
        : {}),
    };
    const stages = [];
    if (contracts.files.length) {
      stages.push(await runLocalStage({
        id: `contracts-${runtimeTarget}`,
        files: contracts.files,
        sandboxed: false,
        env: runtimeEnv,
        component: runtimeComponentId(runtimeTarget),
        runtimeTarget,
        namePattern: contracts.namePattern,
      }));
    }
    stages.push(await runLocalStage({
      id: `runtime-${runtimeTarget}`,
      files,
      sandboxed: true,
      env: runtimeEnv,
      component: runtimeComponentId(runtimeTarget),
      runtimeTarget,
    }));
    return componentFromStages(runtimeComponentId(runtimeTarget), stages, {
      runtimeTarget,
      label: runtimeTargetLabel(runtimeTarget),
      runtimeSnapshot: {
        ...report.runtimeSnapshot,
        ...(relayArtifact ? { relay: relayArtifact } : {}),
      },
      artifact: relayArtifact,
    });
  } catch (error) {
    return blockedComponent(runtimeTarget, error);
  }
}

async function runWslComponent(files, contracts) {
  const id = runtimeComponentId(WSL_NATIVE);
  try {
    const stages = [
      ...(contracts.files.length ? [{
        id: "contracts-wsl-native",
        files: contracts.files,
        eventFile: "offline-contracts-wsl-native-events.jsonl",
        testNamePattern: contracts.namePattern,
      }] : []),
      {
        id: "runtime-wsl-native",
        files,
        eventFile: "offline-wsl-native-events.jsonl",
      },
    ];
    const result = await runWslTestSuite({
      root: ROOT,
      resultDirectory: RESULTS,
      stages,
      sourceSha256: snapshot.sha256,
      kind: "offline",
      browserPath: report.runtimeSnapshot.browser?.path,
      expectedBrowserSha256: report.runtimeSnapshot.browser?.sha256,
    });
    const stageEvidence = [];
    for (const stage of stages) {
      const events = await readEvents(join(RESULTS, stage.eventFile), id, WSL_NATIVE, stage.id);
      allEvents.push(...events);
      stageEvidence.push({
        stage,
        tests: events.filter((event) => ["test:pass", "test:fail"].includes(event.type)),
        summary: events.filter((event) => event.type === "test:summary").at(-1) ?? null,
      });
    }
    const tests = stageEvidence.flatMap((item) => item.tests);
    let status = result.status;
    if (status === "passed" && tests.length === 0) status = "failed";
    else if (status === "passed" && tests.some((event) => event.skip)) status = "incomplete";
    return {
      id,
      runtimeTarget: WSL_NATIVE,
      label: runtimeTargetLabel(WSL_NATIVE),
      status,
      reason: result.error?.message ?? null,
      runtimeSnapshot: result.runtimeSnapshot ?? null,
      artifact: result.runtimeSnapshot?.relay ?? null,
      stages: (result.stages ?? []).map((item) => {
        const evidence = stageEvidence.find((candidate) => candidate.stage.id === item.id);
        return evidence ? { ...item, tests: evidence.tests, summary: evidence.summary } : item;
      }),
    };
  } catch (error) {
    return blockedComponent(WSL_NATIVE, error);
  }
}

async function runLocalStage({
  id,
  files,
  sandboxed,
  env = {},
  component = COMMON_COMPONENT,
  runtimeTarget = null,
  namePattern = null,
}) {
  const eventPath = join(RESULTS, `offline-${id}-events.jsonl`);
  const args = [
    "--test",
    "--test-concurrency=1",
    "--test-reporter=spec",
    "--test-reporter=./scripts/test-json-reporter.mjs",
    "--test-reporter-destination=stdout",
    `--test-reporter-destination=${eventPath}`,
    ...(namePattern ? [`--test-name-pattern=${namePattern}`] : []),
    ...files,
  ];
  const command = sandboxed
    ? sandboxCommand(process.execPath, args)
    : { executable: process.execPath, args };
  const child = spawn(command.executable, command.args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  const onInterrupt = () => child.kill("SIGTERM");
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);
  let exit;
  try {
    exit = await new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    });
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
  }
  const events = await readEvents(eventPath, component, runtimeTarget, id);
  allEvents.push(...events);
  return {
    id,
    ...exit,
    tests: events.filter((event) => ["test:pass", "test:fail"].includes(event.type)),
    summary: events.filter((event) => event.type === "test:summary").at(-1) ?? null,
  };
}

function componentFromStages(id, stages, extra = {}) {
  const tests = stages.flatMap((stage) => stage.tests ?? []);
  let status = stages.length > 0 && stages.every((stage) => stage.code === 0) && tests.length > 0
    ? "passed"
    : "failed";
  if (status === "passed" && tests.some((event) => event.skip)) status = "incomplete";
  return { id, status, stages, ...extra };
}

function blockedComponent(runtimeTarget, error) {
  return {
    id: runtimeComponentId(runtimeTarget),
    runtimeTarget,
    label: runtimeTargetLabel(runtimeTarget),
    status: "blocked",
    reason: error.message,
    stages: [],
  };
}

async function readEvents(path, component, runtimeTarget, stage) {
  return (await readFile(path, "utf8").catch(() => ""))
    .trim().split("\n").filter(Boolean).map((line) => ({
      ...normalizeEventPaths(JSON.parse(line)),
      component,
      runtimeTarget,
      stage,
    }));
}

function normalizeEventPaths(event) {
  if (!event || typeof event !== "object") return event;
  const normalized = { ...event };
  for (const key of ["file", "entryFile"]) {
    const value = String(normalized[key] ?? "");
    const match = value.match(/\/(docs|live-tests|runtime-tests|scripts|src|test)\/(.+)$/);
    if (match) normalized[key] = join(ROOT, match[1], match[2]);
  }
  return normalized;
}

async function testFiles(directory) {
  return (await readdir(join(ROOT, directory)))
    .filter((file) => file.endsWith(".test.mjs"))
    .sort()
    .map((file) => `${directory}/${file}`);
}

async function groupContractFiles(files) {
  const groups = new Map([
    [COMMON_COMPONENT, { files: new Set(), titles: [] }],
    [MACOS_NATIVE, { files: new Set(), titles: [] }],
    [WINDOWS_NATIVE, { files: new Set(), titles: [] }],
    [WSL_NATIVE, { files: new Set(), titles: [] }],
  ]);
  for (const file of files) {
    const source = await readFile(join(ROOT, file), "utf8");
    const classified = classifyContractTestTitles(source);
    for (const [scope, titles] of classified) {
      if (titles.length) {
        groups.get(scope).files.add(file);
        groups.get(scope).titles.push(...titles);
      }
    }
  }
  return new Map([...groups].map(([scope, group]) => [scope, {
    files: [...group.files],
    namePattern: exactContractNamePattern(group.titles),
  }]));
}

function runtimeFilesForTarget(files, runtimeTarget) {
  return files.filter((file) => {
    const targets = PLATFORM_RUNTIME_TARGETS.get(file);
    return !targets || targets.has(runtimeTarget);
  });
}

function markStale(message) {
  report.status = "stale";
  report.selectedStatus = "stale";
  report.currentRuntimeStatus = "stale";
  report.allSupportedStatus = "stale";
  report.error = message;
}
