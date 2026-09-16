import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  classifyCodexAppStatus,
  createHostHealthTracker,
  directHostHealth,
  evaluateHostHealth,
  HOST_HEALTH_ACTIVE_POLL_MS,
  HOST_HEALTH_READY_POLL_MS,
  HOST_HEALTH_STATE_VERSION,
  HOST_HEALTH_WATCH_DEBOUNCE_MS,
  hostHealthPollInterval,
  watchHostHealthFiles,
} from "../src/host-health.mjs";
import {
  windowsOpenLogScript,
  windowsStartupFailureScript,
} from "../src/desktop-feedback.mjs";
import { useTempDir, waitFor } from "./helpers.mjs";

function identity() {
  return {
    pid: process.pid,
    processStartedAt: Math.max(0, Math.floor(Date.now() - process.uptime() * 1000)),
  };
}

test("[A LCH-04] codex_app 启动失败会持久化为可见降级状态并脱敏诊断", async (t) => {
  const directory = await useTempDir(t, "host-health-");
  const path = join(directory, "health.json");
  const tracker = await createHostHealthTracker({
    path,
    generation: "generation-1",
    runtimeTarget: "macos-native",
    processIdentity: identity(),
  });
  tracker.observeServerMessage({
    method: "mcpServer/startupStatus/updated",
    params: {
      threadId: null,
      name: "codex_app",
      status: "failed",
      error: { message: "missing code signing identity; Bearer secret-value" },
    },
  });
  const state = await waitFor(async () => {
    const value = JSON.parse(await readFile(path, "utf8"));
    return value.status === "degraded" ? value : null;
  });
  assert.equal(state.version, HOST_HEALTH_STATE_VERSION);
  assert.equal(state.code, "missing-code-signing-identity");
  assert.match(state.message, /代码签名身份不可用/);
  assert.match(state.detail, /Bearer \[redacted\]/);
  assert.doesNotMatch(state.detail, /secret-value/);
  await tracker.close();
  assert.equal(JSON.parse(await readFile(path, "utf8")).code,
    "missing-code-signing-identity", "断开时必须保留更具体的启动根因");
});

test("[A LCH-04 TOOL-04] 状态列表必须包含常用只读入口才能确认完整", () => {
  const ready = classifyCodexAppStatus({
    name: "codex_app",
    runtimeStatus: "connected",
    tools: {
      list_threads: { name: "list_threads" },
      read_thread: { name: "read_thread" },
      list_projects: { name: "list_projects" },
      get_usage_limits: { name: "get_usage_limits" },
    },
  });
  assert.equal(ready.status, "ready");
  assert.equal(ready.toolsVerified, true);

  const missing = classifyCodexAppStatus({
    name: "codex_app",
    runtimeStatus: "connected",
    tools: {
      list_threads: { name: "list_threads" },
      list_projects: { name: "list_projects" },
      get_usage_limits: { name: "get_usage_limits" },
    },
  });
  assert.equal(missing.status, "degraded");
  assert.equal(missing.code, "required-tool-missing");
  assert.deepEqual(missing.missingTools, ["read_thread"]);

  const authentication = classifyCodexAppStatus({
    name: "codex_app",
    runtimeStatus: "authenticationRequired",
  });
  assert.equal(authentication.code, "codex-app-authentication-required");

  const unreported = classifyCodexAppStatus({
    name: "codex_app",
    runtimeStatus: "connected",
  });
  assert.equal(unreported.status, "degraded");
  assert.equal(unreported.toolsVerified, false);
  assert.deepEqual(unreported.missingTools,
    ["list_threads", "read_thread", "list_projects", "get_usage_limits"]);
});

