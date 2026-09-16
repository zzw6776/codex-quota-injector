import { randomUUID } from "node:crypto";
import { watch as watchFs } from "node:fs";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { isRelayStateCurrent } from "./platform.mjs";

export const HOST_HEALTH_STATE_VERSION = 2;
export const HOST_HEALTH_STARTUP_GRACE_MS = 30_000;
export const HOST_HEALTH_ACTIVE_POLL_MS = 3_000;
export const HOST_HEALTH_READY_POLL_MS = 30_000;
export const HOST_HEALTH_WATCH_DEBOUNCE_MS = 100;
export const HOST_TOOL_RELOAD_REQUEST_VERSION = 1;
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
  return ["ready", "direct"].includes(String(status ?? ""))
    ? HOST_HEALTH_READY_POLL_MS
    : HOST_HEALTH_ACTIVE_POLL_MS;
}

export async function requestHostToolReload(binding, {
  requestId = randomUUID(),
  now = Date.now(),
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
    this.timer = null;
    this.tail = Promise.resolve();
    this.closed = false;
    this.startupStatus = null;
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
      status: "starting",
      code: "awaiting-codex-app",
      message: "正在确认 Codex 任务工具状态",
      detail: null,
      serverStatus: "starting",
      threadId: null,
      requiredTools: this.requiredTools,
      missingTools: [],
      toolsVerified: false,
      startedAt,
      updatedAt: startedAt,
    };
  }

  async start({ claim = true } = {}) {
    if (!this.path) return;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    if (claim) await this.persist({ claim: true });
    this.armGraceTimer();
  }

  claim() {
    return this.persist({ claim: true });
  }

  observeClientMessage(message) {
    if (!message || typeof message !== "object") return;
    if (message.method === "initialized") this.armGraceTimer();
  }

  observeServerMessage(message) {
    if (message?.method !== STARTUP_STATUS_METHOD) return;
    this.observeStartupStatus(message.params);
  }

  observeStartupStatus(params) {
    if (!isCodexAppServer(params?.name)) return;
    const serverStatus = String(params?.status ?? "").trim();
    const threadId = typeof params?.threadId === "string" ? params.threadId : null;
    this.startupStatus = { status: serverStatus, threadId };
    if (serverStatus === "ready") {
      if (this.state.toolsVerified && this.state.missingTools.length === 0) {
        this.clearGraceTimer();
        void this.update({
          status: "ready",
          code: null,
          message: "Codex 任务工具已就绪",
          detail: null,
          serverStatus,
          threadId,
        });
      } else {
        this.armGraceTimer();
        void this.update({
          status: "starting",
          code: "awaiting-tool-catalog",
          message: "Codex 任务工具服务已启动，正在核对工具目录",
          detail: null,
          serverStatus,
          threadId,
        });
      }
      return;
    }
    if (serverStatus === "failed" || serverStatus === "cancelled") {
      this.clearGraceTimer();
      const failure = classifyStartupFailure(params, serverStatus);
      void this.update({
        status: "degraded",
        ...failure,
        serverStatus,
        threadId,
      });
      return;
    }
    if (serverStatus === "starting") {
      this.armGraceTimer();
      void this.update({
        status: "starting",
        code: "codex-app-starting",
        message: "Codex 任务工具正在启动",
        detail: null,
        serverStatus,
        threadId,
      });
    }
  }

  observeStatusList(result, error = null, { threadId = null } = {}) {
    if (error) {
      this.clearGraceTimer();
      void this.update({
        status: "degraded",
        code: "status-query-failed",
        message: "无法确认 Codex 任务工具状态",
        detail: sanitizeHealthDetail(errorMessage(error)),
      });
      return;
    }
    const entries = Array.isArray(result?.data) ? result.data : [];
    const entry = entries.find((candidate) => isCodexAppServer(candidate?.name));
    // Unscoped inventory reports runtimeStatus:null even after startup is ready.
    // Use the observed startup evidence, never the cached catalog alone, and
    // never combine a different task's scoped response with that evidence.
    const startupReady = this.startupStatus?.status === "ready" &&
      (threadId == null || threadId === this.startupStatus.threadId);
    const classified = classifyCodexAppStatus(entry && entry.runtimeStatus == null && startupReady
      ? { ...entry, runtimeStatus: "connected" }
      : entry, this.requiredTools);
    void this.update(classified);
    if (classified.status === "ready" || classified.status === "degraded") {
      this.clearGraceTimer();
    } else {
      this.armGraceTimer();
    }
  }

  observeReloadStarted() {
    this.startupStatus = null;
    this.clearGraceTimer();
    void this.update({
      status: "starting",
      code: "reloading-codex-app",
      message: "正在重新加载 Codex 任务工具",
      detail: null,
      serverStatus: "starting",
    });
  }

  observeReloadFailed(error) {
    this.clearGraceTimer();
    void this.update({
      status: "degraded",
      code: "codex-app-reload-failed",
      message: "Codex 任务工具重新加载失败",
      detail: sanitizeHealthDetail(errorMessage(error)),
      serverStatus: "failed",
    });
  }

  async disconnect(detail = null) {
    this.clearGraceTimer();
    if (this.state.status !== "degraded") {
      await this.update({
        status: "degraded",
        code: "relay-disconnected",
        message: "Codex 任务工具连接已中断",
        detail: sanitizeHealthDetail(detail),
        serverStatus: "failed",
      });
    } else {
      await this.tail;
    }
  }

  async close({ disconnected = true, detail = null } = {}) {
    if (this.closed) return this.tail;
    if (disconnected) await this.disconnect(detail);
    this.closed = true;
    this.clearGraceTimer();
    await this.tail;
  }

  snapshot() {
    return structuredClone(this.state);
  }

  armGraceTimer() {
    if (this.closed || !this.path || this.state.status === "ready" ||
      this.state.status === "degraded") return;
    this.clearGraceTimer();
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (this.closed || this.state.status !== "starting") return;
      void this.update({
        status: "degraded",
        code: "startup-status-timeout",
        message: "Codex 任务工具未在启动时限内就绪",
        detail: null,
        serverStatus: "failed",
      });
    }, this.graceMs);
    this.timer?.unref?.();
  }

  clearGraceTimer() {
    if (this.timer != null) this.clearTimer(this.timer);
    this.timer = null;
  }

  update(patch) {
    if (this.closed) return this.tail;
    this.state = {
      ...this.state,
      ...patch,
      updatedAt: this.now(),
    };
    return this.persist();
  }

  persist({ claim = false } = {}) {
    if (!this.path) return this.tail;
    const state = structuredClone(this.state);
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
  return evaluateHostHealth({ binding, relayState, healthState, relayCurrent, now });
}

