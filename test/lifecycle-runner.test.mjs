import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  createLifecycleReport,
  lifecycleResumeDecision,
  readLatestUnfinishedLifecycle,
  readLifecycleReport,
  runLifecycleReport,
  validateLifecycleControl,
  writeLifecycleReport,
} from "../src/lifecycle-runner.mjs";
import { useTempDir } from "./helpers.mjs";

test("[A HAR-02 LCH-01 LCH-05] 外部执行器在被测进程退出后继续落盘并完成后续步骤", async (t) => {
  const directory = await useTempDir(t);
  const reportPath = join(directory, "report.json");
  const events = [];
  await writeLifecycleReport(reportPath, createLifecycleReport({
    runId: "survival",
    projectVersion: "1.0.0",
    targetRelayProtocol: 52,
    steps: ["start-target", "stop-target", "write-after-stop"],
  }));
  let targetRunning = false;
  const report = await runLifecycleReport({ reportPath, operations: {
    "start-target": { replaySafe: true, run: async () => { targetRunning = true; events.push("start"); } },
    "stop-target": { replaySafe: true, run: async () => { targetRunning = false; events.push("stop"); } },
    "write-after-stop": { replaySafe: true, run: async () => {
      assert.equal(targetRunning, false);
      events.push("after-stop");
      await writeFile(join(directory, "survived"), "yes");
    } },
  } });
  assert.equal(report.status, "passed");
  assert.deepEqual(events, ["start", "stop", "after-stop"]);
  assert.equal(await readFile(join(directory, "survived"), "utf8"), "yes");
});

test("[A HAR-03 LCH-03] 中断后按检查点核对已完成副作用，不重复执行结果未知动作", async (t) => {
  const directory = await useTempDir(t);
  const reportPath = join(directory, "report.json");
  const report = createLifecycleReport({
    runId: "resume",
    projectVersion: "1.0.0",
    targetRelayProtocol: 52,
    steps: ["install", "launch"],
  });
  report.status = "running";
  report.steps[0].status = "running";
  report.steps[0].attempts = 1;
  await writeLifecycleReport(reportPath, report);
  let installs = 0;
  let launches = 0;
  const result = await runLifecycleReport({ reportPath, operations: {
    install: {
      run: async () => { installs += 1; },
      reconcile: async () => ({ completed: true, evidence: { installedVersion: "1.0.0" } }),
    },
    launch: { replaySafe: true, run: async () => { launches += 1; } },
  } });
  assert.equal(result.status, "passed");
  assert.equal(installs, 0);
  assert.equal(launches, 1);
  assert.equal(result.steps[0].recovered, true);
  assert.deepEqual(result.steps[0].evidence, { installedVersion: "1.0.0" });
});

test("[A HAR-03 ACC-04] 无法确认的账号动作不会重放，失败后反向恢复已完成步骤", async (t) => {
  const directory = await useTempDir(t);
  const reportPath = join(directory, "report.json");
  const report = createLifecycleReport({
    runId: "unknown-account",
    projectVersion: "1.0.0",
    targetRelayProtocol: 52,
    steps: ["install", "switch-account"],
  });
  report.status = "running";
  report.steps[0].status = "passed";
  report.steps[1].status = "running";
  report.steps[1].attempts = 1;
  await writeLifecycleReport(reportPath, report);
  let restored = 0;
  await assert.rejects(runLifecycleReport({ reportPath, operations: {
    install: { run: async () => {}, rollback: async () => { restored += 1; } },
    "switch-account": {
      run: async () => assert.fail("未知结果不能重放"),
      reconcile: async () => ({ completed: false, safeToRetry: false }),
    },
  } }), /结果未知，拒绝自动重放/);
  const saved = await readLifecycleReport(reportPath);
  assert.equal(saved.status, "failed");
  assert.equal(saved.steps[0].rollback.status, "passed");
  assert.equal(restored, 1);
});

test("[A LCH-06] 报告使用原子替换，拒绝未来版本和重复步骤", async (t) => {
  const directory = await useTempDir(t);
  const reportPath = join(directory, "report.json");
  assert.throws(() => createLifecycleReport({ steps: ["same", "same"] }), /必须唯一/);
  const report = createLifecycleReport({ steps: ["verify-package"], targetRelayProtocol: 52 });
  await writeLifecycleReport(reportPath, report);
  assert.equal((await readLifecycleReport(reportPath)).runId, report.runId);
  const files = JSON.parse(await readFile(reportPath, "utf8"));
  files.version = 999;
  await writeFile(reportPath, JSON.stringify(files));
  await assert.rejects(readLifecycleReport(reportPath), /版本不受支持/);
});

