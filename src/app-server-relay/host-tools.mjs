import { randomUUID } from "node:crypto";
import { REQUIRED_CODEX_APP_TOOLS } from "../host-health.mjs";
import { hostToolArguments } from "../host-tool-probes.mjs";
import { MCP_CONFIG_RELOAD_METHOD, HOST_TOOL_RELOAD_TIMEOUT_MS, MCP_STATUS_LIST_METHOD } from "./contract.mjs";
import { rememberPendingRequest } from "./thread-context.mjs";

export const MCP_TOOL_CALL_METHOD = "mcpServer/tool/call";
const MAX_ACTIVE_PROBES = 8;

function scheduler(state) {
  return state.hostToolScheduler ??= { queue: new Map(), active: new Map(), closed: false };
}

export function requestCodexAppToolsStatus(state, threadId, { retry = false, priority = false } = {}) {
  if (!threadId || !state.hostHealth) return;
  const health = state.hostHealth.snapshot(threadId);
  if (priority) state.hostToolSelectedThread = threadId;
  if (health.serverStatus !== "ready") return;
  const jobs = scheduler(state);
  for (const [id, job] of jobs.active) {
    if (job.revision === state.hostHealth.statusRevision(job.threadId)) continue;
    const pending = state.pendingRequests.get(id);
    (state.clearHostToolTimer ?? clearTimeout)(pending?.timer);
    if (pending) pending.timer = null;
    jobs.active.delete(id);
  }
  const revision = state.hostHealth.statusRevision(threadId);
  const allPassed = REQUIRED_CODEX_APP_TOOLS.every(tool => health.checks?.[tool]?.status === "passed");
  for (const tool of REQUIRED_CODEX_APP_TOOLS) {
    const key = `${threadId}:${tool}`;
    const check = health.checks?.[tool];
    if (check?.status === "checking" || (check && (!retry || (!allPassed && check.status === "passed")))) continue;
    jobs.queue.set(key, { key, threadId, tool, revision });
  }
  drain(state);
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
    scheduler(state).active.delete(pending.requestId);
    state.hostHealth?.observeToolResult(message.result, message.error, pending);
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
  for (const pending of state.pendingRequests.values()) {
    if (pending.internalHostToolReload) (state.clearHostToolTimer ?? clearTimeout)(pending.timer);
  }
}
