import { bindLifecycleTask } from "./lifecycle-task-tools.mjs";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import packageJson from "../package.json" with { type: "json" };
import {
  DEFAULT_WINDOWS_INSTALL_DIR,
  inspectLifecycleHost,
} from "../src/lifecycle-host.mjs";
import {
  scheduleLifecycleWithVisibleProgress,
  writeLifecycleProgressPage,
} from "../src/lifecycle-progress.mjs";
import {
  createLifecycleReport,
  lifecycleResumeDecision,
  readLatestUnfinishedLifecycle,
  readLifecycleReport,
  validateLifecycleControl,
  writeLifecycleReport,
} from "../src/lifecycle-runner.mjs";
import { captureCodexSessionCheckpoint } from "../src/lifecycle-turn-gate.mjs";
import { RELAY_PROTOCOL_VERSION } from "../src/relay-contract.mjs";
import {
  createWindowsLifecyclePlan,
  captureWindowsRuntimeConfiguration,
  verifyWindowsInstaller,
  windowsScheduledTaskScript,
  writePrivateJson,
} from "./lifecycle-windows.mjs";
import { RESULTS, ROOT, sourceSnapshot } from "./test-support.mjs";
import { compareTestEvidence } from "./test-impact.mjs";

const execFileAsync = promisify(execFile);
const lifecycleRoot = join(RESULTS, "lifecycle");
const latestPath = join(lifecycleRoot, "latest.json");

