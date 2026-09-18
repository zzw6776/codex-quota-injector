import { randomUUID } from "node:crypto";
import { watch as watchFs } from "node:fs";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { isRelayStateCurrent } from "./platform.mjs";
import { classifyHostToolResult } from "./host-tool-probes.mjs";

export const HOST_HEALTH_STATE_VERSION = 4;
export const HOST_HEALTH_STARTUP_GRACE_MS = 30_000;
export const HOST_HEALTH_ACTIVE_POLL_MS = 3_000;
export const HOST_HEALTH_READY_POLL_MS = 30_000;
export const HOST_HEALTH_WATCH_DEBOUNCE_MS = 100;
export const HOST_TOOL_RELOAD_REQUEST_VERSION = 2;
export const REQUIRED_CODEX_APP_TOOLS = Object.freeze([
  "list_threads",
  "read_thread",
  "list_projects",
  "get_usage_limits",
]);

const CODEX_APP_SERVER = "codex_app";
const STARTUP_STATUS_METHOD = "mcpServer/startupStatus/updated";
const STATUS_LIST_METHOD = "mcpServerStatus/list";
const HEALTH_DETAIL_LIMIT = 600;

export function hostHealthPollInterval(status) {
  return ["idle", "ready", "direct"].includes(String(status ?? ""))
    ? HOST_HEALTH_READY_POLL_MS
    : HOST_HEALTH_ACTIVE_POLL_MS;
}

