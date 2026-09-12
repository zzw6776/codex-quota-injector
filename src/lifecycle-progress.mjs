import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import process from "node:process";

import { readLifecycleReport, writeLifecycleReport } from "./lifecycle-runner.mjs";

const STEP_LABELS = new Map([
  ["verify-package", "验证正式包签名、架构与哈希"],
  ["install-update", "安装当前版本并保留回滚副本"],
  ["launch-updated", "由正式入口接管并加载目标中继协议"],
  ["repeat-launch", "重复启动与单实例稳定性"],
  ["relay-reconnect", "中继断线与自动恢复"],
  ["close-reopen", "关闭 Codex 后重新启动"],
  ["switch-account", "切换测试账号、重启并发送最小模型请求"],
  ["restore-account", "回切原账号并重新启动"],
  ["final-state", "核对最终安装、账号和进程状态"],
]);

const STATUS_LABELS = new Map([
  ["pending", "等待"],
  ["running", "进行中"],
  ["passed", "通过"],
  ["failed", "失败"],
  ["rollback-failed", "回滚失败"],
  ["prepared", "已准备"],
]);

export function renderLifecycleProgressHtml(report, { refreshSeconds = 1 } = {}) {
  const currentIndex = report.steps.findIndex((step) => step.status === "running");
  const failed = report.steps.find((step) => step.status === "failed");
  const passedCount = report.steps.filter((step) => step.status === "passed").length;
  const rollbackInProgress = report.steps.some((step) => step.rollback?.status === "running");
  const rollbackFailed = report.steps.some((step) => step.rollback?.status === "failed");
  const rolledBack = report.steps.some((step) => step.rollback?.status === "passed");
  const finished = Boolean(report.finishedAt);
  const headline = report.status === "passed"
    ? "生命周期测试全部通过"
    : report.status === "rollback-failed" || rollbackFailed
      ? "测试失败，且有状态未能自动恢复"
      : rollbackInProgress
        ? "测试失败，正在恢复原状态"
      : report.status === "failed"
        ? finished && rolledBack
          ? "测试失败，自动回滚已完成"
          : finished
            ? "生命周期测试失败"
            : "测试失败，准备恢复原状态"
        : currentIndex >= 0
          ? `正在执行 ${currentIndex + 1}/${report.steps.length}：${stepLabel(report.steps[currentIndex].id)}`
          : "等待外部监督器开始";
  const tone = report.status === "passed" ? "passed"
    : ["failed", "rollback-failed"].includes(report.status) ? "failed" : "running";
  const rows = report.steps.map((step, index) => {
    const rollback = step.rollback
      ? `<div class="rollback ${escapeHtml(step.rollback.status)}">回滚：${escapeHtml(statusLabel(step.rollback.status))}${
          step.rollback.error?.message ? ` · ${escapeHtml(step.rollback.error.message)}` : ""
        }${step.rollback.evidence ? ` · ${escapeHtml(evidenceText(step.rollback.evidence))}` : ""}</div>`
      : "";
    const detail = step.error?.message
      ? `<div class="error">${escapeHtml(step.error.message)}</div>`
      : evidenceSummary(step.evidence);
    return `<li class="step ${escapeHtml(step.status)}">
      <span class="index">${index + 1}</span>
      <div class="step-body">
        <div class="step-title"><strong>${escapeHtml(stepLabel(step.id))}</strong><span>${escapeHtml(statusLabel(step.status))}</span></div>
        <div class="time">${escapeHtml(stepTime(step))}</div>
        ${detail}${rollback}
      </div>
    </li>`;
  }).join("\n");
  const failure = failed?.error?.message ?? report.error?.message ?? null;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
${finished ? "" : `<meta http-equiv="refresh" content="${Number(refreshSeconds) || 1}">`}
<meta http-equiv="Cache-Control" content="no-store, no-cache, must-revalidate">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Codex 生命周期测试 · ${escapeHtml(report.runId)}</title>
<style>
:root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f4f5f7;color:#1e2329}
body{margin:0;padding:32px}main{max-width:860px;margin:auto;background:#fff;border-radius:18px;padding:28px;box-shadow:0 12px 40px #1112}
h1{font-size:24px;margin:0 0 8px}.sub{color:#667085;margin-bottom:24px}.banner{padding:16px 18px;border-radius:12px;background:#eef4ff;border-left:5px solid #4f7cff;margin-bottom:22px}.banner.passed{background:#ecfdf3;border-color:#18a558}.banner.failed{background:#fff1f1;border-color:#d92d20}.summary{display:flex;gap:18px;flex-wrap:wrap;color:#475467;font-size:14px}.steps{list-style:none;padding:0;margin:24px 0 0}.step{display:flex;gap:14px;padding:15px 0;border-top:1px solid #eaecf0}.index{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;background:#eaecf0;font-weight:700;flex:none}.step.running .index{background:#4f7cff;color:#fff}.step.passed .index{background:#18a558;color:#fff}.step.failed .index{background:#d92d20;color:#fff}.step-body{flex:1;min-width:0}.step-title{display:flex;justify-content:space-between;gap:16px}.time,.evidence,.rollback{font-size:13px;color:#667085;margin-top:5px}.error{color:#b42318;margin-top:7px;white-space:pre-wrap}.rollback.failed{color:#b42318}.rollback.passed{color:#067647}.footer{margin-top:24px;color:#667085;font-size:13px}.failure{white-space:pre-wrap;margin-top:10px;color:#b42318}
@media(prefers-color-scheme:dark){:root{background:#111318;color:#f5f6f7}main{background:#1b1e24}.sub,.summary,.time,.evidence,.rollback,.footer{color:#aab2c0}.step{border-color:#323741}.index{background:#343a46}.banner{background:#18233b}.banner.passed{background:#102c20}.banner.failed{background:#35191a}}
</style></head><body><main>
<h1>Codex 生命周期测试</h1>
<div class="sub">运行编号 ${escapeHtml(report.runId)} · 正式版本 ${escapeHtml(report.projectVersion)} · 目标中继协议 ${escapeHtml(report.targetRelayProtocol)}</div>
<section class="banner ${tone}"><strong>${escapeHtml(headline)}</strong>${failure ? `<div class="failure">${escapeHtml(failure)}</div>` : ""}</section>
<div class="summary"><span>已通过 ${passedCount}/${report.steps.length}</span><span>总体状态：${escapeHtml(statusLabel(report.status))}</span>${report.ownerPid ? `<span>监督器 PID：${escapeHtml(report.ownerPid)}</span>` : ""}<span>最近更新：${escapeHtml(report.updatedAt ?? report.createdAt ?? "未知")}</span></div>
<ol class="steps">${rows}</ol>
<div class="footer">本页每秒从脱敏报告重新加载。Codex 在测试中会关闭或重启，本页留在${report.platform === "win32" ? "默认浏览器" : " Safari"}中继续显示；页面不参与测试判定。</div>
</main></body></html>`;
}

export async function writeLifecycleProgressPage(reportPath, outputPath) {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const temporary = `${outputPath}.tmp.${process.pid}.${randomUUID()}`;
  await writeFile(temporary, renderLifecycleProgressHtml(report), { mode: 0o600 });
  await rename(temporary, outputPath);
  return report.updatedAt ?? null;
}

export async function scheduleLifecycleWithVisibleProgress({
  reportPath,
  outputPath,
  openPage,
  schedule,
  now = () => new Date(),
} = {}) {
  if (typeof openPage !== "function" || typeof schedule !== "function") {
    throw new Error("生命周期调度缺少进度页或监督器入口");
  }
  await writeLifecycleProgressPage(reportPath, outputPath);
  try {
    await openPage(outputPath);
    return await schedule();
  } catch (error) {
    const report = await readLifecycleReport(reportPath);
    const finishedAt = now().toISOString();
    report.status = "failed";
    report.finishedAt = finishedAt;
    report.updatedAt = finishedAt;
    report.ownerPid = null;
    report.error = publicError(error);
    await writeLifecycleReport(reportPath, report);
    await writeLifecycleProgressPage(reportPath, outputPath);
    throw error;
  }
}

export async function startLifecycleProgressRenderer({
  reportPath,
  outputPath,
  intervalMs = 250,
  onError = (error) => console.error(`[lifecycle-progress] ${error.message}`),
} = {}) {
  let lastUpdatedAt = await writeLifecycleProgressPage(reportPath, outputPath);
  let writing = false;
  let stopped = false;
  const update = async (force = false) => {
    if (writing || stopped && !force) return;
    writing = true;
    try {
      const report = JSON.parse(await readFile(reportPath, "utf8"));
      if (!force && report.updatedAt === lastUpdatedAt) return;
      lastUpdatedAt = await writeLifecycleProgressPage(reportPath, outputPath);
    } finally {
      writing = false;
    }
  };
  const timer = setInterval(() => {
    void update().catch(onError);
  }, intervalMs);
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await update(true);
    },
  };
}

function stepLabel(id) {
  return STEP_LABELS.get(id) ?? id;
}

function statusLabel(status) {
  return STATUS_LABELS.get(status) ?? status;
}

function stepTime(step) {
  if (step.finishedAt) return `${step.startedAt ?? ""} → ${step.finishedAt}`;
  if (step.startedAt) return `开始于 ${step.startedAt}`;
  return "尚未开始";
}

function evidenceSummary(evidence) {
  const summary = evidenceText(evidence);
  return summary ? `<div class="evidence">${escapeHtml(summary)}</div>` : "";
}

function evidenceText(evidence) {
  if (!evidence || typeof evidence !== "object") return "";
  const parts = [];
  if (evidence.version) parts.push(`正式包 ${evidence.version}`);
  if (evidence.architecture) parts.push(`架构 ${evidence.architecture}`);
  if (evidence.previousVersion) parts.push(`原安装 ${evidence.previousVersion}`);
  if (evidence.installedVersion) parts.push(`安装版本 ${evidence.installedVersion}`);
  if (Array.isArray(evidence.previousCodexPids)) parts.push(`原 Codex PID ${evidence.previousCodexPids.join(", ")}`);
  if (Array.isArray(evidence.codexPids)) parts.push(`Codex PID ${evidence.codexPids.join(", ")}`);
  if (Array.isArray(evidence.injectorPids)) parts.push(`注入器 PID ${evidence.injectorPids.join(", ")}`);
  if (evidence.relayProtocol != null) parts.push(`中继协议 ${evidence.relayProtocol}`);
  if (evidence.previousRelayPid != null) parts.push(`原中继 PID ${evidence.previousRelayPid}`);
  if (evidence.relayPid != null) parts.push(`中继 PID ${evidence.relayPid}`);
  if (evidence.debugReady === true) parts.push("调试端口就绪");
  if (evidence.generationMatches === true) parts.push("generation 匹配");
  if (evidence.packagedOwner === true) parts.push("正式包进程已接管");
  if (evidence.account) parts.push(`账号 ${evidence.account}`);
  if (evidence.recovery) parts.push(`恢复方式 ${evidence.recovery}`);
  if (evidence.modelSmoke?.status) {
    parts.push(`账号模型冒烟 ${evidence.modelSmoke.status}${evidence.modelSmoke.model ? ` (${evidence.modelSmoke.model})` : ""}`);
  }
  return parts.join(" · ");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function publicError(error) {
  return {
    name: String(error?.name ?? "Error"),
    code: error?.code == null ? null : String(error.code),
    message: String(error?.message ?? error),
  };
}