test("[A HAR-03 LCH-06] 恢复任务只接受当前项目运行目录内的控制文件路径", async (t) => {
  const root = resolve(await useTempDir(t, "lifecycle-control-"));
  const runDirectory = join(root, ".runtime", "test-results", "lifecycle", "run-1");
  const control = {
    version: 2,
    runId: "run-1",
    root,
    reportPath: join(runDirectory, "report.json"),
    progressPath: join(runDirectory, "progress.html"),
  };
  assert.equal(validateLifecycleControl(control, { root, runDirectory }), control);
  assert.throws(() => validateLifecycleControl({
    ...control,
    reportPath: join(root, "outside", "report.json"),
  }, { root, runDirectory }), /不属于当前项目/);
  assert.throws(() => validateLifecycleControl({
    ...control,
    progressPath: join(root, "outside", "progress.html"),
  }, { root, runDirectory }), /不属于当前项目/);
  assert.throws(() => validateLifecycleControl(control, {
    root,
    runDirectory: join(root, ".runtime", "test-results", "lifecycle", "other-run"),
  }), /不属于当前项目/);
});

test("[A HAR-04 LCH-01] 生命周期报告按公共、Windows、WSL 和切换链分别汇总", async (t) => {
  const directory = await useTempDir(t);
  const reportPath = join(directory, "report.json");
  const report = createLifecycleReport({
    steps: ["verify", "windows", "wsl", "restore"],
    metadata: { components: {
      "C-package-common": ["verify"],
      "C-windows-native": ["windows"],
      "C-wsl-native": ["wsl"],
      "C-runtime-switch": ["restore"],
    } },
  });
  report.steps[0].status = "passed";
  report.steps[1].status = "passed";
  report.steps[2].status = "failed";
  await writeLifecycleReport(reportPath, report);
  assert.deepEqual((await readLifecycleReport(reportPath)).components.map(({ id, status }) => ({ id, status })), [
    { id: "C-package-common", status: "passed" },
    { id: "C-windows-native", status: "passed" },
    { id: "C-wsl-native", status: "failed" },
    { id: "C-runtime-switch", status: "pending" },
  ]);
});

test("[A HAR-03 LCH-05] 新生命周期运行不会覆盖尚未完成或回滚失败的恢复现场", async (t) => {
  const directory = await useTempDir(t);
  const latestPath = join(directory, "latest.json");
  const reportPath = join(directory, "report.json");
  const report = createLifecycleReport({
    runId: "pending-run",
    steps: ["switch-runtime", "restore-runtime"],
  });
  await writeLifecycleReport(reportPath, report);
  await writeFile(latestPath, JSON.stringify({ reportPath, progressPath: "progress.html" }));
  assert.deepEqual(await readLatestUnfinishedLifecycle(latestPath), {
    runId: "pending-run",
    status: "prepared",
    reportPath,
    progressPath: "progress.html",
  });

  report.status = "rollback-failed";
  await writeLifecycleReport(reportPath, report);
  assert.equal((await readLatestUnfinishedLifecycle(latestPath)).status, "rollback-failed");

  report.status = "failed";
  await writeLifecycleReport(reportPath, report);
  assert.equal(await readLatestUnfinishedLifecycle(latestPath), null);
});

test("[A HAR-03 LCH-05] 恢复入口只重新调度确实中断的生命周期任务", () => {
  const report = createLifecycleReport({ steps: ["reopen"] });
  assert.equal(lifecycleResumeDecision(report), "resume");
  report.status = "running";
  report.ownerPid = 123;
  assert.equal(lifecycleResumeDecision(report, { ownerAlive: () => true }), "already-running");
  assert.equal(lifecycleResumeDecision(report, { ownerAlive: () => false }), "resume");
  report.status = "rollback-failed";
  assert.equal(lifecycleResumeDecision(report), "manual-recovery");
  report.status = "passed";
  assert.equal(lifecycleResumeDecision(report), "terminal");
});
