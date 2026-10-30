import { randomUUID } from "node:crypto";
import { HOST_HEALTH_STARTUP_GRACE_MS, REQUIRED_CODEX_APP_TOOLS } from "../host-health.mjs";
import { hostToolArguments, isThreadNotMaterialized } from "../host-tool-probes.mjs";
import { MCP_CONFIG_RELOAD_METHOD, HOST_TOOL_RELOAD_TIMEOUT_MS, MCP_STATUS_LIST_METHOD } from "./contract.mjs";
import { rememberPendingRequest } from "./thread-context.mjs";

export const MCP_TOOL_CALL_METHOD = "mcpServer/tool/call";
const MAX_ACTIVE_PROBES = 4;
const TOOL_RETRY_DELAYS_MS = [0, 250, 1_000, 3_000];

export function createHostToolController(state, options = {}) {
  return new HostToolController(state, options);
}

class HostToolController {
  constructor(state, { graceMs = HOST_HEALTH_STARTUP_GRACE_MS } = {}) {
    this.state = state;
    this.health = state.hostHealth;
    this.graceMs = Math.max(0, Number(graceMs) || 0);
    this.queue = new Map();
    this.active = new Map();
    this.retries = new Map();
    this.activeThreadId = null;
    this.activationEpoch = 0;
    this.selection = null;
    this.readyKey = null;
    this.activationTimer = null;
    this.reloadInFlight = false;
    this.reloadRequestId = null;
    this.closed = false;
    this.scheduleTimer = state.setHostToolTimer ?? setTimeout;
    const cancelTimer = state.clearHostToolTimer ?? clearTimeout;
    this.cancelTimer = (timer) => { if (timer != null) cancelTimer(timer); };
  }

  applySelection(selection) {
    if (this.closed) return false;
    const sourceId = String(selection?.sourceId ?? "").trim();
    const revision = Number(selection?.revision);
    const threadId = selection?.threadId == null ? null : String(selection.threadId).trim();
    if (!sourceId || !Number.isSafeInteger(revision) || revision <= 0 ||
        (selection?.threadId != null && !threadId)) return false;
    if (this.selection?.sourceId === sourceId && revision <= this.selection.revision) return false;
    this.selection = { sourceId, revision, threadId };
    this.beginActivation(threadId, { force: false });
    return true;
  }

  selectionMatches(request) {
    return Boolean(this.selection && this.activeThreadId &&
      request?.threadId === this.activeThreadId &&
      request?.selectionSourceId === this.selection.sourceId &&
      Number(request?.selectionRevision) === this.selection.revision);
  }

  handleCommand(request) {
    if (!this.selectionMatches(request)) return false;
    if (request.action === "reload") this.reload();
    else if (request.action === "diagnose") this.diagnose();
    else if (request.action === "check") this.check();
    else return false;
    return true;
  }

  beginActivation(threadId, { force = false } = {}) {
    const previousThreadId = this.activeThreadId;
    this.advanceEpoch();
    this.activeThreadId = threadId;
    if (previousThreadId && previousThreadId !== threadId) {
      void this.health?.deactivateTask(previousThreadId);
    }
    if (!threadId) {
      if (!previousThreadId) void this.health?.projectTask(null);
      return;
    }
    const context = this.health.context(threadId);
    if (["failed", "cancelled"].includes(context.startupStatus)) {
      this.health.activateTask(threadId);
      return;
    }
    const snapshot = this.health.snapshot(threadId);
    if (force || !snapshot.toolsVerified) this.health.prepareVerification(threadId, { force });
    this.health.activateTask(threadId);
    const current = this.health.snapshot(threadId);
    if (current.status === "ready" && current.toolsVerified) return;
    this.startActivationTimer(threadId);
    if (current.serverStatus === "ready") this.handleReady(threadId);
  }

  check() {
    if (!this.activeThreadId || this.closed) return;
    const force = this.health.snapshot(this.activeThreadId).toolsVerified === true;
    this.beginActivation(this.activeThreadId, { force });
  }

