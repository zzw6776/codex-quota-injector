import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, readFile } from "node:fs/promises";
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
  readLifecycleReport,
  writeLifecycleReport,
} from "../src/lifecycle-runner.mjs";
import { RELAY_PROTOCOL_VERSION } from "../src/relay-contract.mjs";
import {
  createWindowsLifecyclePlan,
  verifyWindowsInstaller,
  windowsScheduledTaskScript,
  writePrivateJson,
} from "./lifecycle-windows.mjs";
import { requireFreeResult, RESULTS, ROOT, sourceSnapshot } from "./test-support.mjs";

const execFileAsync = promisify(execFile);
const lifecycleRoot = join(RESULTS, "lifecycle");
const latestPath = join(lifecycleRoot, "latest.json");

export async function runWindowsLifecycleCli(argv = process.argv.slice(2)) {
  assertWindows();
  const statusArgument = argv.find((arg) => arg === "--status" || arg.startsWith("--status="));
  const resumeArgument = argv.find((arg) => arg.startsWith("--resume="));
  const installerArgument = argv.find((arg) => arg.startsWith("--installer="));
  const known = new Set(["--plan", "--confirm-restart", "--status"]);
  for (const argument of argv) {
    if (!known.has(argument) && !argument.startsWith("--status=") &&
      !argument.startsWith("--resume=") && !argument.startsWith("--installer=")) {
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
    control.progressPath ??= join(runDirectory, "progress.html");
    await writeLifecycleProgressPage(control.reportPath, control.progressPath);
    await openProgressPage(control.progressPath);
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
  const plan = await createWindowsLifecyclePlan({
    root: ROOT,
    projectVersion: packageJson.version,
    expectedProtocol: RELAY_PROTOCOL_VERSION,
    installerPath,
  });
  if (argv.includes("--plan")) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  if (!argv.includes("--confirm-restart")) {
    throw new Error("生命周期测试会关闭并重新启动 Codex；请使用 --plan 查看范围");
  }
  if (plan.installationState === "blocked-inconsistent-install") {
    throw new Error("Windows 安装目录与卸载注册版本不一致；为避免覆盖未知安装，生命周期测试已停止");
  }
  if (plan.sourceRecovery === "blocked-missing-native-relay") {
    throw new Error("首次安装前缺少 Windows 开发版原生 relay；请先运行 npm run build:relay:windows，确保失败时能恢复源码入口");
  }
  if (plan.accountRoundTrip !== "ready") {
    throw new Error("真实账号往返需要当前账号和另一个已保存的 OAuth 账号；前置条件不满足");
  }
  const free = await requireFreeResult();
  const candidate = await verifyWindowsInstaller(installerPath, {
    projectVersion: packageJson.version,
  });
  const currentSnapshot = await sourceSnapshot();
  if (currentSnapshot.sha256 !== free.snapshot.sha256) {
    throw new Error("Windows Setup 准备期间源码发生变化；请重新运行 npm run test:offline");
  }

  const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const runDirectory = join(lifecycleRoot, runId);
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  const reportPath = join(runDirectory, "report.json");
  const controlPath = join(runDirectory, "control.json");
  const progressPath = join(runDirectory, "progress.html");
  const installedApp = DEFAULT_WINDOWS_INSTALL_DIR;
  const backupApp = join(runDirectory, "installed-backup");
  const taskName = `CodexQuotaInjector-Lifecycle-${runId}`;
  const initialPrivate = await inspectLifecycleHost({
    installedApp,
    expectedProtocol: RELAY_PROTOCOL_VERSION,
  });
  const installedPresent = await access(installedApp).then(() => true, () => false);
  if (installedPresent !== Boolean(initialPrivate.installedVersion)) {
    throw new Error("Windows 安装目录与卸载注册版本在调度前不一致；未开始更新");
  }
  const report = createLifecycleReport({
    runId,
    projectVersion: packageJson.version,
    targetRelayProtocol: RELAY_PROTOCOL_VERSION,
    steps: [
      "verify-package",
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
      mode: "windows-task-scheduler-one-shot",
      sourceSnapshot: free.snapshot,
      initialHost: plan.host,
      candidate: {
        version: candidate.version,
        architecture: candidate.architecture,
        installerSha256: candidate.installerSha256,
        size: candidate.size,
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
    backupApp,
    sourceRecoveryRelay: plan.sourceRecoveryRelay,
    initialHost: {
      installedPresent,
      installedVersion: initialPrivate.installedVersion,
      codexPids: initialPrivate.codexPids,
      injectorPids: initialPrivate.injectorPids,
      relay: initialPrivate.relay,
    },
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
    note: "监督器由 Windows Task Scheduler 托管；Codex 关闭不会终止它。",
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
