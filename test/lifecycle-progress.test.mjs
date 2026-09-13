import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  createLifecycleReport,
  updateLifecycleComponents,
  writeLifecycleReport,
} from "../src/lifecycle-runner.mjs";
import {
  renderLifecycleProgressHtml,
  scheduleLifecycleWithVisibleProgress,
  startLifecycleProgressRenderer,
} from "../src/lifecycle-progress.mjs";
import { useTempDir } from "./helpers.mjs";

test("[A HAR-02 LCH-01] 独立进度页显示当前步骤、完整时间线和回滚结果并自动刷新", () => {
  const report = createLifecycleReport({
    runId: "visible-progress",
    projectVersion: "1.2.3",
    targetRelayProtocol: 52,
    steps: ["verify-package", "launch-updated", "switch-account"],
  });
  report.status = "failed";
  report.steps[0].status = "passed";
  report.steps[1].status = "passed";
  report.steps[1].evidence = { relayProtocol: 52, relayPid: 123 };
  report.steps[2].status = "failed";
  report.steps[2].error = { message: "用量不足 <secret>" };
  report.steps[0].rollback = { status: "passed", evidence: { installedVersion: "1.2.2" } };
  report.finishedAt = new Date().toISOString();
  const html = renderLifecycleProgressHtml(report);
  assert.doesNotMatch(html, /http-equiv="refresh"/);
  assert.match(html, /测试失败，自动回滚已完成/);
  assert.match(html, /验证正式包签名、架构与哈希/);
  assert.match(html, /中继协议 52 · 中继 PID 123/);
  assert.match(html, /回滚：通过 · 安装版本 1.2.2/);
  assert.match(html, /用量不足 &lt;secret&gt;/);
  assert.doesNotMatch(html, /用量不足 <secret>/);
});

test("[A HAR-02 LCH-01] 回滚尚未结束时持续刷新且不提前宣称恢复完成", () => {
  const report = createLifecycleReport({
    runId: "rollback-progress",
    projectVersion: "1.2.3",
    targetRelayProtocol: 53,
    steps: ["launch-updated", "switch-account"],
  });
  report.status = "failed";
  report.ownerPid = 456;
  report.steps[0].status = "passed";
  report.steps[0].evidence = {
    previousCodexPids: [10],
    codexPids: [20],
    injectorPids: [30],
    relayPid: 40,
    relayProtocol: 53,
  };
  report.steps[1].status = "failed";
  report.steps[1].rollback = { status: "running" };
  const html = renderLifecycleProgressHtml(report);
  assert.match(html, /http-equiv="refresh" content="1"/);
  assert.match(html, /测试失败，正在恢复原状态/);
  assert.doesNotMatch(html, /自动回滚已完成/);
  assert.match(html, /监督器 PID：456/);
  assert.match(html, /原 Codex PID 10 · Codex PID 20 · 注入器 PID 30 · 中继协议 53 · 中继 PID 40/);
});

test("[A HAR-02 HAR-03] 报告更新后渲染器刷新页面，停止前写入最终状态", async (t) => {
  const directory = await useTempDir(t);
  const reportPath = join(directory, "report.json");
  const progressPath = join(directory, "progress.html");
  const report = createLifecycleReport({
    runId: "renderer",
    projectVersion: "1.2.3",
    targetRelayProtocol: 52,
    steps: ["verify-package"],
  });
  await writeLifecycleReport(reportPath, report);
  const renderer = await startLifecycleProgressRenderer({
    reportPath,
    outputPath: progressPath,
    intervalMs: 5,
  });
  report.status = "passed";
  report.finishedAt = new Date(Date.now() + 1_000).toISOString();
  report.steps[0].status = "passed";
  report.updatedAt = report.finishedAt;
  await writeLifecycleReport(reportPath, report);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await renderer.stop();
  assert.match(await readFile(progressPath, "utf8"), /生命周期测试全部通过/);
});

test("[A HAR-02 LCH-01] 进度页未成功显示时不调度重启，并留下可读失败终态", async (t) => {
  const directory = await useTempDir(t);
  const reportPath = join(directory, "report.json");
  const progressPath = join(directory, "progress.html");
  const report = createLifecycleReport({
    runId: "visibility-gate",
    projectVersion: "1.2.3",
    targetRelayProtocol: 53,
    steps: ["verify-package"],
  });
  await writeLifecycleReport(reportPath, report);
  let scheduled = 0;
  await assert.rejects(scheduleLifecycleWithVisibleProgress({
    reportPath,
    outputPath: progressPath,
    openPage: async () => { throw new Error("Safari unavailable"); },
    schedule: async () => { scheduled += 1; },
    now: () => new Date("2026-09-12T13:00:00.000Z"),
  }), /Safari unavailable/);
  assert.equal(scheduled, 0);
  const failed = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(failed.status, "failed");
  assert.equal(failed.finishedAt, "2026-09-12T13:00:00.000Z");
  const html = await readFile(progressPath, "utf8");
  assert.match(html, /Safari unavailable/);
  assert.doesNotMatch(html, /http-equiv="refresh"/);
});

test("[A HAR-02 LCH-01] Safari 可见后才把生命周期任务交给外部监督器", async (t) => {
  const directory = await useTempDir(t);
  const reportPath = join(directory, "report.json");
  const progressPath = join(directory, "progress.html");
  await writeLifecycleReport(reportPath, createLifecycleReport({
    runId: "visibility-order",
    projectVersion: "1.2.3",
    targetRelayProtocol: 53,
    steps: ["verify-package"],
  }));
  const order = [];
  await scheduleLifecycleWithVisibleProgress({
    reportPath,
    outputPath: progressPath,
    openPage: async (path) => {
      assert.equal(path, progressPath);
      assert.match(await readFile(path, "utf8"), /等待外部监督器开始/);
      order.push("visible");
    },
    schedule: async () => { order.push("scheduled"); },
  });
  assert.deepEqual(order, ["visible", "scheduled"]);
});

test("[A HAR-02 LCH-02] Windows 报告页分别显示原生、WSL 和自动恢复结果", () => {
  const report = createLifecycleReport({
    runId: "runtime-components",
    projectVersion: "1.2.3",
    targetRelayProtocol: 54,
    steps: ["switch-windows-runtime", "launch-windows-native", "switch-wsl-runtime",
      "launch-wsl-native", "restore-runtime"],
    metadata: { components: {
      "C-windows-native": ["launch-windows-native"],
      "C-wsl-native": ["launch-wsl-native"],
      "C-runtime-switch": ["switch-windows-runtime", "switch-wsl-runtime", "restore-runtime"],
    } },
  });
  for (const step of report.steps) step.status = "passed";
  updateLifecycleComponents(report);
  const html = renderLifecycleProgressHtml(report);
  assert.match(html, /C-windows-native/);
  assert.match(html, /C-wsl-native/);
  assert.match(html, /C-runtime-switch/);
  assert.match(html, /切换到 Windows 原生运行方式/);
  assert.match(html, /恢复测试前的 Codex 运行方式/);
});