test("[A LCH-04 TOOL-04] ready 通知不能替代必需工具目录证据", async (t) => {
  const directory = await useTempDir(t, "host-health-tool-proof-");
  const path = join(directory, "health.json");
  let timeoutHandler = null;
  const tracker = await createHostHealthTracker({
    path,
    generation: "generation-tools",
    runtimeTarget: "macos-native",
    processIdentity: identity(),
    setTimer(handler) {
      timeoutHandler = handler;
      return { unref() {} };
    },
    clearTimer() {},
  });
  tracker.observeStartupStatus({ name: "codex_app", status: "ready" });
  const awaiting = await waitFor(async () => {
    const value = JSON.parse(await readFile(path, "utf8"));
    return value.code === "awaiting-tool-catalog" ? value : null;
  });
  assert.equal(awaiting.status, "starting");
  assert.equal(awaiting.toolsVerified, false);
  assert.equal(typeof timeoutHandler, "function");

  tracker.observeStatusList({
    data: [{
      name: "codex_app",
      runtimeStatus: "connected",
      tools: {
        list_threads: { name: "list_threads" },
        read_thread: { name: "read_thread" },
        list_projects: { name: "list_projects" },
        get_usage_limits: { name: "get_usage_limits" },
      },
    }],
  });
  const ready = await waitFor(async () => {
    const value = JSON.parse(await readFile(path, "utf8"));
    return value.status === "ready" ? value : null;
  });
  assert.equal(ready.toolsVerified, true);
  assert.deepEqual(ready.missingTools, []);
  await tracker.close({ disconnected: false });
});

test("[A LCH-04] 未收到 codex_app 启动终态会在宽限期后失败", async (t) => {
  const directory = await useTempDir(t, "host-health-timeout-");
  const path = join(directory, "health.json");
  let timeoutHandler = null;
  const tracker = await createHostHealthTracker({
    path,
    generation: "generation-timeout",
    runtimeTarget: "windows-native",
    processIdentity: identity(),
    graceMs: 30_000,
    setTimer(handler) {
      timeoutHandler = handler;
      return { unref() {} };
    },
    clearTimer() {},
  });
  assert.equal(typeof timeoutHandler, "function");
  timeoutHandler();
  const state = await waitFor(async () => {
    const value = JSON.parse(await readFile(path, "utf8"));
    return value.code === "startup-status-timeout" ? value : null;
  });
  assert.equal(state.status, "degraded");
  await tracker.close({ disconnected: false });
});

test("[A LCH-04 RPC-03] 旧 sidecar 不能覆盖新会话的健康状态", async (t) => {
  const directory = await useTempDir(t, "host-health-owner-");
  const path = join(directory, "health.json");
  const first = await createHostHealthTracker({
    path,
    generation: "generation",
    runtimeTarget: "wsl-native",
    processIdentity: identity(),
  });
  const second = await createHostHealthTracker({
    path,
    generation: "generation",
    runtimeTarget: "wsl-native",
    processIdentity: identity(),
  });
  first.observeStartupStatus({ name: "codex_app", status: "failed", error: "old failure" });
  second.observeStatusList({
    data: [{
      name: "codex_app",
      runtimeStatus: "connected",
      tools: {
        list_threads: { name: "list_threads" },
        read_thread: { name: "read_thread" },
        list_projects: { name: "list_projects" },
        get_usage_limits: { name: "get_usage_limits" },
      },
    }],
  });
  const state = await waitFor(async () => {
    const value = JSON.parse(await readFile(path, "utf8"));
    return value.status === "ready" ? value : null;
  });
  assert.equal(state.sessionId, second.snapshot().sessionId);
  await first.close({ disconnected: false });
  await second.close({ disconnected: false });
});

