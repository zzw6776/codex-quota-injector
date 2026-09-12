import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const LIFECYCLE_REPORT_VERSION = 1;

export function createLifecycleReport({
  runId = randomUUID(),
  platform = process.platform,
  arch = process.arch,
  projectVersion,
  targetRelayProtocol,
  steps,
  metadata = {},
  now = () => new Date(),
} = {}) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error("生命周期测试至少需要一个步骤");
  }
  const ids = steps.map((step) => String(step));
  if (ids.some((id) => !/^[a-z][a-z0-9-]*$/.test(id)) || new Set(ids).size !== ids.length) {
    throw new Error("生命周期步骤 ID 必须唯一且只能使用小写字母、数字和连字符");
  }
  const createdAt = now().toISOString();
  return {
    version: LIFECYCLE_REPORT_VERSION,
    runId,
    status: "prepared",
    platform,
    arch,
    projectVersion: String(projectVersion ?? "unknown"),
    targetRelayProtocol: Number(targetRelayProtocol),
    createdAt,
    updatedAt: createdAt,
    ownerPid: null,
    metadata,
    steps: ids.map((id) => ({
      id,
      status: "pending",
      attempts: 0,
      startedAt: null,
      finishedAt: null,
      recovered: false,
      evidence: null,
      error: null,
      rollback: null,
    })),
    error: null,
  };
}

export async function readLifecycleReport(path) {
  const report = JSON.parse(await readFile(path, "utf8"));
  validateLifecycleReport(report);
  return report;
}

export async function writeLifecycleReport(path, report) {
  validateLifecycleReport(report);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function runLifecycleReport({
  reportPath,
  operations,
  now = () => new Date(),
  ownerPid = process.pid,
} = {}) {
  if (!reportPath) throw new Error("缺少生命周期报告路径");
  const releaseLock = await acquireLifecycleLock(`${reportPath}.lock`, ownerPid);
  let report;
  try {
    report = await readLifecycleReport(reportPath);
    if (["passed", "failed", "rollback-failed"].includes(report.status)) return report;
    report.status = "running";
    report.ownerPid = ownerPid;
    report.updatedAt = now().toISOString();
    await writeLifecycleReport(reportPath, report);

    for (const step of report.steps) {
      if (step.status === "passed") continue;
      const operation = operations?.[step.id];
      if (!operation || typeof operation.run !== "function") {
        throw new Error(`生命周期步骤 ${step.id} 没有执行实现`);
      }

      if (step.status === "running") {
        const recovery = typeof operation.reconcile === "function"
          ? await operation.reconcile(createContext(reportPath, report, step))
          : null;
        if (recovery?.completed === true) {
          step.status = "passed";
          step.recovered = true;
          step.evidence = recovery.evidence ?? null;
          step.finishedAt = now().toISOString();
          report.updatedAt = step.finishedAt;
          await writeLifecycleReport(reportPath, report);
          continue;
        }
        if (!operation.replaySafe && recovery?.safeToRetry !== true) {
          throw new Error(`步骤 ${step.id} 上次结果未知，拒绝自动重放`);
        }
      }

      step.status = "running";
      step.attempts += 1;
      step.startedAt = now().toISOString();
      step.finishedAt = null;
      step.error = null;
      report.updatedAt = step.startedAt;
      await writeLifecycleReport(reportPath, report);
      const evidence = await operation.run(createContext(reportPath, report, step));
      step.status = "passed";
      step.evidence = evidence ?? null;
      step.finishedAt = now().toISOString();
      report.updatedAt = step.finishedAt;
      await writeLifecycleReport(reportPath, report);
    }

    report.status = "passed";
    report.ownerPid = null;
    report.finishedAt = now().toISOString();
    report.updatedAt = report.finishedAt;
    await writeLifecycleReport(reportPath, report);
    return report;
  } catch (error) {
    if (!report) throw error;
    const activeStep = report.steps.find((step) => step.status === "running");
    if (activeStep) {
      activeStep.status = "failed";
      activeStep.error = publicError(error);
      activeStep.finishedAt = now().toISOString();
    }
    report.status = "failed";
    report.error = publicError(error);
    report.updatedAt = now().toISOString();
    await writeLifecycleReport(reportPath, report);

    let rollbackFailed = false;
    for (const step of [...report.steps].reverse()) {
      const operation = operations?.[step.id];
      if (!["passed", "failed"].includes(step.status) || typeof operation?.rollback !== "function") {
        continue;
      }
      step.rollback = { status: "running", startedAt: now().toISOString() };
      report.updatedAt = step.rollback.startedAt;
      await writeLifecycleReport(reportPath, report);
      try {
        const evidence = await operation.rollback(createContext(reportPath, report, step));
        step.rollback = {
          ...step.rollback,
          status: "passed",
          finishedAt: now().toISOString(),
          evidence: evidence ?? null,
        };
      } catch (rollbackError) {
        rollbackFailed = true;
        step.rollback = {
          ...step.rollback,
          status: "failed",
          finishedAt: now().toISOString(),
          error: publicError(rollbackError),
        };
      }
      report.updatedAt = step.rollback.finishedAt;
      await writeLifecycleReport(reportPath, report);
    }
    report.status = rollbackFailed ? "rollback-failed" : "failed";
    report.ownerPid = null;
    report.finishedAt = now().toISOString();
    report.updatedAt = report.finishedAt;
    await writeLifecycleReport(reportPath, report);
    error.lifecycleReport = report;
    throw error;
  } finally {
    await releaseLock();
  }
}

export function validateLifecycleReport(report) {
  if (!report || report.version !== LIFECYCLE_REPORT_VERSION) {
    throw new Error("生命周期报告版本不受支持");
  }
  if (!report.runId || !Array.isArray(report.steps) || report.steps.length === 0) {
    throw new Error("生命周期报告结构不完整");
  }
  const ids = report.steps.map((step) => step?.id);
  if (ids.some((id) => typeof id !== "string") || new Set(ids).size !== ids.length) {
    throw new Error("生命周期报告步骤无效");
  }
}

function createContext(reportPath, report, step) {
  return { reportPath, report, step };
}

async function acquireLifecycleLock(path, ownerPid) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ ownerPid, createdAt: new Date().toISOString() })}\n`);
      await handle.close();
      return async () => rm(path, { force: true });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const lock = JSON.parse(await readFile(path, "utf8").catch(() => "{}"));
      if (isProcessAlive(lock.ownerPid)) {
        throw new Error(`生命周期测试已有执行器运行（PID ${lock.ownerPid}）`);
      }
      await rm(path, { force: true });
    }
  }
  throw new Error("无法取得生命周期测试锁");
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function publicError(error) {
  return {
    name: String(error?.name ?? "Error"),
    code: error?.code == null ? null : String(error.code),
    message: String(error?.message ?? error),
  };
}
