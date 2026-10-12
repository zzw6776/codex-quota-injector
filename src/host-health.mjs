import { randomUUID } from "node:crypto";
import { watch as watchFs } from "node:fs";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { isRelayStateCurrent, signalWslRelayProcess } from "./platform.mjs";
import { classifyHostToolResult, isThreadNotMaterialized } from "./host-tool-probes.mjs";
import { listRelayInstances, relayInstancePath, relayInstanceId } from "./relay-instance-paths.mjs";

export const HOST_HEALTH_STATE_VERSION = 5;
export const HOST_HEALTH_STARTUP_GRACE_MS = 30_000;
export const HOST_HEALTH_ACTIVE_POLL_MS = 3_000;
export const HOST_HEALTH_READY_POLL_MS = 30_000;
export const HOST_HEALTH_WATCH_DEBOUNCE_MS = 100;
export const HOST_TOOL_RELOAD_REQUEST_VERSION = 3;
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
const HEALTH_RENAME_RETRY_DELAYS_MS = [25, 50, 100, 200];
const HEALTH_RENAME_TRANSIENT_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);

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
  sessionId = null,
} = {}, {
  signalWslRelay = signalWslRelayProcess,
  relayStateChecker = isRelayStateCurrent,
} = {}) {
  let healthPath = String(binding?.healthPath ?? "").trim();
  let statePath = String(binding?.statePath ?? "").trim();
  const generation = String(binding?.generation ?? "").trim();
  if (!binding?.hostToolsRequired || !healthPath || !generation) {
    throw new Error("当前启动入口没有可重载的 Codex 任务工具中继");
  }
  if (binding.wslNative === true && !statePath) {
    throw new Error("当前 WSL 任务工具中继缺少进程状态路径");
  }
  if (binding.instanceScoped || sessionId) {
    const selected = await resolveHostHealthInstance(binding, { threadId, relayStateChecker });
    if (!sessionId || selected.instance?.sessionId !== sessionId) {
      throw new Error("任务所属后台已变化或尚未确认，请重新打开详情");
    }
    healthPath = selected.instance.healthPath;
    statePath = selected.instance.statePath;
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
  let published = false;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporaryPath, `${JSON.stringify({
      version: HOST_TOOL_RELOAD_REQUEST_VERSION,
      requestId: normalizedRequestId,
      generation,
      requestedAt: Number(now) || Date.now(),
      action,
      threadId,
      sessionId,
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, path);
    published = true;
    if (binding.wslNative === true) {
      // Writes made by Windows do not reliably produce inotify events in WSL.
      // Wake the verified Relay once instead of polling the shared directory.
      await signalWslRelay(statePath, generation);
    }
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    if (published) await unlink(path).catch(() => undefined);
    throw error;
  }
  return { requestId: normalizedRequestId, path };
}

export function watchHostToolReloadRequests({ healthPath, generation, sessionId = null } = {}, {
  onRequest = () => {},
  onError = () => {},
  watchImpl = watchFs,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  debounceMs = HOST_HEALTH_WATCH_DEBOUNCE_MS,
  signalEmitter = null,
  wakeSignal = null,
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
  let wakeListener = null;
  let closed = false;
  let scanning = false;
  let scanAgain = false;

  const close = () => {
    if (closed) return;
    closed = true;
    if (timer != null) clearTimer(timer);
    timer = null;
    if (wakeListener && wakeSignal) signalEmitter?.off?.(wakeSignal, wakeListener);
    wakeListener = null;
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
          (sessionId != null && request?.sessionId !== sessionId) ||
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
    if (signalEmitter && wakeSignal) {
      wakeListener = schedule;
      signalEmitter.on(wakeSignal, wakeListener);
    }
    watcher = watchImpl(directory, { persistent: false }, (_eventType, fileName) => {
      if (fileName && !String(fileName).startsWith(prefix)) return;
      schedule();
    });
    watcher.on?.("error", (error) => {
      onError(error);
      watcher?.close?.();
      watcher = null;
      if (!wakeListener) close();
    });
  } catch (error) {
    onError(error);
    if (!wakeListener) close();
  }
  schedule();
  return {
    get active() { return !closed && (watcher != null || wakeListener != null); },
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
          if (fileName && !names.has(String(fileName)) &&
              ![...names].some(name => relayInstanceId(name, String(fileName)))) return;
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
  sessionId = randomUUID(),
  claim = true,
  requiredTools = REQUIRED_CODEX_APP_TOOLS,
  graceMs = HOST_HEALTH_STARTUP_GRACE_MS,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  renameFile = rename,
  platform = process.platform,
} = {}) {
  const tracker = new HostHealthTracker({
    path,
    generation,
    runtimeTarget,
    processIdentity,
    sessionId,
    requiredTools,
    graceMs,
    now,
    setTimer,
    clearTimer,
    renameFile,
    platform,
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
    sessionId,
    requiredTools,
    graceMs,
    now,
    setTimer,
    clearTimer,
    renameFile,
    platform,
  }) {
    this.path = String(path ?? "").trim();
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.renameFile = renameFile;
    this.platform = platform;
    this.graceMs = Math.max(0, Number(graceMs) || 0);
    this.requiredTools = normalizeToolNames(requiredTools);
    this.sessionId = sessionId;
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
        startupStatus: null, timer: null, revision: this.revision, userMessageObserved: false,
        readThreadRetryPending: false,
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
    const observedThread = message?.params?.threadId;
    if (observedThread && ["turn/started", "item/completed"].includes(message.method)) this.noteTask(observedThread);
    if (message?.method === "thread/closed" && observedThread) {
      const context = this.context(observedThread);
      context.observed = false;
      void this.persist();
    }
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
    if (threadId) context.observed = true;
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
      context.readThreadRetryPending = false;
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
    if (tool === "read_thread") context.readThreadRetryPending = false;
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

  noteUserMessage(threadId) {
    const context = this.context(threadId);
    context.userMessageObserved = true;
  }

  noteTask(threadId) {
    if (!threadId) return;
    const context = this.context(threadId);
    if (context.observed) return;
    context.observed = true;
    if (context.state.status === "idle") {
      context.state = { ...context.state, status: "starting", code: "awaiting-task-tools",
        message: "等待当前任务工具启动", updatedAt: this.now() };
      this.armGraceTimer(context);
    }
    void this.persist();
  }

  ownsTask(threadId) { return this.contexts.get(threadId)?.observed === true; }

  setReadThreadRetryPending(threadId, pending) {
    const context = this.context(threadId);
    context.readThreadRetryPending = pending;
    this.updateCheckSummary(context);
  }

  updateCheckSummary(context) {
    const checks = this.requiredTools.map(tool => context.state.checks?.[tool]);
    const passed = checks.filter(check => check?.status === "passed").length;
    const failed = checks.filter(check => check?.status === "failed").length;
    const checking = checks.some(check => !check || check.status === "checking");
    const ready = passed === checks.length;
    const awaitingReadThread = (!context.userMessageObserved || context.readThreadRetryPending) && !checking && !failed &&
      this.requiredTools.every(tool => {
        const check = context.state.checks?.[tool];
        return check?.status === "passed" ||
          (tool === "read_thread" && check?.status === "unconfirmed" &&
            isThreadNotMaterialized(check.detail));
      });
    void this.update({ status: ready ? "ready" : failed ? "degraded" : checking || awaitingReadThread ? "starting" : "unconfirmed",
      code: ready ? null : failed ? "tool-call-failed" : checking ? "tool-checking"
        : awaitingReadThread ? (context.userMessageObserved ? "awaiting-thread-readable" : "awaiting-first-user-message") : "tool-check-unconfirmed",
      message: ready ? `${passed} 项任务工具检查通过` : failed ? `${passed} 项通过，${failed} 项异常`
        : checking ? `检查中：已通过 ${passed}/${checks.length} 项`
          : awaitingReadThread ? (context.userMessageObserved ? "等待任务内容可读取，正在自动重试" : "等待任务首条消息后自动检查读取任务内容")
            : `${passed} 项通过，${checks.length - passed} 项未确认`,
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
    // Reloading MCP invalidates tool proof, not already observed user input.
    const observedThreads = [...this.contexts].filter(([, context]) => context.userMessageObserved)
      .map(([threadId]) => threadId);
    const ownedThreads = [...this.contexts].filter(([, context]) => context.observed).map(([id]) => id);
    this.resetContexts();
    for (const threadId of ownedThreads) this.noteTask(threadId);
    for (const threadId of observedThreads) this.noteUserMessage(threadId);
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
      [...this.contexts].filter(([id]) => id != null).map(([id, context]) => [id, { ...context.state, observed: context.observed === true }]),
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
      const owner = await readJson(this.path);
      if (!claim && (owner?.version !== HOST_HEALTH_STATE_VERSION
          || owner.sessionId !== this.sessionId)) return;
      const ownerSessionId = owner?.sessionId;
      const temporaryPath = `${this.path}.${process.pid}.${this.sessionId}.tmp`;
      try {
        await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        for (let attempt = 0; ; attempt += 1) {
          try {
            await this.renameFile(temporaryPath, this.path);
            break;
          } catch (error) {
            const retryDelay = HEALTH_RENAME_RETRY_DELAYS_MS[attempt];
            if (this.platform !== "win32" || retryDelay == null
                || !HEALTH_RENAME_TRANSIENT_ERRORS.has(error.code)) throw error;
            await delay(retryDelay);
            // 等待期间可能发生后台接管，旧会话不能重新覆盖新会话。
            if ((await readJson(this.path))?.sessionId !== ownerSessionId) return;
          }
        }
      } finally {
        await unlink(temporaryPath).catch(() => undefined);
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

export async function resolveHostHealthInstance(binding, {
  threadId = null, relayStateChecker = isRelayStateCurrent,
} = {}) {
  const files = await listRelayInstances(binding?.statePath);
  const entries = await Promise.all(files.map(async ({ sessionId, path: statePath }) => {
    const path = relayInstancePath(binding.healthPath, sessionId);
    const [relayState, healthState] = await Promise.all([readJson(statePath), readJson(path)]);
    if (!relayState || !healthState || healthState.sessionId !== sessionId ||
        healthState.generation !== binding.generation || relayState.generation !== binding.generation ||
        healthState.pid !== relayState.pid || healthState.processStartedAt !== relayState.processStartedAt) return null;
    const live = await Promise.resolve(relayStateChecker(statePath, binding.generation,
      { wslNative: binding.wslNative === true })).catch(() => false);
    return live ? { sessionId, statePath, healthPath: path, relayState, healthState } : null;
  }));
  const live = entries.filter(Boolean);
  const owners = threadId ? live.filter(entry => entry.healthState.tasks?.[threadId]?.observed === true) : live;
  return { scoped: binding?.instanceScoped === true || files.length > 0,
    instance: owners.length === 1 ? owners[0] : null, live, ambiguous: owners.length > 1 };
}

export async function readHostHealthViewModel(binding, {
  now = Date.now(),
  relayStateChecker = isRelayStateCurrent,
  threadId = null,
  waitingSince = 0,
} = {}) {
  if (!binding?.hostToolsRequired) return directHostHealth();
  const selected = await resolveHostHealthInstance(binding, { threadId, relayStateChecker });
  if (selected.scoped) {
    if (selected.instance) return evaluateHostHealth({ binding,
      ...selected.instance, relayCurrent: true, now, threadId });
    const waiting = !selected.ambiguous && now - waitingSince < HOST_HEALTH_STARTUP_GRACE_MS;
    return { required: true, status: threadId ? (waiting ? "starting" : "unconfirmed") : "idle",
      code: selected.ambiguous ? "task-owner-ambiguous" : "task-owner-missing",
      message: !threadId ? "选择本机任务后自动检查任务工具" : selected.ambiguous
        ? "多个后台报告同一任务，尚未确认任务所属服务"
        : waiting ? "正在确认任务所属服务" : "尚未确认任务所属服务，等待新的任务状态通知",
      canCheck: false, canRestart: true, canOpenLogs: true, threadId, sessionId: null,
      requiredTools: [...REQUIRED_CODEX_APP_TOOLS], checks: {}, toolsVerified: false, updatedAt: null };
  }
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
