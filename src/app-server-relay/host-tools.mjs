import { randomUUID } from "node:crypto";
import { REQUIRED_CODEX_APP_TOOLS } from "../host-health.mjs";
import { hostToolArguments, isThreadNotMaterialized } from "../host-tool-probes.mjs";
import { MCP_CONFIG_RELOAD_METHOD, HOST_TOOL_RELOAD_TIMEOUT_MS, MCP_STATUS_LIST_METHOD } from "./contract.mjs";
import { rememberPendingRequest } from "./thread-context.mjs";

export const MCP_TOOL_CALL_METHOD = "mcpServer/tool/call";
const MAX_ACTIVE_PROBES = 8;
const TOOL_RETRY_DELAYS_MS = [0, 250, 1_000, 3_000];

function scheduler(state) {
  return state.hostToolScheduler ??= { queue: new Map(), active: new Map(),
    toolRetries: new Map(), closed: false };
}

export function requestCodexAppToolsStatus(state, threadId, {
  retry = false, priority = false, onlyTool = null, resetRetryBudget = false,
} = {}) {
  if (!threadId || !state.hostHealth) return;
  const health = state.hostHealth.snapshot(threadId);
  if (priority) state.hostToolSelectedThread = threadId;
  const jobs = scheduler(state);
  if (jobs.closed) return;
  if (resetRetryBudget) {
    for (const tool of REQUIRED_CODEX_APP_TOOLS) clearToolRetry(state, threadId, tool);
  }
  const revision = state.hostHealth.statusRevision(threadId);
  for (const recovery of jobs.toolRetries.values()) {
    if (recovery.threadId === threadId &&
        (health.serverStatus !== "ready" || recovery.revision !== revision)) {
      clearToolRetry(state, threadId, recovery.tool);
    }
  }
  if (health.serverStatus !== "ready") return;
  for (const [id, job] of jobs.active) {
    if (job.revision === state.hostHealth.statusRevision(job.threadId)) continue;
    const pending = state.pendingRequests.get(id);
    (state.clearHostToolTimer ?? clearTimeout)(pending?.timer);
    if (pending) pending.timer = null;
    jobs.active.delete(id);
  }
  const allPassed = REQUIRED_CODEX_APP_TOOLS.every(tool => health.checks?.[tool]?.status === "passed");
  for (const tool of REQUIRED_CODEX_APP_TOOLS) {
    if (onlyTool && tool !== onlyTool) continue;
    const key = `${threadId}:${tool}`;
    const check = health.checks?.[tool];
    if (check?.status === "checking" || (check && (!retry || (!allPassed && check.status === "passed")))) continue;
    jobs.queue.set(key, { key, threadId, tool, revision });
  }
  drain(state);
}

export function noteHostToolUserMessage(state, threadId) {
  if (!threadId || !state.hostHealth) return;
  state.hostHealth.noteUserMessage(threadId);
  retryTool(state, threadId, "read_thread");
}

function clearToolRetry(state, threadId, tool) {
  const jobs = scheduler(state);
  const key = `${threadId}:${tool}`;
  const recovery = jobs.toolRetries.get(key);
  if (recovery?.timer != null) (state.clearHostToolTimer ?? clearTimeout)(recovery.timer);
  jobs.toolRetries.delete(key);
  jobs.queue.delete(key);
}

