#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import packageJson from "../package.json" with { type: "json" };
import { RELAY_PROTOCOL_VERSION } from "../src/relay-contract.mjs";
import {
  scheduleLifecycleWithVisibleProgress,
  writeLifecycleProgressPage,
} from "../src/lifecycle-progress.mjs";
import {
  createLifecycleReport,
  lifecycleResumeDecision,
  readLifecycleReport,
  validateLifecycleControl,
  writeLifecycleReport,
} from "../src/lifecycle-runner.mjs";
import {
  buildMacLifecycleCandidate,
  createMacLifecyclePlan,
  launchdPlist,
  writePrivateJson,
} from "./lifecycle-macos.mjs";
import { RESULTS, ROOT, sourceSnapshot } from "./test-support.mjs";
import { compareTestEvidence } from "./test-impact.mjs";
import {
  captureMacLifecycleSession,
  inspectMacLifecycleHistory,
  validateMacLifecycleSession,
} from "./lifecycle-macos-session.mjs";

const execFileAsync = promisify(execFile);
const lifecycleRoot = join(RESULTS, "lifecycle");
const latestPath = join(lifecycleRoot, "latest.json");

if (process.platform === "win32") {
  const { runWindowsLifecycleCli } = await import("./test-lifecycle-windows.mjs");
  await runWindowsLifecycleCli(process.argv.slice(2));
  process.exit(0);
}

const argv = process.argv.slice(2);
const statusArgument = argv.find((arg) => arg === "--status" || arg.startsWith("--status="));
const resumeArgument = argv.find((arg) => arg.startsWith("--resume="));
const known = new Set(["--plan", "--confirm-restart", "--status"]);
for (const argument of argv) {
  if (!known.has(argument) && !argument.startsWith("--status=") && !argument.startsWith("--resume=")) {
    throw new Error(`未知参数 ${argument}`);
  }
}
if (argv.filter((arg) => arg === "--plan" || arg === "--confirm-restart" ||
  arg === "--status" || arg.startsWith("--status=") || arg.startsWith("--resume=")).length !== 1) {
  throw new Error("请选择一个操作：--plan、--confirm-restart、--status 或 --resume=<run-id>");
}

if (statusArgument) {
  const requested = statusArgument.includes("=") ? statusArgument.slice(statusArgument.indexOf("=") + 1) : null;
  const pointer = requested
    ? { reportPath: join(lifecycleRoot, safeRunId(requested), "report.json") }
    : JSON.parse(await readFile(latestPath, "utf8").catch(() => {
        throw new Error("尚无生命周期测试报告");
      }));
  console.log(JSON.stringify(await readLifecycleReport(pointer.reportPath), null, 2));
  process.exit(0);
}

if (resumeArgument) {
  assertMacOS();
  const runId = safeRunId(resumeArgument.slice("--resume=".length));
  const runDirectory = join(lifecycleRoot, runId);
  const controlPath = join(runDirectory, "control.json");
  const control = JSON.parse(await readFile(controlPath, "utf8"));
  validateLifecycleControl(control, { root: ROOT, runDirectory });
  validateMacLifecycleSession(control);
  const previousReport = await readLifecycleReport(control.reportPath);
  const decision = lifecycleResumeDecision(previousReport);
  if (decision === "already-running") throw new Error("启停恢复测试监督器仍在运行，拒绝中断并重复启动");
  if (decision === "terminal") {
    console.log(JSON.stringify({ status: previousReport.status, runId, reportPath: control.reportPath }));
    process.exit(0);
  }
  control.progressPath ??= join(runDirectory, "progress.html");
  await writeLifecycleProgressPage(control.reportPath, control.progressPath);
  await openProgressPage(control.progressPath);
  await launchExistingJob(control);
  console.log(JSON.stringify({
    status: "resumed",
    runId,
    reportPath: control.reportPath,
    progressPath: control.progressPath,
  }, null, 2));
  process.exit(0);
}

const plan = await createMacLifecyclePlan({
  root: ROOT,
  projectVersion: packageJson.version,
  expectedProtocol: RELAY_PROTOCOL_VERSION,
});
if (argv.includes("--plan")) {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}

if (!argv.includes("--confirm-restart")) {
  throw new Error("生命周期测试会关闭并重新启动 Codex；请使用 --plan 查看范围");
}
assertMacOS();
if (plan.unfinishedLifecycle) {
  throw new Error(`上一次启停恢复测试 ${plan.unfinishedLifecycle.runId} 尚未完成；` +
    `请先执行 npm run test:lifecycle -- --resume=${plan.unfinishedLifecycle.runId}`);
}
if (plan.accountRoundTrip !== "ready") {
  throw new Error("真实账号往返需要当前账号和另一个已保存的 OAuth 账号；前置条件不满足");
}
const session = await captureMacLifecycleSession();
// Detect structural damage before building or installing anything. The current
// initiating turn may still run; the external supervisor waits for its terminal.
await inspectMacLifecycleHistory(session, { allowActive: true });
const initialSnapshot = await sourceSnapshot();
const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
const runDirectory = join(lifecycleRoot, runId);
await mkdir(runDirectory, { recursive: true, mode: 0o700 });
const candidate = await buildMacLifecycleCandidate({
  root: ROOT,
  runDirectory,
  projectVersion: packageJson.version,
});
const currentSnapshot = await sourceSnapshot();
if (currentSnapshot.releaseVersion !== initialSnapshot.releaseVersion ||
  currentSnapshot.productionSha256 !== initialSnapshot.productionSha256 ||
  compareTestEvidence(initialSnapshot, currentSnapshot, { scope: "lifecycle", runtimeTarget: "macos-native" }).status !== "reusable") {
  throw new Error("正式包构建期间源码发生变化；请重新执行启停恢复测试准备");
}