test("[A LCH-03 LCH-04] 生命周期视图拒绝错误 PID、旧 generation 和降级状态", () => {
  const now = 1_800_000_000_000;
  const binding = {
    hostToolsRequired: true,
    generation: "generation-2",
  };
  const relayState = {
    pid: 42,
    generation: "generation-2",
    startedAt: now - 40_000,
  };
  const healthState = {
    version: HOST_HEALTH_STATE_VERSION,
    pid: 42,
    generation: "generation-2",
    status: "ready",
    message: "ready",
    requiredTools: ["list_threads", "read_thread", "list_projects", "get_usage_limits"],
    missingTools: [],
    toolsVerified: true,
  };
  assert.equal(evaluateHostHealth({
    binding, relayState, healthState, relayCurrent: true, now,
  }).status, "ready");
  assert.equal(evaluateHostHealth({
    binding,
    relayState,
    healthState: { ...healthState, pid: 43 },
    relayCurrent: true,
    now,
  }).code, "health-state-missing");
  assert.equal(evaluateHostHealth({
    binding,
    relayState,
    healthState: { ...healthState, generation: "old" },
    relayCurrent: true,
    now,
  }).status, "degraded");
  assert.equal(evaluateHostHealth({
    binding, relayState, healthState, relayCurrent: false, now,
  }).code, "relay-not-current");
  assert.equal(evaluateHostHealth({
    binding,
    relayState,
    healthState: { ...healthState, toolsVerified: false },
    relayCurrent: true,
    now,
  }).code, "required-tool-unverified");
  assert.equal(directHostHealth().status, "direct");
});

test("[A LCH-04 UI-02] 健康轮询时间变化不制造页面状态更新", () => {
  const now = 1_800_000_000_000;
  const binding = { hostToolsRequired: true, generation: "stable-generation" };
  const relayState = { pid: 42, generation: binding.generation, startedAt: now - 40_000 };
  const healthState = {
    version: HOST_HEALTH_STATE_VERSION,
    pid: 42,
    generation: binding.generation,
    status: "ready",
    message: "Codex 任务工具已就绪",
    requiredTools: ["list_threads", "read_thread", "list_projects", "get_usage_limits"],
    missingTools: [],
    toolsVerified: true,
    updatedAt: now - 10_000,
  };
  const first = evaluateHostHealth({
    binding, relayState, healthState, relayCurrent: true, now,
  });
  const next = evaluateHostHealth({
    binding, relayState, healthState, relayCurrent: true, now: now + 3_000,
  });
  assert.deepEqual(next, first,
    "仅轮询发生时间变化时 Widget 视图模型必须保持相同，避免周期性重绘");
});

test("[A LCH-04] 健康检查按状态使用低频兜底并在异常时快速自愈", () => {
  assert.equal(hostHealthPollInterval("ready"), HOST_HEALTH_READY_POLL_MS);
  assert.equal(hostHealthPollInterval("direct"), HOST_HEALTH_READY_POLL_MS);
  assert.equal(hostHealthPollInterval("starting"), HOST_HEALTH_ACTIVE_POLL_MS);
  assert.equal(hostHealthPollInterval("degraded"), HOST_HEALTH_ACTIVE_POLL_MS);
  assert.equal(hostHealthPollInterval("unknown"), HOST_HEALTH_ACTIVE_POLL_MS);
  assert.ok(HOST_HEALTH_READY_POLL_MS > HOST_HEALTH_ACTIVE_POLL_MS);
});