function retryTool(state, threadId, tool) {
  const jobs = scheduler(state);
  const context = state.hostHealth.context(threadId);
  if (jobs.closed || context.state.serverStatus !== "ready") return;
  const check = context.state.checks?.[tool];
  if (!check || ["passed", "checking"].includes(check.status)) return;
  // A new task cannot be read before its first user message; do not spend the retry budget yet.
  if (tool === "read_thread" && !context.userMessageObserved && isThreadNotMaterialized(check.detail)) return;
  const revision = state.hostHealth.statusRevision(threadId);
  const key = `${threadId}:${tool}`;
  let recovery = jobs.toolRetries.get(key);
  if (recovery?.revision !== revision) {
    clearToolRetry(state, threadId, tool);
    recovery = { threadId, tool, revision, attempts: 0, timer: null };
    jobs.toolRetries.set(key, recovery);
  }
  const active = [...jobs.active.values()].some(job => job.key === key);
  if (recovery.timer != null || jobs.queue.has(key) || active) {
    state.hostHealth.setToolRetryPending(threadId, tool, true);
    return;
  }
  if (recovery.attempts >= TOOL_RETRY_DELAYS_MS.length) {
    state.hostHealth.setToolRetryPending(threadId, tool, false);
    return;
  }
  const delay = TOOL_RETRY_DELAYS_MS[recovery.attempts];
  state.hostHealth.setToolRetryPending(threadId, tool, true);
  let timer = null;
  const retry = () => {
    if (timer != null && recovery.timer !== timer) return;
    recovery.timer = null;
    if (jobs.closed || jobs.toolRetries.get(key) !== recovery ||
        revision !== state.hostHealth.statusRevision(threadId)) return;
    const health = state.hostHealth.snapshot(threadId);
    if (health.checks?.[tool]?.status === "passed") {
      clearToolRetry(state, threadId, tool);
      return;
    }
    if (health.serverStatus !== "ready" || health.checks?.[tool]?.status === "checking") return;
    recovery.attempts++;
    requestCodexAppToolsStatus(state, threadId, { retry: true, onlyTool: tool });
  };
  if (delay === 0) retry();
  else {
    timer = (state.setHostToolTimer ?? setTimeout)(retry, delay);
    recovery.timer = timer;
    timer?.unref?.();
  }
}

export function resumeHostToolRetry(state, threadId, tool) {
  if (!threadId || !state.hostHealth) return;
  if (state.hostHealth.snapshot(threadId).checks?.[tool]?.status === "passed") {
    clearToolRetry(state, threadId, tool);
  } else retryTool(state, threadId, tool);
}

function drain(state) {
  const jobs = scheduler(state);
  if (jobs.closed || state.hostToolReloadInFlight) return;
  const ordered = [...jobs.queue.values()].sort((a, b) =>
    Number(b.threadId === state.hostToolSelectedThread) - Number(a.threadId === state.hostToolSelectedThread));
  for (const job of ordered) {
    if (jobs.active.size >= MAX_ACTIVE_PROBES) break;
    // A synchronous transport failure can recursively drain the remaining queue.
    if (!jobs.queue.delete(job.key)) continue;
    if (job.revision !== state.hostHealth.statusRevision(job.threadId) ||
        state.hostHealth.snapshot(job.threadId).serverStatus !== "ready") continue;
    const recovery = jobs.toolRetries.get(job.key);
    if (recovery?.timer != null) {
      (state.clearHostToolTimer ?? clearTimeout)(recovery.timer);
      recovery.timer = null;
    }
    const id = `codex-quota-tool-check-${randomUUID()}`;
    const proof = state.hostHealth.beginToolCheck(job.threadId, job.tool, id);
    jobs.active.set(id, job);
    send(state, id, { method: MCP_TOOL_CALL_METHOD, phase: "probe", ...proof }, {
      threadId: job.threadId, server: "codex_app", tool: job.tool,
      arguments: hostToolArguments(job.tool, job.threadId),
    });
  }
}