export async function requestHostToolReload(binding, {
  requestId = randomUUID(),
  now = Date.now(),
  action = "reload",
  threadId = null,
} = {}) {
  const healthPath = String(binding?.healthPath ?? "").trim();
  const generation = String(binding?.generation ?? "").trim();
  if (!binding?.hostToolsRequired || !healthPath || !generation) {
    throw new Error("当前启动入口没有可重载的 Codex 任务工具中继");
  }
  const normalizedRequestId = String(requestId ?? "").trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(normalizedRequestId)) {
    throw new Error("Codex 任务工具重载请求 ID 无效");
  }
  if (!["reload", "check", "diagnose", "select"].includes(action) ||
      (action !== "reload" && (typeof threadId !== "string" || !threadId))) {
    throw new Error("请选择需要检查的本机任务");
  }
  const directory = dirname(healthPath);
  const path = `${healthPath}.reload-${normalizedRequestId}.json`;
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporaryPath, `${JSON.stringify({
      version: HOST_TOOL_RELOAD_REQUEST_VERSION,
      requestId: normalizedRequestId,
      generation,
      requestedAt: Number(now) || Date.now(),
      action,
      threadId,
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  return { requestId: normalizedRequestId, path };
}

export function watchHostToolReloadRequests({ healthPath, generation } = {}, {
  onRequest = () => {},
  onError = () => {},
  watchImpl = watchFs,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  debounceMs = HOST_HEALTH_WATCH_DEBOUNCE_MS,
} = {}) {
  const normalizedHealthPath = String(healthPath ?? "").trim();
  const normalizedGeneration = String(generation ?? "").trim();
  if (!normalizedHealthPath || !normalizedGeneration) {
    return { active: false, close() {} };
  }
  const directory = dirname(normalizedHealthPath);
  const prefix = `${basename(normalizedHealthPath)}.reload-`;
  let watcher = null;
  let timer = null;
  let closed = false;
  let scanning = false;
  let scanAgain = false;

  const close = () => {
    if (closed) return;
    closed = true;
    if (timer != null) clearTimer(timer);
    timer = null;
    watcher?.close?.();
    watcher = null;
  };
  const scan = async () => {
    if (closed) return;
    if (scanning) {
      scanAgain = true;
      return;
    }
    scanning = true;
    try {
      const names = (await readdir(directory))
        .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
        .sort();
      for (const name of names) {
        if (closed) break;
        const path = join(directory, name);
        let request = null;
        try {
          request = JSON.parse(await readFile(path, "utf8"));
        } catch (error) {
          if (error?.code !== "ENOENT") onError(error);
        } finally {
          await unlink(path).catch(() => undefined);
        }
        if (request?.version !== HOST_TOOL_RELOAD_REQUEST_VERSION ||
          request?.generation !== normalizedGeneration ||
          !/^[A-Za-z0-9_-]{8,128}$/.test(String(request?.requestId ?? ""))) continue;
        if (!["reload", "check", "diagnose", "select"].includes(request.action) ||
            (request.action !== "reload" && !request.threadId)) continue;
        try {
          await onRequest(request);
        } catch (error) {
          onError(error);
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") onError(error);
    } finally {
      scanning = false;
      if (scanAgain && !closed) {
        scanAgain = false;
        void scan();
      }
    }
  };
  const schedule = () => {
    if (closed) return;
    if (timer != null) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      void scan();
    }, debounceMs);
    timer?.unref?.();
  };
  try {
    watcher = watchImpl(directory, { persistent: false }, (_eventType, fileName) => {
      if (fileName && !String(fileName).startsWith(prefix)) return;
      schedule();
    });
    watcher.on?.("error", onError);
    schedule();
  } catch (error) {
    onError(error);
    close();
  }
  return {
    get active() { return !closed && watcher != null; },
    close,
  };
}

export function watchHostHealthFiles(binding, {
  onChange = () => {},
  onError = () => {},
  watchImpl = watchFs,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  debounceMs = HOST_HEALTH_WATCH_DEBOUNCE_MS,
} = {}) {
  const paths = binding?.hostToolsRequired
    ? [...new Set([binding.statePath, binding.healthPath]
        .map((value) => String(value ?? "").trim())
        .filter(Boolean))]
    : [];
  const directories = new Map();
  for (const path of paths) {
    const directory = dirname(path);
    if (!directories.has(directory)) directories.set(directory, new Set());
    directories.get(directory).add(basename(path));
  }
  const watchers = [];
  let timer = null;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    if (timer != null) clearTimer(timer);
    timer = null;
    for (const watcher of watchers.splice(0)) watcher.close?.();
  };
  const fail = (error) => {
    if (closed) return;
    close();
    onError(error);
  };
  const schedule = () => {
    if (closed) return;
    if (timer != null) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      if (!closed) onChange();
    }, debounceMs);
    timer?.unref?.();
  };

  try {
    for (const [directory, names] of directories) {
      const watcher = watchImpl(
        directory,
        { persistent: false },
        (_eventType, fileName) => {
          if (fileName && !names.has(String(fileName))) return;
          schedule();
        },
      );
      watchers.push(watcher);
      watcher.on?.("error", fail);
    }
  } catch (error) {
    fail(error);
  }
  return {
    get active() { return !closed && watchers.length > 0; },
    close,
  };
}

export async function createHostHealthTracker({
  path,
  generation,
  runtimeTarget,
  processIdentity = {},
  claim = true,
  requiredTools = REQUIRED_CODEX_APP_TOOLS,
  graceMs = HOST_HEALTH_STARTUP_GRACE_MS,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const tracker = new HostHealthTracker({
    path,
    generation,
    runtimeTarget,
    processIdentity,
    requiredTools,
    graceMs,
    now,
    setTimer,
    clearTimer,
  });
  await tracker.start({ claim });
  return tracker;
}

class HostHealthTracker {
  constructor({
    path,
    generation,
    runtimeTarget,
    processIdentity,
    requiredTools,
    graceMs,
    now,
    setTimer,
    clearTimer,
  }) {
    this.path = String(path ?? "").trim();
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.graceMs = Math.max(0, Number(graceMs) || 0);
    this.requiredTools = normalizeToolNames(requiredTools);
    this.sessionId = randomUUID();
    this.contexts = new Map();
    this.revision = 0;
    this.tail = Promise.resolve();
    this.closed = false;
    this.toolCalls = new Map();
    const startedAt = this.now();
    this.state = {
      version: HOST_HEALTH_STATE_VERSION,
      sessionId: this.sessionId,
      generation: generation ?? null,
      runtimeTarget: runtimeTarget ?? null,
      pid: positiveInteger(processIdentity.pid) ?? process.pid,
      processStartedAt: finiteNumber(processIdentity.processStartedAt) ??
        Math.max(0, Math.floor(Date.now() - process.uptime() * 1000)),
      ...(processIdentity.bootId ? { bootId: String(processIdentity.bootId) } : {}),
      ...(Number.isSafeInteger(Number(processIdentity.processStartTicks))
        ? { processStartTicks: Number(processIdentity.processStartTicks) }
        : {}),
      status: "idle",
      code: "awaiting-task",
      message: "任务工具按需加载，进入任务后自动核验",
      detail: null,
      serverStatus: "notStarted",
      threadId: null,
      requiredTools: this.requiredTools,
      missingTools: [],
      toolsVerified: false,
      startedAt,
      updatedAt: startedAt,
    };
  }

  context(threadId = null) {
    if (!this.contexts.has(threadId)) {
      this.contexts.set(threadId, {
        state: { status: "idle", code: "awaiting-task",
          message: "任务工具按需加载，进入任务后自动核验", detail: null,
          serverStatus: "notStarted", threadId, requiredTools: this.requiredTools,
          missingTools: [], toolsVerified: false, checks: {}, diagnostic: null, updatedAt: this.now() },
        startupStatus: null, timer: null, revision: this.revision,
      });
    }
    return this.contexts.get(threadId);
  }

  statusRevision(threadId = null) {
    return this.context(threadId).revision;
  }

  async start({ claim = true } = {}) {
    if (!this.path) return;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    if (claim) await this.persist({ claim: true });
  }

  claim() {
    return this.persist({ claim: true });
  }

  observeServerMessage(message) {
    if (message?.method === STARTUP_STATUS_METHOD) this.observeStartupStatus(message.params);
    const item = message?.params?.item;
    const threadId = message?.params?.threadId;
    if (!threadId || item?.type !== "mcpToolCall" || !isCodexAppServer(item.server)) return;
    const tool = item.tool ?? item.name;
    const key = `${threadId}:${item.id}`;
    if (message.method === "item/started") {
      let args = item.arguments;
      if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = null; } }
      const proof = this.beginToolCheck(threadId, tool, item.id, { targetThreadId: args?.threadId ?? threadId });
      if (proof) this.toolCalls.set(key, proof);
    } else if (message.method === "item/completed") {
      const proof = this.toolCalls.get(key);
      this.toolCalls.delete(key);
      if (proof) this.observeToolResult(item.result, item.error ??
        (item.status === "failed" ? { message: "工具调用失败" } : null), proof);
    }
  }

  observeStartupStatus(params) {
    if (!isCodexAppServer(params?.name)) return;
    const serverStatus = String(params?.status ?? "").trim();
    const threadId = typeof params?.threadId === "string" ? params.threadId : null;
    const context = this.context(threadId);
    if (serverStatus === "ready" && context.startupStatus === "ready") return;
    context.startupStatus = serverStatus;
    if (serverStatus === "ready") {
      if (context.state.status === "ready" && context.state.toolsVerified) {
        this.clearGraceTimer(context);
        void this.update({ status: "ready", code: null,
          message: "Codex 任务工具已就绪", detail: null, serverStatus }, context);
      } else {
        void this.update({ status: "starting", code: "awaiting-tool-checks",
          message: "正在检查任务工具", detail: null,
          serverStatus, toolsVerified: false, missingTools: [] }, context);
        this.armGraceTimer(context);
      }
      return;
    }
    if (["starting", "failed", "cancelled"].includes(serverStatus)) {
      context.revision = ++this.revision;
      this.clearGraceTimer(context);
      context.state.checks = {};
      context.state.diagnostic = null;
      if (serverStatus !== "starting") {
        void this.update({ status: "degraded", ...classifyStartupFailure(params, serverStatus),
          serverStatus, toolsVerified: false }, context);
      } else {
        void this.update({ status: "starting", code: "codex-app-starting",
          message: "Codex 任务工具正在启动", detail: null,
          serverStatus, toolsVerified: false, missingTools: [] }, context);
        this.armGraceTimer(context);
      }
    }
  }

  beginToolCheck(threadId, tool, requestId, { targetThreadId = threadId } = {}) {
    const context = this.context(threadId);
    if (!this.requiredTools.includes(tool) || ["failed", "cancelled", "starting"].includes(context.startupStatus)) return null;
    const proof = { threadId, tool, requestId, healthRevision: context.revision, targetThreadId,
      startedAt: this.now() };
    context.state.checks = { ...context.state.checks,
      [tool]: { status: "checking", requestId, startedAt: proof.startedAt, checkedAt: null, detail: null } };
    this.clearGraceTimer(context);
    this.updateCheckSummary(context);
    return proof;
  }

  observeToolResult(result, error, proof, { timeout = false } = {}) {
    const context = this.context(proof.threadId);
    if (proof.healthRevision !== context.revision ||
        context.state.checks?.[proof.tool]?.requestId !== proof.requestId ||
        ["failed", "cancelled", "starting"].includes(context.startupStatus)) return;
    const outcome = timeout ? { status: "unconfirmed", detail: "检查超时，暂未确认；超时不代表工具不可用" }
      : classifyHostToolResult(proof.tool, result, error, proof);
    context.state.checks = { ...context.state.checks, [proof.tool]: {
      ...context.state.checks[proof.tool], ...outcome,
      detail: sanitizeHealthDetail(outcome.detail), checkedAt: this.now(),
      durationMs: Math.max(0, this.now() - proof.startedAt),
    } };
    this.updateCheckSummary(context);
  }

  updateCheckSummary(context) {
    const checks = this.requiredTools.map(tool => context.state.checks?.[tool]);
    const passed = checks.filter(check => check?.status === "passed").length;
    const failed = checks.filter(check => check?.status === "failed").length;
    const checking = checks.some(check => !check || check.status === "checking");
    const ready = passed === checks.length;
    void this.update({ status: ready ? "ready" : failed ? "degraded" : checking ? "starting" : "unconfirmed",
      code: ready ? null : failed ? "tool-call-failed" : checking ? "tool-checking" : "tool-check-unconfirmed",
      message: ready ? `${passed} 项任务工具检查通过` : failed ? `${passed} 项通过，${failed} 项异常`
        : checking ? `检查中：已通过 ${passed}/${checks.length} 项` : `${passed} 项通过，${checks.length - passed} 项未确认`,
      toolsVerified: ready, verification: "calls", missingTools: [], detail: null,
    }, context);
  }

  observeStatusList(result, error = null, { threadId = null, healthRevision } = {}) {
    // Unscoped inventories do not describe any task's live connection.
    if (threadId == null) return;
    const context = this.context(threadId);
    // Responses from before a task restart or global reload cannot restore old proof.
    if (healthRevision != null && healthRevision !== context.revision) return;
    const entry = (Array.isArray(result?.data) ? result.data : [])
      .find(candidate => isCodexAppServer(candidate?.name));
    // Catalog results are independent even before the first probe is dispatched.
    void this.update({ diagnostic: { status: error ? "unconfirmed" : "complete",
      detail: error ? sanitizeHealthDetail(errorMessage(error)) : null, checkedAt: this.now(),
      ...(!error ? { catalog: classifyCodexAppStatus(entry, this.requiredTools) } : {}),
    } }, context);
  }

  resetContexts() {
    for (const context of this.contexts.values()) this.clearGraceTimer(context);
    this.contexts.clear();
    this.toolCalls.clear();
    this.revision++;
  }

  observeReloadStarted() {
    this.resetContexts();
    void this.update({ status: "starting", code: "reloading-codex-app",
      message: "正在重新加载 Codex 任务工具", toolsVerified: false,
      missingTools: [], detail: null, serverStatus: "starting" });
  }

  observeReloadFailed(error) {
    // Reload start invalidates old proof once. Its response cannot invalidate
    // startup notifications or probe results received during the new connection.
    void this.update({ status: "unconfirmed", code: "codex-app-reload-failed",
      message: "刷新工具配置未完成，暂未确认工具状态", toolsVerified: false,
      detail: sanitizeHealthDetail(errorMessage(error)), serverStatus: "notStarted" });
  }

  async disconnect(detail = null) {
    const failure = this.state.status === "degraded" ? this.state : {
      status: "degraded", code: "relay-disconnected",
      message: "Codex 任务工具连接已中断", detail: sanitizeHealthDetail(detail),
      serverStatus: "failed",
    };
    this.resetContexts();
    await this.update({ ...failure, threadId: null, toolsVerified: false });
  }

  async close({ disconnected = true, detail = null } = {}) {
    if (this.closed) return this.tail;
    if (disconnected) await this.disconnect(detail);
    this.closed = true;
    for (const context of this.contexts.values()) this.clearGraceTimer(context);
    await this.tail;
  }

  snapshot(threadId) {
    if (threadId !== undefined) return structuredClone(this.context(threadId).state);
    return structuredClone({ ...this.state, tasks: Object.fromEntries(
      [...this.contexts].filter(([id]) => id != null).map(([id, context]) => [id, context.state]),
    ) });
  }

  armGraceTimer(context) {
    if (this.closed || !this.path || context.state.status !== "starting") return;
    this.clearGraceTimer(context);
    context.timer = this.setTimer(() => {
      context.timer = null;
      if (this.closed || context.state.status !== "starting") return;
      void this.update({ status: "unconfirmed", code: "startup-status-timeout",
        message: "等待工具服务就绪超时，尚未确认当前状态", detail: null,
        toolsVerified: false }, context);
    }, this.graceMs);
    context.timer?.unref?.();
  }

  clearGraceTimer(context) {
    if (context.timer != null) this.clearTimer(context.timer);
    context.timer = null;
  }

  update(patch, context = this.context()) {
    if (this.closed) return this.tail;
    context.state = { ...context.state, ...patch, updatedAt: this.now() };
    this.state = { ...this.state, ...context.state };
    return this.persist();
  }

  persist({ claim = false } = {}) {
    if (!this.path) return this.tail;
    const state = this.snapshot();
    this.tail = this.tail.then(async () => {
      if (!claim && !await healthFileOwnedBy(this.path, this.sessionId)) return;
      const temporaryPath = `${this.path}.${process.pid}.${this.sessionId}.tmp`;
      try {
        await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        await rename(temporaryPath, this.path);
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
    }).catch((error) => {
      console.error(`[host-health] 状态写入失败：${error.message}`);
    });
    return this.tail;
  }
}

export function classifyCodexAppStatus(entry, requiredTools = REQUIRED_CODEX_APP_TOOLS) {
  const expected = normalizeToolNames(requiredTools);
  if (!entry) {
    return {
      status: "degraded",
      code: "codex-app-not-listed",
      message: "Codex 任务工具服务未注册",
      detail: null,
      serverStatus: "failed",
      missingTools: expected,
      toolsVerified: true,
    };
  }
  const runtimeStatus = String(entry.runtimeStatus ?? "").trim();
  const toolNames = readToolNames(entry.tools);
  const toolsReported = entry.tools != null;
  const missingTools = expected.filter((name) => !toolNames.includes(name));
  if (runtimeStatus === "connected" && toolsReported && missingTools.length === 0) {
    return {
      status: "ready",
      code: null,
      message: "Codex 任务工具已就绪",
      detail: null,
      serverStatus: "ready",
      missingTools,
      toolsVerified: toolsReported,
    };
  }
  if (["notStarted", "starting", ""].includes(runtimeStatus)) {
    return {
      status: "starting",
      code: "codex-app-starting",
      message: "Codex 任务工具正在启动",
      detail: sanitizeHealthDetail(entry.toolsError),
      serverStatus: "starting",
      missingTools,
      toolsVerified: toolsReported,
    };
  }
  if (runtimeStatus === "connected") {
    return {
      status: "degraded",
      code: "required-tool-missing",
      message: `Codex 任务工具不完整：缺少 ${missingTools.join("、")}`,
      detail: sanitizeHealthDetail(entry.toolsError),
      serverStatus: "failed",
      missingTools,
      toolsVerified: toolsReported,
    };
  }
  const failure = classifyStartupFailure({
    failureReason: entry.toolsError,
    error: entry.toolsError,
  }, runtimeStatus);
  return {
    status: "degraded",
    ...failure,
    serverStatus: runtimeStatus || "failed",
    missingTools: expected,
    toolsVerified: toolsReported,
  };
}

export async function readHostHealthViewModel(binding, {
  now = Date.now(),
  relayStateChecker = isRelayStateCurrent,
  threadId = null,
} = {}) {
  if (!binding?.hostToolsRequired) return directHostHealth();
  const [relayState, healthState] = await Promise.all([
    readJson(binding.statePath),
    readJson(binding.healthPath),
  ]);
  const relayCurrent = await Promise.resolve(relayStateChecker(
    binding.statePath,
    binding.generation,
    { wslNative: binding.wslNative === true },
  )).catch(() => false);
  return evaluateHostHealth({ binding, relayState, healthState, relayCurrent, now, threadId });
}

export function evaluateHostHealth({
  binding,
  relayState,
  healthState,
  threadId = null,
  relayCurrent,
  now = Date.now(),
} = {}) {
  if (!binding?.hostToolsRequired) return directHostHealth();
  const base = {
    required: true,
    canRestart: true,
    canOpenLogs: true,
    requiredTools: [...REQUIRED_CODEX_APP_TOOLS],
    missingTools: [],
  };
  if (!relayCurrent) {
    return {
      ...base,
      status: "degraded",
      code: "relay-not-current",
      message: "Codex 任务工具中继未连接",
      detail: null,
      updatedAt: finiteNumber(healthState?.updatedAt),
    };
  }
  const relayStartedAt = finiteNumber(relayState?.startedAt) ??
    finiteNumber(relayState?.processStartedAt) ?? now;
  const insideGrace = now - relayStartedAt < HOST_HEALTH_STARTUP_GRACE_MS;
  const stateMatches = healthState?.version === HOST_HEALTH_STATE_VERSION &&
    healthState?.generation === binding.generation &&
    positiveInteger(healthState?.pid) === positiveInteger(relayState?.pid);
  if (!stateMatches) {
    if (healthState?.version != null && healthState.version !== HOST_HEALTH_STATE_VERSION) return {
      ...base, status: "unconfirmed", code: "health-runtime-outdated", canCheck: false,
      message: "检查服务待更新，重启 Codex 应用后启用新检查", threadId,
    };
    return insideGrace
      ? {
          ...base,
          status: "starting",
          code: "health-state-pending",
          message: "正在确认 Codex 任务工具状态",
          detail: null,
          updatedAt: null,
        }
      : {
          ...base,
          status: "unconfirmed",
          code: "health-state-missing",
          message: "未收到 Codex 任务工具启动状态",
          detail: null,
          updatedAt: finiteNumber(healthState?.updatedAt),
        };
  }
  const sessionId = healthState.sessionId;
  if (threadId != null) {
    healthState = healthState.tasks?.[threadId] ?? {
      status: "starting", code: "initiating-task-tools-not-verified",
      message: "正在等待当前任务工具检查", toolsVerified: false, threadId,
    };
  }
  let status = ["idle", "starting", "ready", "degraded", "unconfirmed"].includes(healthState.status)
    ? healthState.status
    : "degraded";
  const requiredTools = normalizeToolNames(healthState.requiredTools).length
    ? normalizeToolNames(healthState.requiredTools)
    : base.requiredTools;
  const missingTools = normalizeToolNames(healthState.missingTools);
  const toolsVerified = healthState.verification === "calls" && healthState.toolsVerified === true &&
    requiredTools.every(tool => healthState.checks?.[tool]?.status === "passed");
  let code = typeof healthState.code === "string" ? healthState.code : null;
  let message = sanitizeHealthDetail(healthState.message) ||
    (status === "ready" ? "Codex 任务工具已就绪" : "Codex 任务工具状态异常");
  if (status === "ready" && (!toolsVerified || missingTools.length > 0)) {
    status = insideGrace ? "starting" : "unconfirmed";
    code = insideGrace ? "awaiting-tool-checks" : "required-tool-unverified";
    message = insideGrace
      ? "正在检查任务工具"
      : "尚未完成任务工具实际调用检查";
  }
  return {
    ...base,
    status,
    code,
    message,
    detail: sanitizeHealthDetail(healthState.detail),
    serverStatus: typeof healthState.serverStatus === "string"
      ? healthState.serverStatus
      : null,
    requiredTools,
    missingTools,
    toolsVerified,
    checks: healthState.checks ?? {},
    verification: healthState.verification ?? null,
    diagnostic: healthState.diagnostic ?? null,
    canCheck: true,
    sessionId,
    threadId: typeof healthState.threadId === "string" ? healthState.threadId : null,
    updatedAt: finiteNumber(healthState.updatedAt),
  };
}

export function directHostHealth() {
  return {
    required: false,
    status: "direct",
    code: null,
    message: "Codex 使用官方直连任务工具链",
    detail: null,
    requiredTools: [...REQUIRED_CODEX_APP_TOOLS],
    missingTools: [],
    toolsVerified: false,
    canRestart: false,
    canOpenLogs: true,
    updatedAt: null,
  };
}

export function isCodexAppServer(value) {
  return String(value ?? "").trim().toLowerCase().replaceAll(/[\s-]+/g, "_") ===
    CODEX_APP_SERVER;
}

export function isMcpStatusListMethod(method) {
  return method === STATUS_LIST_METHOD;
}

function classifyStartupFailure(params, serverStatus) {
  const detail = sanitizeHealthDetail([
    errorMessage(params?.failureReason),
    errorMessage(params?.error),
  ].filter(Boolean).join("；"));
  if (/code[\s_-]*sign|codesign|signing identity|签名身份/i.test(detail ?? "")) {
    return {
      code: "missing-code-signing-identity",
      message: "Codex 任务工具启动失败：代码签名身份不可用",
      detail,
    };
  }
  if (serverStatus === "authenticationRequired") {
    return {
      code: "codex-app-authentication-required",
      message: "Codex 任务工具需要重新认证",
      detail,
    };
  }
  if (serverStatus === "disabled") {
    return {
      code: "codex-app-disabled",
      message: "Codex 任务工具服务已被禁用",
      detail,
    };
  }
  if (serverStatus === "cancelled") {
    return {
      code: "codex-app-startup-cancelled",
      message: "Codex 任务工具启动已取消",
      detail,
    };
  }
  return {
    code: "codex-app-startup-failed",
    message: "Codex 任务工具启动失败",
    detail,
  };
}

function readToolNames(value) {
  const entries = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.entries(value).map(([name, tool]) => ({ name, ...tool }))
      : [];
  return normalizeToolNames(entries.flatMap((entry) => [entry?.name, entry?.tool?.name]));
}

function normalizeToolNames(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .map((value) => value.replace(/^mcp__codex_app__/, "")))];
}

function sanitizeHealthDetail(value) {
  const text = String(value ?? "").replaceAll(/[\r\n\t]+/g, " ").trim();
  if (!text) return null;
  return text
    .replaceAll(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]")
    .replaceAll(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[redacted]")
    .replaceAll(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token)["']?\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .slice(0, HEALTH_DETAIL_LIMIT);
}

function errorMessage(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  if (value && typeof value === "object") {
    if (value.message != null) return String(value.message);
    if (value.reason != null) return String(value.reason);
    if (value.code != null) return String(value.code);
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return value == null ? "" : String(value);
}

async function healthFileOwnedBy(path, sessionId) {
  const current = await readJson(path);
  return current?.version === HOST_HEALTH_STATE_VERSION && current.sessionId === sessionId;
}

async function readJson(path) {
  if (!path) return null;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