export async function runWindowsLifecycleCli(argv = process.argv.slice(2), { initiatingCheckpoint = null, initiatingThreadId = process.env.CODEX_THREAD_ID } = {}) {
  assertWindows();
  const statusArgument = argv.find((arg) => arg === "--status" || arg.startsWith("--status="));
  const resumeArgument = argv.find((arg) => arg.startsWith("--resume="));
  const installerArgument = argv.find((arg) => arg.startsWith("--installer="));
  const known = new Set(["--plan", "--confirm-restart", "--status", "--task-tools-only"]);
  const taskToolsOnly = argv.includes("--task-tools-only");
  for (const argument of argv) {
    if (!known.has(argument) && !argument.startsWith("--status=") &&
      !argument.startsWith("--resume=") &&
      !argument.startsWith("--installer=")) {
      throw new Error(`未知参数 ${argument}`);
    }
  }
  const actions = argv.filter((argument) =>
    argument === "--plan" || argument === "--confirm-restart" || argument === "--status" ||
    argument.startsWith("--status=") || argument.startsWith("--resume=")
  );
  if (actions.length !== 1) {
    throw new Error("请选择一个操作：--plan、--confirm-restart、--status 或 --resume=<run-id>");
  }

  if (statusArgument) {
    const requested = statusArgument.includes("=")
      ? statusArgument.slice(statusArgument.indexOf("=") + 1)
      : null;
    const pointer = requested
      ? { reportPath: join(lifecycleRoot, safeRunId(requested), "report.json") }
      : JSON.parse(await readFile(latestPath, "utf8").catch(() => {
          throw new Error("尚无生命周期测试报告");
        }));
    console.log(JSON.stringify(await readLifecycleReport(pointer.reportPath), null, 2));
    return;
  }

  if (resumeArgument) {
    const runId = safeRunId(resumeArgument.slice("--resume=".length));
    const runDirectory = join(lifecycleRoot, runId);
    const controlPath = join(runDirectory, "control.json");
    const control = JSON.parse(await readFile(controlPath, "utf8"));
    validateLifecycleControl(control, { root: ROOT, runDirectory });
    const report = await readLifecycleReport(control.reportPath);
    const decision = lifecycleResumeDecision(report);
    control.progressPath ??= join(runDirectory, "progress.html");
    await writeLifecycleProgressPage(control.reportPath, control.progressPath);
    await openProgressPage(control.progressPath);
    if (decision === "terminal") {
      throw new Error(`生命周期任务 ${runId} 已以 ${report.status} 结束，不能恢复`);
    }
    if (decision === "already-running") {
      console.log(JSON.stringify({
        status: "already-running",
        runId,
        reportPath: control.reportPath,
        progressPath: control.progressPath,
      }, null, 2));
      return;
    }
    await scheduleWindowsTask(control);
    console.log(JSON.stringify({
      status: "resumed",
      runId,
      reportPath: control.reportPath,
      progressPath: control.progressPath,
    }, null, 2));
    return;
  }

  const defaultInstaller = join(
    ROOT,
    "release",
    "windows",
    `Codex-Quota-Injector-${packageJson.version}-windows-x64-Setup.exe`,
  );
  const installerPath = resolve(installerArgument
    ? installerArgument.slice("--installer=".length)
    : defaultInstaller);
  const unfinishedLifecycle = await readLatestUnfinishedLifecycle(latestPath);
  const plan = {
    ...await createWindowsLifecyclePlan({
    root: ROOT,
    projectVersion: packageJson.version,
    expectedProtocol: RELAY_PROTOCOL_VERSION,
    installerPath,
    }),
    ...(taskToolsOnly ? { scope: "task-tools-startup", tokenRequests: 0,
      accountRoundTrip: "not-run", actions: ["安装当前正式包",
        "自动切换 Windows / WSL，分别启动及关闭重开 Codex",
        "自动打开发起任务并核验其四项必需工具", "恢复测试前运行方式并核对最终状态"] } : {}),
    unfinishedLifecycle: unfinishedLifecycle ? {
      ...unfinishedLifecycle,
      nextCommand: `npm run test:lifecycle -- --resume=${unfinishedLifecycle.runId}`,
    } : null,
  };
  if (argv.includes("--plan")) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  if (!argv.includes("--confirm-restart")) {
    throw new Error("生命周期测试会关闭并重新启动 Codex；请使用 --plan 查看范围");
  }
  if (plan.unfinishedLifecycle) {
    throw new Error(
      `上一次启停恢复测试 ${plan.unfinishedLifecycle.runId} 仍为 ${plan.unfinishedLifecycle.status}；` +
      `请先执行 ${plan.unfinishedLifecycle.nextCommand}`,
    );
  }
  if (plan.wslRuntime.status !== "ready") {
    throw new Error(plan.wslRuntime.reason);
  }
  if (!taskToolsOnly && plan.accountRoundTrip !== "ready") {
    throw new Error("真实账号往返需要当前账号和另一个已保存的 OAuth 账号；前置条件不满足");
  }
  const initialSnapshot = await sourceSnapshot();
  const candidate = await verifyWindowsInstaller(installerPath, {
    projectVersion: packageJson.version,
  });
  const currentSnapshot = await sourceSnapshot();
  if (currentSnapshot.releaseVersion !== initialSnapshot.releaseVersion ||
    currentSnapshot.productionSha256 !== initialSnapshot.productionSha256 ||
    ["windows-native", "wsl-native"].some(runtimeTarget =>
      compareTestEvidence(initialSnapshot, currentSnapshot, { scope: "lifecycle", runtimeTarget }).status !== "reusable")) {
    throw new Error("Windows Setup 准备期间源码发生变化；请重新执行启停恢复测试准备");
  }

  const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const runDirectory = join(lifecycleRoot, runId);
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  const reportPath = join(runDirectory, "report.json");
  const controlPath = join(runDirectory, "control.json");
  const progressPath = join(runDirectory, "progress.html");
  const installedApp = DEFAULT_WINDOWS_INSTALL_DIR;
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  // External preparation may finish after the initiating turn ends.
  // Retain its earlier checkpoint so both native history stores are still audited.
  const sessionCheckpoint = initiatingCheckpoint ?? await captureCodexSessionCheckpoint({ codexHome });
  const initiatingTurn = bindLifecycleTask({ sessionCheckpoint }, initiatingThreadId);
  const runtimeConfiguration = await captureWindowsRuntimeConfiguration({ runDirectory });
  if (runtimeConfiguration.originalRuntime !== plan.currentRuntime) {
    throw new Error("Codex 运行方式在计划与调度之间发生变化；请重新查看启停恢复测试计划");
  }
  const taskName = `CodexQuotaInjector-Lifecycle-${runId}`;
  const initialPrivate = await inspectLifecycleHost({
    installedApp,
    expectedProtocol: RELAY_PROTOCOL_VERSION,
  });
  const report = createLifecycleReport({
    runId,
    projectVersion: packageJson.version,
    targetRelayProtocol: RELAY_PROTOCOL_VERSION,
    steps: taskToolsOnly ? ["verify-package", "wait-desktop-idle", "repair-desktop-history",
      "install-update", "switch-windows-runtime", "launch-windows-native", "reopen-windows-native",
      "switch-wsl-runtime", "launch-wsl-native", "reopen-wsl-native", "restore-runtime", "final-state"] : [
      "verify-package",
      "wait-desktop-idle",
      "repair-desktop-history",
      "install-update",
      "switch-windows-runtime",
      "launch-windows-native",
      "repeat-windows-native",
      "reconnect-windows-native",
      "reopen-windows-native",
      "switch-wsl-runtime",
      "launch-wsl-native",
      "repeat-wsl-native",
      "reconnect-wsl-native",
      "reopen-wsl-native",
      "restore-runtime",
      "switch-account",
      "restore-account",
      "final-state",
    ],
    metadata: {
      batch: plan.batch,
      name: plan.name,
      mode: "windows-task-scheduler-resumable",
      failurePolicy: "stop-without-rollback",
      scope: taskToolsOnly ? "task-tools-startup" : "full",
      interactionMode: "automatic-initiating-task-deep-link",
      currentRuntime: plan.currentRuntime,
      runtimeTargets: plan.runtimeTargets,
      components: {
        "lifecycle-package-common": ["verify-package", "wait-desktop-idle",
          "repair-desktop-history", "install-update"],
        "lifecycle-windows-native": taskToolsOnly ? ["launch-windows-native", "reopen-windows-native"] :
          ["launch-windows-native", "repeat-windows-native", "reconnect-windows-native", "reopen-windows-native"],
        "lifecycle-wsl-native": taskToolsOnly ? ["launch-wsl-native", "reopen-wsl-native"] :
          ["launch-wsl-native", "repeat-wsl-native", "reconnect-wsl-native", "reopen-wsl-native"],
        "lifecycle-runtime-switch": ["switch-windows-runtime", "switch-wsl-runtime", "restore-runtime"],
        ...(taskToolsOnly ? { "lifecycle-final-state": ["final-state"] } :
          { "lifecycle-account-roundtrip": ["switch-account", "restore-account", "final-state"] }),
      },
      originalRuntimeConfiguration: {
        existed: runtimeConfiguration.existed,
        sha256: runtimeConfiguration.sha256,
        runtimeTarget: runtimeConfiguration.originalRuntime,
      },
      sourceSnapshot: initialSnapshot,
      initialHost: plan.host,
      candidate: {
        version: candidate.version,
        architecture: candidate.architecture,
        installerSha256: candidate.installerSha256,
        size: candidate.size,
      },
      tokenPolicy: {
        provider: "official OAuth",
        requests: taskToolsOnly ? 0 : 1,
        purpose: taskToolsOnly ? "只核验任务工具启动，不发送模型请求" : "切换后的账号只回复 OK 的最低价模型冒烟",
        tokenHubResponses: "not-run",
        tokenHubChat: "not-run",
      },
      sessionCheckpoint: {
        capturedAt: sessionCheckpoint.capturedAt,
        turns: sessionCheckpoint.turns.map((turn) => ({
          threadId: threadIdFromRolloutPath(turn.path),
          turnId: turn.turnId,
          startedAt: turn.startedAt,
        })),
      },
    },
  });
  await writeLifecycleReport(reportPath, report);
  const control = {
    version: 2,
    platform: "win32",
    runId,
    root: ROOT,
    reportPath,
    projectVersion: packageJson.version,
    expectedProtocol: RELAY_PROTOCOL_VERSION,
    arch: process.arch,
    installerPath,
    candidate: { installerSha256: candidate.installerSha256 },
    installedApp,
    codexHome,
    sessionCheckpoint,
    initiatingTurn,
    runtimeConfiguration,
    accounts: {
      available: initialPrivate.privateAccountPair.available,
      originalId: initialPrivate.privateAccountPair.currentAccountId,
      targetId: initialPrivate.privateAccountPair.targetAccountId,
    },
    scheduler: { type: "windows-task-scheduler", taskName },
    progressPath,
    startDelayMs: 10_000,
    runtime: {},
  };
  await writePrivateJson(controlPath, control);
  await writePrivateJson(latestPath, { runId, reportPath, progressPath });
  await scheduleLifecycleWithVisibleProgress({
    reportPath,
    outputPath: progressPath,
    openPage: openProgressPage,
    schedule: () => scheduleWindowsTask(control),
  });
  console.log(JSON.stringify({
    status: "scheduled",
    runId,
    startsAfterMs: control.startDelayMs,
    reportPath,
    progressPath,
    statusCommand: `npm run test:lifecycle -- --status=${runId}`,
    note: "监督器由 Windows Task Scheduler 托管；Codex 关闭不会终止它，异常退出或重新登录后会从检查点恢复。",
  }, null, 2));
}

async function scheduleWindowsTask(control) {
  const script = windowsScheduledTaskScript({
    taskName: control.scheduler.taskName,
    nodeExecutable: process.execPath,
    supervisorScript: join(ROOT, "scripts", "lifecycle-supervisor.mjs"),
    controlPath: join(lifecycleRoot, control.runId, "control.json"),
    workingDirectory: ROOT,
  });
  await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
  );
}

async function openProgressPage(progressPath) {
  const script = `Start-Process -FilePath '${powershellQuote(progressPath)}'`;
  await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { windowsHide: true },
  ).catch((error) => {
    throw new Error(`无法打开独立生命周期进度页，未启动重启测试：${error.message}`);
  });
}

function assertWindows() {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error(`当前平台 ${process.platform}/${process.arch} 未实现 Windows x64 生命周期适配器`);
  }
}

function safeRunId(value) {
  const runId = String(value ?? "").trim();
  if (!/^[0-9]{14}-[a-f0-9]{8}$/.test(runId)) throw new Error("生命周期 run ID 无效");
  return runId;
}

function powershellQuote(value) {
  return String(value).replaceAll("'", "''");
}

function threadIdFromRolloutPath(path) {
  return String(path ?? "").match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i)?.[1] ?? null;
}