function send(state, id, pending, params) {
  rememberPendingRequest(state, id, { ...pending, internalHostToolReload: true });
  const request = state.pendingRequests.get(id);
  request.timer = (state.setHostToolTimer ?? setTimeout)(() => {
    request.timer = null;
    request.timedOut = true;
    if (request.phase === "probe") {
      state.hostHealth.observeToolResult(null, null, request, { timeout: true });
      scheduler(state).active.delete(id);
      retryTool(state, request.threadId, request.tool);
      drain(state);
    } else if (request.phase === "reload") {
      state.hostToolReloadInFlight = false;
      state.hostHealth.observeReloadFailed(new Error("刷新工具配置超时，暂未确认结果"));
      drain(state);
    } else {
      state.hostHealth.observeStatusList(null, { message: "工具目录查询超时，暂未确认结果" }, request);
    }
  }, HOST_TOOL_RELOAD_TIMEOUT_MS);
  request.timer?.unref?.();
  try {
    state.sendUpstream({ id, method: pending.method, ...(params === undefined ? {} : { params }) });
  } catch (error) {
    state.pendingRequests.delete(id);
    handleHostToolReloadResponse({ error: { message: error.message } }, request, state);
  }
}

export function requestCodexAppToolsReload(state) {
  if (state.hostToolReloadInFlight) return;
  state.hostToolReloadInFlight = true;
  state.hostHealth?.observeReloadStarted();
  for (const recovery of [...scheduler(state).toolRetries.values()]) {
    clearToolRetry(state, recovery.threadId, recovery.tool);
  }
  scheduler(state).queue.clear();
  const id = `codex-quota-host-tools-reload-${randomUUID()}`;
  state.hostToolReloadRequestId = id;
  send(state, id, { method: MCP_CONFIG_RELOAD_METHOD, phase: "reload", requestId: id });
}

export function requestCodexAppToolsDiagnostic(state, threadId) {
  if (!threadId || !state.hostHealth || [...state.pendingRequests.values()].some(p =>
    p.phase === "diagnose" && p.threadId === threadId && !p.timedOut)) return;
  const id = `codex-quota-host-tools-diagnose-${randomUUID()}`;
  state.hostHealth.update({ diagnostic: { status: "checking", detail: null } }, state.hostHealth.context(threadId));
  send(state, id, { method: MCP_STATUS_LIST_METHOD, phase: "diagnose", threadId,
    healthRevision: state.hostHealth.statusRevision(threadId), pages: [], cursors: [] }, { threadId });
}

export function handleHostToolReloadResponse(message, pending, state) {
  (state.clearHostToolTimer ?? clearTimeout)(pending.timer);
  pending.timer = null;
  if (pending.phase === "probe") {
    const jobs = scheduler(state);
    jobs.active.delete(pending.requestId);
    state.hostHealth?.observeToolResult(message.result, message.error, pending);
    resumeHostToolRetry(state, pending.threadId, pending.tool);
    drain(state);
    return;
  }
  if (pending.phase === "reload") {
    if (pending.requestId !== state.hostToolReloadRequestId) return;
    state.hostToolReloadInFlight = false;
    if (message.error) state.hostHealth?.observeReloadFailed(message.error);
    drain(state);
    return;
  }
  if (pending.healthRevision !== state.hostHealth.statusRevision(pending.threadId)) return;
  const pages = [...pending.pages, ...(message.result?.data ?? [])];
  const cursor = message.result?.nextCursor;
  if (!message.error && cursor) {
    if (pending.cursors.includes(cursor) || pending.cursors.length >= 20) {
      state.hostHealth.observeStatusList(null, { message: "工具目录分页未完成" }, pending);
      return;
    }
    send(state, `codex-quota-host-tools-diagnose-${randomUUID()}`, {
      ...pending, pages, cursors: [...pending.cursors, cursor], timedOut: false,
    }, { threadId: pending.threadId, cursor });
    return;
  }
  state.hostHealth.observeStatusList({ data: pages }, message.error, pending);
}

export function closeHostToolChecks(state) {
  if (!state) return;
  const jobs = scheduler(state);
  jobs.closed = true;
  jobs.queue.clear();
  jobs.active.clear();
  for (const recovery of [...jobs.toolRetries.values()]) {
    clearToolRetry(state, recovery.threadId, recovery.tool);
  }
  for (const pending of state.pendingRequests.values()) {
    if (pending.internalHostToolReload) (state.clearHostToolTimer ?? clearTimeout)(pending.timer);
  }
}