  observeStartupStatus(params) {
    const threadId = typeof params?.threadId === "string" ? params.threadId : null;
    if (!threadId || threadId !== this.activeThreadId || this.closed) return;
    const status = String(params?.status ?? "").trim();
    if (status === "ready") {
      this.handleReady(threadId);
      return;
    }
    this.advanceEpoch();
    if (status === "starting") {
      this.health.activateTask(threadId);
      this.startActivationTimer(threadId);
    }
  }

  handleReady(threadId) {
    if (threadId !== this.activeThreadId || this.closed) return;
    const healthRevision = this.health.statusRevision(threadId);
    const readyKey = `${this.activationEpoch}:${healthRevision}`;
    if (readyKey === this.readyKey) {
      this.drain();
      return;
    }
    this.readyKey = readyKey;
    const before = this.health.snapshot(threadId);
    if (!before.toolsVerified) this.health.prepareVerification(threadId);
    this.health.activateTask(threadId);
    const health = this.health.snapshot(threadId);
    if (health.toolsVerified) {
      this.clearActivationTimer();
      return;
    }
    this.startActivationTimer(threadId);
    for (const tool of REQUIRED_CODEX_APP_TOOLS) {
      if (health.checks?.[tool]?.status === "passed") continue;
      this.enqueue(threadId, tool, healthRevision);
    }
    this.drain();
  }

  observeUserMessage(threadId) {
    if (!threadId || !this.health) return;
    this.health.noteUserMessage(threadId);
    if (threadId === this.activeThreadId) this.retryTool(threadId, "read_thread");
  }

  observeToolCompletion(threadId, tool) {
    if (!threadId || !tool || !this.health) return;
    if (this.health.snapshot(threadId).checks?.[tool]?.status === "passed") {
      this.clearRetry(threadId, tool);
    } else if (threadId === this.activeThreadId) {
      this.retryTool(threadId, tool);
    }
  }

  observeThreadClosed(threadId) {
    if (threadId === this.activeThreadId) this.beginActivation(null);
  }

  enqueue(threadId, tool, healthRevision) {
    const key = `${threadId}:${tool}`;
    if ([...this.active.values()].some(job => job.key === key &&
        job.activationEpoch === this.activationEpoch)) return;
    this.queue.set(key, { key, threadId, tool, healthRevision,
      activationEpoch: this.activationEpoch });
  }

  clearQueuedWork() {
    this.queue.clear();
    for (const recovery of [...this.retries.values()]) {
      this.clearRetry(recovery.threadId, recovery.tool);
    }
  }

  advanceEpoch() {
    this.activationEpoch += 1;
    this.readyKey = null;
    this.clearActivationTimer();
    this.clearQueuedWork();
  }

  clearRetry(threadId, tool) {
    const key = `${threadId}:${tool}`;
    const recovery = this.retries.get(key);
    this.cancelTimer(recovery?.timer);
    this.retries.delete(key);
    this.queue.delete(key);
    if (this.health?.snapshot(threadId).checks?.[tool]?.retryPending) {
      this.health.setToolRetryPending(threadId, tool, false);
    }
  }