const reportPath = join(runDirectory, "report.json");
const controlPath = join(runDirectory, "control.json");
const stdoutPath = join(runDirectory, "supervisor.stdout.log");
const stderrPath = join(runDirectory, "supervisor.stderr.log");
const progressPath = join(runDirectory, "progress.html");
const label = `com.zzw6776.codex-quota-injector.lifecycle.${runId}`;
const installedApp = plan.host.installedApp;
const stagingApp = `/Applications/.Codex Quota Injector.${runId}.staging.app`;
const initialPrivate = await import("../src/lifecycle-host.mjs")
  .then(({ inspectLifecycleHost }) => inspectLifecycleHost({
    installedApp,
    expectedProtocol: RELAY_PROTOCOL_VERSION,
  }));
const report = createLifecycleReport({
  runId,
  projectVersion: packageJson.version,
  targetRelayProtocol: RELAY_PROTOCOL_VERSION,
  steps: [
    "verify-package",
    "wait-desktop-idle",
    "install-update",
    "launch-updated",
    "repeat-launch",
    "relay-reconnect",
    "close-reopen",
    "switch-account",
    "restore-account",
    "final-state",
  ],
  metadata: {
    batch: plan.batch,
    name: plan.name,
    mode: "launchd-one-shot",
    failurePolicy: "stop-without-rollback",
    sourceSnapshot: initialSnapshot,
    initialHost: plan.host,
    initiatingTurn: { threadId: session.initiatingTurn.threadId, turnId: session.initiatingTurn.turnId },
    candidate: {
      version: candidate.version,
      architecture: candidate.architecture,
      workerSha256: candidate.workerSha256,
      executableSha256: candidate.executableSha256,
      shimSha256: candidate.shimSha256,
    },
    tokenPolicy: {
      provider: "official OAuth",
      requests: 1,
      purpose: "切换后的账号只回复 OK 的最低价模型冒烟",
      tokenHubResponses: "not-run",
      tokenHubChat: "not-run",
    },
  },
});
await writeLifecycleReport(reportPath, report);
const control = {
  version: 1,
  ...session,
  runId,
  root: ROOT,
  reportPath,
  projectVersion: packageJson.version,
  expectedProtocol: RELAY_PROTOCOL_VERSION,
  arch: process.arch,
  candidateApp: candidate.appPath,
  candidate: {
    workerSha256: candidate.workerSha256,
    executableSha256: candidate.executableSha256,
    shimSha256: candidate.shimSha256,
  },
  installedApp,
  stagingApp,
  initialHost: {
    codexPids: initialPrivate.codexPids,
    injectorPids: initialPrivate.injectorPids,
    relay: initialPrivate.relay,
  },
  accounts: {
    available: initialPrivate.privateAccountPair.available,
    originalId: initialPrivate.privateAccountPair.currentAccountId,
    targetId: initialPrivate.privateAccountPair.targetAccountId,
  },
  launchd: { label },
  progressPath,
  startDelayMs: 0,
  runtime: {},
};
await writePrivateJson(controlPath, control);
await writePrivateJson(latestPath, { runId, reportPath, progressPath });
const plistPath = join(runDirectory, "supervisor.plist");
await writeFile(plistPath, launchdPlist({
  label,
  nodeExecutable: process.execPath,
  supervisorScript: join(ROOT, "scripts", "lifecycle-supervisor.mjs"),
  controlPath,
  workingDirectory: ROOT,
  stdoutPath,
  stderrPath,
}), { mode: 0o600 });
await scheduleLifecycleWithVisibleProgress({
  reportPath,
  outputPath: progressPath,
  openPage: openProgressPage,
  schedule: () => execFileAsync("/bin/launchctl", ["bootstrap", `gui/${process.getuid()}`, plistPath]),
});
console.log(JSON.stringify({
  status: "scheduled",
  runId,
  startsAfter: "活动回合完成且会话历史持久化后",
  reportPath,
  progressPath,
  statusCommand: `npm run test:lifecycle -- --status=${runId}`,
  note: "监督器由 launchd 托管；Codex 关闭不会终止它。",
}, null, 2));

async function launchExistingJob(control) {
  const service = `gui/${process.getuid()}/${control.launchd.label}`;
  const runDirectory = join(lifecycleRoot, control.runId);
  const plistPath = join(runDirectory, "supervisor.plist");
  await writeFile(plistPath, launchdPlist({
    label: control.launchd.label,
    nodeExecutable: process.execPath,
    supervisorScript: join(ROOT, "scripts", "lifecycle-supervisor.mjs"),
    controlPath: join(runDirectory, "control.json"),
    workingDirectory: ROOT,
    stdoutPath: join(runDirectory, "supervisor.stdout.log"),
    stderrPath: join(runDirectory, "supervisor.stderr.log"),
  }), { mode: 0o600 });
  await execFileAsync("/bin/launchctl", ["bootout", service]).catch(() => undefined);
  return execFileAsync("/bin/launchctl", ["bootstrap", `gui/${process.getuid()}`, plistPath]);
}

async function openProgressPage(progressPath) {
  await execFileAsync("/usr/bin/open", ["-a", "Safari", progressPath]).catch((error) => {
    throw new Error(`无法打开独立生命周期进度页，未启动重启测试：${error.message}`);
  });
}

function assertMacOS() {
  if (process.platform !== "darwin") {
    throw new Error(`当前平台 ${process.platform}/${process.arch} 未实现生命周期适配器`);
  }
}

function safeRunId(value) {
  const runId = String(value ?? "").trim();
  if (!/^[0-9]{14}-[a-f0-9]{8}$/.test(runId)) throw new Error("生命周期 run ID 无效");
  return runId;
}
