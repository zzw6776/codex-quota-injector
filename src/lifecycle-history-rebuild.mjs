import { spawn } from "node:child_process";

const MAX_DIAGNOSTIC_LENGTH = 16 * 1024;

export async function requestThreadHistoryRebuild({
  command,
  args = [],
  env = process.env,
  cwd,
  threadIds = [],
  timeoutMs = 30_000,
  spawnProcess = spawn,
} = {}) {
  if (!command) throw new Error("历史重建缺少 app-server 可执行文件");
  const uniqueThreadIds = [...new Set(threadIds.filter(Boolean))];
  if (uniqueThreadIds.length === 0) {
    return { status: "not-applicable", requestedThreadIds: [] };
  }

  const child = spawnProcess(command, args, {
    env,
    ...(cwd ? { cwd } : {}),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let nextId = 0;
  let buffer = "";
  let diagnostics = "";
  let closed = false;
  let closeResult = null;
  const pending = new Map();
  const appendDiagnostic = (value) => {
    diagnostics = `${diagnostics}${String(value ?? "")}`.slice(-MAX_DIAGNOSTIC_LENGTH);
  };
  const failPending = (error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };
  const send = (message) => {
    if (closed || child.stdin.destroyed) throw new Error("历史重建 app-server 已退出");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`历史重建 RPC 超时 ${method}: ${diagnostics}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      send({ id, method, params });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });
  const handleLine = (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      appendDiagnostic(`无法解析 app-server 输出：${line}\n`);
      return;
    }
    if (message.id != null && message.method) {
      send({ id: message.id, error: { code: -32601, message: "历史重建不支持宿主交互" } });
      return;
    }
    if (message.id == null || message.method) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      entry.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
    } else {
      entry.resolve(message.result);
    }
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      handleLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", appendDiagnostic);
  child.stdin.on("error", (error) => failPending(
    new Error(`历史重建 app-server 通信中断：${error.message}`),
  ));
  const completion = new Promise((resolve) => {
    child.once("error", (error) => {
      appendDiagnostic(error.message);
      failPending(error);
    });
    child.once("close", (code, signal) => {
      closed = true;
      closeResult = { code, signal };
      failPending(new Error(
        `历史重建 app-server 提前退出 (${code ?? signal ?? "unknown"}): ${diagnostics}`,
      ));
      resolve();
    });
  });

  try {
    await request("initialize", {
      clientInfo: { name: "codex_quota_lifecycle_history", version: "1" },
      capabilities: { experimentalApi: true },
    });
    send({ method: "initialized", params: {} });
    for (const threadId of uniqueThreadIds) {
      const resumed = await request("thread/resume", { threadId, excludeTurns: true });
      if (resumed?.thread?.id !== threadId) {
        throw new Error(`历史重建恢复了错误任务：期望 ${threadId}`);
      }
    }
    return { status: "requested", requestedThreadIds: uniqueThreadIds };
  } finally {
    if (!child.stdin.destroyed) child.stdin.end();
    const graceful = await Promise.race([
      completion.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 3_000)),
    ]);
    if (!graceful && !child.killed) child.kill("SIGKILL");
    if (!graceful) await completion;
    if (closeResult && closeResult.code != null && closeResult.code !== 0) {
      throw new Error(
        `历史重建 app-server 退出失败 (${closeResult.code})${diagnostics ? `: ${diagnostics}` : ""}`,
      );
    }
  }
}