export function evaluateHostHealth({
  binding,
  relayState,
  healthState,
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
          status: "degraded",
          code: "health-state-missing",
          message: "未收到 Codex 任务工具启动状态",
          detail: null,
          updatedAt: finiteNumber(healthState?.updatedAt),
        };
  }
  let status = ["starting", "ready", "degraded"].includes(healthState.status)
    ? healthState.status
    : "degraded";
  const requiredTools = normalizeToolNames(healthState.requiredTools).length
    ? normalizeToolNames(healthState.requiredTools)
    : base.requiredTools;
  const missingTools = normalizeToolNames(healthState.missingTools);
  const toolsVerified = healthState.toolsVerified === true;
  let code = typeof healthState.code === "string" ? healthState.code : null;
  let message = sanitizeHealthDetail(healthState.message) ||
    (status === "ready" ? "Codex 任务工具已就绪" : "Codex 任务工具状态异常");
  if (status === "ready" && (!toolsVerified || missingTools.length > 0)) {
    status = insideGrace ? "starting" : "degraded";
    code = insideGrace ? "awaiting-tool-catalog" : "required-tool-unverified";
    message = insideGrace
      ? "Codex 任务工具服务已启动，正在核对工具目录"
      : "Codex 任务工具目录未通过完整性核对";
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
