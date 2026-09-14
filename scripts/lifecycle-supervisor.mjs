#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import { notifyLifecycleCompletion } from "../src/lifecycle-completion.mjs";
import { startLifecycleProgressRenderer } from "../src/lifecycle-progress.mjs";
import {
  recoverLifecycleRollbacks,
  runLifecycleReport,
  validateLifecycleControl,
} from "../src/lifecycle-runner.mjs";
import { createMacLifecycleOperations } from "./lifecycle-macos.mjs";

const args = process.argv.slice(2);
const recoveryMode = args[0] === "--recover";
const controlOffset = recoveryMode ? 1 : 0;
if (args.length !== controlOffset + 2 || args[controlOffset] !== "--control") {
  throw new Error("用法: lifecycle-supervisor.mjs [--recover] --control <control.json>");
}
const controlPath = resolve(args[controlOffset + 1]);
const control = JSON.parse(await readFile(controlPath, "utf8"));
validateLifecycleControl(control, {
  root: resolve(import.meta.dirname, ".."),
  runDirectory: resolve(controlPath, ".."),
});
const progress = await startLifecycleProgressRenderer({
  reportPath: control.reportPath,
  outputPath: control.progressPath,
});
await delay(Number(control.startDelayMs) || 0);
try {
  const operations = control.platform === "win32"
    ? await import("./lifecycle-windows.mjs")
      .then(({ createWindowsLifecycleOperations }) => createWindowsLifecycleOperations(controlPath, control))
    : createMacLifecycleOperations(controlPath, control);
  const report = await (recoveryMode ? recoverLifecycleRollbacks : runLifecycleReport)({
    reportPath: control.reportPath,
    operations,
  });
  console.log(JSON.stringify({ runId: control.runId, status: report.status, reportPath: control.reportPath }));
} catch (error) {
  console.error(`[lifecycle] ${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  await notifyLifecycleCompletion({ reportPath: control.reportPath }).then((notification) => {
    if (!notification) return;
    if (notification.status === "activated") {
      console.log(`[lifecycle] 测试已结束，Codex 窗口已置前`);
    } else {
      console.warn(`[lifecycle] 测试已结束，但 Codex 窗口未能自动置前`);
    }
  }).catch((error) => {
    console.warn(`[lifecycle] 无法记录结束唤起结果：${error.message}`);
  });
  await progress.stop().catch((error) => {
    console.error(`[lifecycle-progress] 最终页面写入失败：${error.message}`);
  });
  if (control.scheduler?.type === "windows-task-scheduler") {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
      `Unregister-ScheduledTask -TaskName '${String(control.scheduler.taskName).replaceAll("'", "''")}' -Confirm:$false -ErrorAction SilentlyContinue`,
    ], { windowsHide: true }).catch(() => undefined);
  }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
