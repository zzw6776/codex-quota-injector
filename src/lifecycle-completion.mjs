import process from "node:process";

import { readLifecycleReport, writeLifecycleReport } from "./lifecycle-runner.mjs";
import { activateCodex } from "./platform.mjs";

const TERMINAL_STATUSES = new Set(["passed", "failed", "rollback-failed"]);

export async function notifyLifecycleCompletion({
  reportPath,
  activate = activateCodex,
  now = () => new Date(),
  wait = delay,
  retryDelaysMs = [0, 250, 750],
} = {}) {
  if (!reportPath) throw new Error("缺少生命周期报告路径");
  const report = await readLifecycleReport(reportPath);
  if (!TERMINAL_STATUSES.has(report.status) || !report.finishedAt) return null;

  const attemptedAt = now().toISOString();
  let activated = false;
  let attempts = 0;
  let lastError = null;
  for (const retryDelayMs of retryDelaysMs) {
    if (retryDelayMs > 0) await wait(retryDelayMs);
    attempts += 1;
    try {
      if (await activate()) {
        activated = true;
        break;
      }
    } catch (error) {
      lastError = String(error?.message ?? error);
    }
  }

  const finishedAt = now().toISOString();
  report.completionNotification = {
    status: activated ? "activated" : "failed",
    scope: "codex-window",
    platform: process.platform,
    attempts,
    attemptedAt,
    finishedAt,
    targetThreadIds: initiatingThreadIds(report),
    error: activated ? null : {
      message: lastError ?? "Codex 窗口未响应激活请求",
    },
  };
  report.updatedAt = finishedAt;
  await writeLifecycleReport(reportPath, report);
  return report.completionNotification;
}

function initiatingThreadIds(report) {
  return [...new Set((report.metadata?.sessionCheckpoint?.turns ?? [])
    .map((turn) => turn?.threadId)
    .filter(Boolean))];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