  retryTool(threadId, tool) {
    if (this.closed || threadId !== this.activeThreadId) return;
    const context = this.health.context(threadId);
    if (context.state.serverStatus !== "ready") return;
    const check = context.state.checks?.[tool];
    if (!check || ["passed", "checking"].includes(check.status)) return;
    if (tool === "read_thread" && !context.userMessageObserved &&
        isThreadNotMaterialized(check.detail)) return;
    const key = `${threadId}:${tool}`;
    const healthRevision = this.health.statusRevision(threadId);
    let recovery = this.retries.get(key);
    if (recovery?.activationEpoch !== this.activationEpoch ||
        recovery?.healthRevision !== healthRevision) {
      this.clearRetry(threadId, tool);
      recovery = { threadId, tool, healthRevision, activationEpoch: this.activationEpoch,
        attempts: 0, timer: null };
      this.retries.set(key, recovery);
    }
    const active = [...this.active.values()].some(job => job.key === key &&
      job.activationEpoch === this.activationEpoch);
    if (recovery.timer != null || this.queue.has(key) || active) {
      this.health.setToolRetryPending(threadId, tool, true);
      return;
    }
    if (recovery.attempts >= TOOL_RETRY_DELAYS_MS.length) {
      this.health.setToolRetryPending(threadId, tool, false);
      return;
    }
    const delay = TOOL_RETRY_DELAYS_MS[recovery.attempts];
    this.health.setToolRetryPending(threadId, tool, true);
    let timer = null;
    const retry = () => {
      if (timer != null && recovery.timer !== timer) return;
      recovery.timer = null;
      if (this.closed || this.retries.get(key) !== recovery ||
          threadId !== this.activeThreadId || recovery.activationEpoch !== this.activationEpoch ||
          healthRevision !== this.health.statusRevision(threadId)) return;
      const health = this.health.snapshot(threadId);
      if (health.checks?.[tool]?.status === "passed") {
        this.clearRetry(threadId, tool);
        return;
      }
      if (health.serverStatus !== "ready" || health.checks?.[tool]?.status === "checking") return;
      recovery.attempts += 1;
      this.enqueue(threadId, tool, healthRevision);
      this.drain();
    };
    if (delay === 0) retry();
    else {
      timer = this.scheduleTimer(retry, delay);
      recovery.timer = timer;
      timer?.unref?.();
    }
  }

  drain() {
    if (this.closed || this.reloadInFlight) return;
    for (const job of [...this.queue.values()]) {
      if (this.active.size >= MAX_ACTIVE_PROBES) break;
      if (!this.queue.delete(job.key)) continue;
      if (job.threadId !== this.activeThreadId || job.activationEpoch !== this.activationEpoch ||
          job.healthRevision !== this.health.statusRevision(job.threadId) ||
          this.health.snapshot(job.threadId).serverStatus !== "ready") continue;
      const recovery = this.retries.get(job.key);
      if (recovery?.timer != null) {
        this.cancelTimer(recovery.timer);
        recovery.timer = null;
      }
      const id = `codex-quota-tool-check-${randomUUID()}`;
      const proof = this.health.beginToolCheck(job.threadId, job.tool, id);
      if (!proof) continue;
      this.clearActivationTimer();
      this.active.set(id, job);
      this.send(id, { method: MCP_TOOL_CALL_METHOD, phase: "probe", ...proof,
        activationEpoch: job.activationEpoch }, {
        threadId: job.threadId, server: "codex_app", tool: job.tool,
        arguments: hostToolArguments(job.tool, job.threadId),
      });
    }
  }

  reload() {
    if (this.reloadInFlight || !this.beginReload()) return;
    this.reloadInFlight = true;
    const id = `codex-quota-host-tools-reload-${randomUUID()}`;
    this.reloadRequestId = id;
    this.send(id, { method: MCP_CONFIG_RELOAD_METHOD, phase: "reload", requestId: id,
      threadId: this.activeThreadId, activationEpoch: this.activationEpoch });
  }

  observeExternalReload() {
    this.beginReload();
  }

  beginReload() {
    if (!this.activeThreadId || this.closed) return false;
    this.advanceEpoch();
    this.health.observeReloadStarted(this.activeThreadId);
    this.startActivationTimer(this.activeThreadId);
    return true;
  }

  diagnose() {
    const threadId = this.activeThreadId;
    if (!threadId || this.closed || [...this.state.pendingRequests.values()].some(p =>
      p.phase === "diagnose" && p.threadId === threadId && !p.timedOut)) return;
    const id = `codex-quota-host-tools-diagnose-${randomUUID()}`;
    this.health.update({ diagnostic: { status: "checking", detail: null } },
      this.health.context(threadId));
    this.send(id, { method: MCP_STATUS_LIST_METHOD, phase: "diagnose", threadId,
      healthRevision: this.health.statusRevision(threadId), activationEpoch: this.activationEpoch,
      pages: [], cursors: [] }, { threadId });
  }

