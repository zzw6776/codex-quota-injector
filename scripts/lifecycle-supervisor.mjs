#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import { startLifecycleProgressRenderer } from "../src/lifecycle-progress.mjs";
import { runLifecycleReport } from "../src/lifecycle-runner.mjs";
import { createMacLifecycleOperations } from "./lifecycle-macos.mjs";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--control") {
  throw new Error("用法: lifecycle-supervisor.mjs --control <control.json>");
}
const controlPath = resolve(args[1]);
const control = JSON.parse(await readFile(controlPath, "utf8"));
if (control.version !== 1 || control.root !== resolve(import.meta.dirname, "..") ||
  control.reportPath !== resolve(control.root, ".runtime", "test-results", "lifecycle", control.runId, "report.json")) {
  throw new Error("生命周期控制文件不属于当前项目或版本不受支持");
}
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
  const report = await runLifecycleReport({
    reportPath: control.reportPath,
    operations,
  });
  console.log(JSON.stringify({ runId: control.runId, status: report.status, reportPath: control.reportPath }));
} catch (error) {
  console.error(`[lifecycle] ${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
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