test("[A LCH-04] 健康文件监听兼容原子替换、防抖并在错误时关闭回退", async (t) => {
  const directory = await useTempDir(t, "host-health-watch-");
  const listeners = [];
  const watchers = [];
  const timers = [];
  const clearedTimers = [];
  let changes = 0;
  let observedError = null;
  const watcher = watchHostHealthFiles({
    hostToolsRequired: true,
    statePath: join(directory, "relay-state.json"),
    healthPath: join(directory, "app-server-health.json"),
  }, {
    watchImpl(path, options, listener) {
      assert.equal(path, directory);
      assert.deepEqual(options, { persistent: false });
      const handle = new EventEmitter();
      handle.closed = false;
      handle.close = () => { handle.closed = true; };
      listeners.push(listener);
      watchers.push(handle);
      return handle;
    },
    setTimer(handler, delay) {
      const timer = { handler, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      clearedTimers.push(timer);
    },
    onChange() {
      changes += 1;
    },
    onError(error) {
      observedError = error;
    },
  });

  assert.equal(watcher.active, true);
  assert.equal(watchers.length, 1, "同目录下两个状态文件只建立一个监听器");
  listeners[0]("rename", "app-server-health.json.42.session.tmp");
  assert.equal(timers.length, 0, "原子写入的临时文件事件不应触发读取");
  listeners[0]("rename", "app-server-health.json");
  listeners[0]("change", "relay-state.json");
  assert.equal(timers.length, 2);
  assert.equal(timers[1].delay, HOST_HEALTH_WATCH_DEBOUNCE_MS);
  assert.deepEqual(clearedTimers, [timers[0]], "连续事件必须合并为一次刷新");
  timers[1].handler();
  assert.equal(changes, 1);

  const failure = new Error("watch unavailable");
  watchers[0].emit("error", failure);
  assert.equal(observedError, failure);
  assert.equal(watcher.active, false);
  assert.equal(watchers[0].closed, true);
});

test("[platform:windows-native] [A LCH-01 UI-02] Windows 原生提示脚本只包含通用错误和明确日志路径", () => {
  const path = "C:\\Users\\Fixture O'Brien\\injector.log";
  const openScript = windowsOpenLogScript(path);
  const alertScript = windowsStartupFailureScript(path);
  assert.match(openScript, /notepad\.exe/);
  assert.match(openScript, /O''Brien/);
  assert.match(alertScript, /MessageBox/);
  assert.match(alertScript, /启动失败/);
  assert.doesNotMatch(alertScript, /Bearer|api[_-]?key/i);
});

test("[A LCH-04] 无任务目录的空运行状态不得覆盖启动证据，也不能单凭缓存目录判就绪", async t => {
  const directory = await useTempDir(t, "host-health-unscoped-");
  const tracker = await createHostHealthTracker({path: join(directory, "health.json")});
  try {
  const catalog = { data: [{ name: "codex_app", runtimeStatus: null,
    tools: Object.fromEntries(["list_threads", "read_thread", "list_projects", "get_usage_limits"].map(name => [name, {name}])) }] };
  tracker.observeStatusList(catalog);
  assert.equal(tracker.snapshot().status, "starting", "目录可能来自缓存，不能单独证明运行时就绪");
  tracker.observeStartupStatus({name: "codex_app", status: "ready", threadId: "current"});
  tracker.observeStatusList(catalog);
  assert.equal(tracker.snapshot().status, "ready", "全局目录不可覆盖已收到的 ready");
  tracker.observeStatusList(catalog, null, {threadId: "other"});
  assert.equal(tracker.snapshot().status, "starting", "另一任务的目录不可借用当前任务状态");
  tracker.observeStatusList(catalog, null, {threadId: "current"});
  assert.equal(tracker.snapshot().status, "ready");
  tracker.observeStatusList({data: [{...catalog.data[0], runtimeStatus: "starting"}]});
  assert.equal(tracker.snapshot().status, "starting", "明确的运行状态仍需采纳");
  tracker.observeStartupStatus({name: "codex_app", status: "failed", threadId: "current"});
  tracker.observeStatusList(catalog);
  assert.notEqual(tracker.snapshot().status, "ready");
  tracker.observeStartupStatus({name: "codex_app", status: "ready", threadId: "current"});
  const missing = structuredClone(catalog);
  delete missing.data[0].tools.read_thread;
  tracker.observeStatusList(missing);
  assert.equal(tracker.snapshot().code, "required-tool-missing");
  tracker.observeReloadStarted();
  tracker.observeStatusList(catalog);
  assert.equal(tracker.snapshot().status, "starting", "重载后不得借用旧启动通知");
  } finally { await tracker.close({disconnected: false}); }
});