  send(id, pending, params) {
    rememberPendingRequest(this.state, id, { ...pending, internalHostToolReload: true });
    const request = this.state.pendingRequests.get(id);
    request.timer = this.scheduleTimer(() => {
      request.timer = null;
      request.timedOut = true;
      if (request.phase === "probe") {
        this.finishProbe(request, () => {
          this.health.observeToolResult(null, null, request, { timeout: true });
          this.retryTool(request.threadId, request.tool);
        });
      } else if (request.phase === "reload") {
        this.finishReload(request, new Error("刷新工具配置超时，暂未确认结果"));
      } else if (this.isCurrent(request)) {
        this.health.observeStatusList(null, { message: "工具目录查询超时，暂未确认结果" }, request);
      }
    }, HOST_TOOL_RELOAD_TIMEOUT_MS);
    request.timer?.unref?.();
    try {
      this.state.sendUpstream({ id, method: pending.method,
        ...(params === undefined ? {} : { params }) });
    } catch (error) {
      this.state.pendingRequests.delete(id);
      this.handleResponse({ error: { message: error.message } }, request);
    }
  }

  isCurrent(value) {
    return !this.closed && value?.threadId === this.activeThreadId &&
      value?.activationEpoch === this.activationEpoch &&
      (value?.healthRevision == null ||
        value.healthRevision === this.health.statusRevision(value.threadId));
  }

  finishProbe(pending, onCurrent) {
    this.active.delete(pending.requestId);
    if (this.isCurrent(pending)) onCurrent();
    this.drain();
  }

  finishReload(pending, error = null) {
    if (pending.requestId !== this.reloadRequestId) return;
    this.reloadInFlight = false;
    if (error && this.isCurrent(pending)) {
      this.health.observeReloadFailed(error, pending.threadId);
    }
    this.drain();
  }

  handleResponse(message, pending) {
    this.cancelTimer(pending.timer);
    pending.timer = null;
    if (pending.phase === "probe") {
      this.finishProbe(pending, () => {
        this.health.observeToolResult(message.result, message.error, pending);
        this.observeToolCompletion(pending.threadId, pending.tool);
      });
      return;
    }
    if (pending.phase === "reload") {
      this.finishReload(pending, message.error);
      return;
    }
    if (!this.isCurrent(pending)) return;
    const pages = [...pending.pages, ...(message.result?.data ?? [])];
    const cursor = message.result?.nextCursor;
    if (!message.error && cursor) {
      if (pending.cursors.includes(cursor) || pending.cursors.length >= 20) {
        this.health.observeStatusList(null, { message: "工具目录分页未完成" }, pending);
        return;
      }
      this.send(`codex-quota-host-tools-diagnose-${randomUUID()}`, {
        ...pending, pages, cursors: [...pending.cursors, cursor], timedOut: false,
      }, { threadId: pending.threadId, cursor });
      return;
    }
    this.health.observeStatusList({ data: pages }, message.error, pending);
  }

  startActivationTimer(threadId) {
    this.clearActivationTimer();
    if (!threadId || this.closed || !this.health?.path) return;
    const activationEpoch = this.activationEpoch;
    const healthRevision = this.health.statusRevision(threadId);
    this.activationTimer = this.scheduleTimer(() => {
      if (this.closed || threadId !== this.activeThreadId ||
          activationEpoch !== this.activationEpoch) return;
      this.activationTimer = null;
      this.health.markActivationTimeout(threadId, healthRevision);
    }, this.graceMs);
    this.activationTimer?.unref?.();
  }

  clearActivationTimer() {
    this.cancelTimer(this.activationTimer);
    this.activationTimer = null;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.clearActivationTimer();
    this.clearQueuedWork();
    this.active.clear();
    for (const pending of this.state.pendingRequests.values()) {
      if (pending.internalHostToolReload) this.cancelTimer(pending.timer);
    }
  }
}

export { HostToolController };
