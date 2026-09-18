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
import { proveHostTools } from "./host-tool-fixtures.mjs";

function identity() {
  return {
    pid: process.pid,
    processStartedAt: Math.max(0, Math.floor(Date.now() - process.uptime() * 1000)),
  };
}

test("[LCH-04] codex_app 启动失败会持久化为可见降级状态并脱敏诊断", async (t) => {
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

test("[LCH-04 TOOL-04] 状态列表必须包含常用只读入口才能确认完整", () => {
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

test("[LCH-04 TOOL-04] ready 通知和完整目录均不能替代四项调用证据", async (t) => {
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
    return value.code === "awaiting-tool-checks" ? value : null;
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
  assert.equal(tracker.snapshot().toolsVerified, false);
  proveHostTools(tracker);
  const ready = await waitFor(async () => {
    const value = JSON.parse(await readFile(path, "utf8"));
    return value.status === "ready" ? value : null;
  });
  assert.equal(ready.toolsVerified, true);
  assert.deepEqual(ready.missingTools, []);
  await tracker.close({ disconnected: false });
});

test("[LCH-04] 未收到 codex_app 启动终态只标记未确认，不伪造启动失败", async (t) => {
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
  tracker.observeStartupStatus({ name: "codex_app", status: "starting", threadId: "task" });
  assert.equal(typeof timeoutHandler, "function");
  timeoutHandler();
  const state = await waitFor(async () => {
    const value = JSON.parse(await readFile(path, "utf8"));
    return value.code === "startup-status-timeout" ? value : null;
  });
  assert.equal(state.status, "unconfirmed");
  assert.equal(state.serverStatus, "starting");
  await tracker.close({ disconnected: false });
});

test("[LCH-04 RPC-03] 旧 sidecar 不能覆盖新会话的健康状态", async (t) => {
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
  proveHostTools(second);
  const state = await waitFor(async () => {
    const value = JSON.parse(await readFile(path, "utf8"));
    return value.status === "ready" ? value : null;
  });
  assert.equal(state.sessionId, second.snapshot().sessionId);
  await first.close({ disconnected: false });
  await second.close({ disconnected: false });
});

test("[LCH-03 LCH-04] 生命周期视图拒绝错误 PID、旧 generation 和降级状态", () => {
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
    verification: "calls",
    checks: Object.fromEntries(["list_threads", "read_thread", "list_projects", "get_usage_limits"].map(tool => [tool, { status: "passed" }])),
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
  }).status, "unconfirmed");
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

test("[LCH-04 UI-02] 健康轮询时间变化不制造页面状态更新", () => {
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

test("[LCH-04] 健康检查按状态使用低频兜底并在异常时快速自愈", () => {
  assert.equal(hostHealthPollInterval("idle"), HOST_HEALTH_READY_POLL_MS);
  assert.equal(hostHealthPollInterval("ready"), HOST_HEALTH_READY_POLL_MS);
  assert.equal(hostHealthPollInterval("direct"), HOST_HEALTH_READY_POLL_MS);
  assert.equal(hostHealthPollInterval("starting"), HOST_HEALTH_ACTIVE_POLL_MS);
  assert.equal(hostHealthPollInterval("degraded"), HOST_HEALTH_ACTIVE_POLL_MS);
  assert.equal(hostHealthPollInterval("unknown"), HOST_HEALTH_ACTIVE_POLL_MS);
  assert.ok(HOST_HEALTH_READY_POLL_MS > HOST_HEALTH_ACTIVE_POLL_MS);
});

test("[LCH-04] 健康文件监听兼容原子替换、防抖并在错误时关闭回退", async (t) => {
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

test("[platform:windows-native] [LCH-01 UI-02] Windows 原生提示脚本只包含通用错误和明确日志路径", () => {
  const path = "C:\\Users\\Fixture O'Brien\\injector.log";
  const openScript = windowsOpenLogScript(path);
  const alertScript = windowsStartupFailureScript(path);
  assert.match(openScript, /notepad\.exe/);
  assert.match(openScript, /O''Brien/);
  assert.match(alertScript, /MessageBox/);
  assert.match(alertScript, /启动失败/);
  assert.doesNotMatch(alertScript, /Bearer|api[_-]?key/i);
});

test("[LCH-04] 目录只更新诊断，不能代替或改变独立的任务启动状态", async t => {
  let tracker;
  t.after(() => tracker?.close({ disconnected: false }));
  const directory = await useTempDir(t, "host-health-unscoped-");
  tracker = await createHostHealthTracker({ path: join(directory, "health.json") });
  const catalog = { data: [{ name: "codex_app", runtimeStatus: null,
    tools: Object.fromEntries(["list_threads", "read_thread", "list_projects", "get_usage_limits"].map(name => [name, { name }])) }] };
  tracker.observeStatusList(catalog);
  assert.equal(tracker.snapshot().status, "idle", "缓存目录不能伪造启动或就绪");
  tracker.observeStartupStatus({ name: "codex_app", status: "ready", threadId: "current" });
  tracker.observeStatusList(catalog);
  assert.equal(tracker.snapshot("current").toolsVerified, false, "全局目录不能核验指定任务");
  tracker.observeStatusList(catalog, null, { threadId: "other" });
  assert.equal(tracker.snapshot("other").status, "idle", "另一任务不能借用启动通知");
  tracker.observeStatusList(catalog, null, { threadId: "current" });
  assert.equal(tracker.snapshot("current").status, "starting", "目录不能结束实际调用检查的等待");
  tracker.observeStatusList({ data: [{ ...catalog.data[0], runtimeStatus: "starting" }] }, null, { threadId: "current" });
  assert.equal(tracker.snapshot("current").status, "starting");
  tracker.observeStartupStatus({ name: "codex_app", status: "failed", threadId: "current" });
  tracker.observeStatusList(catalog, null, { threadId: "current" });
  assert.equal(tracker.snapshot("current").status, "degraded");
  tracker.observeStartupStatus({ name: "codex_app", status: "ready", threadId: "current" });
  const missing = structuredClone(catalog);
  missing.data[0].runtimeStatus = "connected";
  delete missing.data[0].tools.read_thread;
  tracker.observeStatusList(missing, null, { threadId: "current" });
  assert.equal(tracker.snapshot("current").diagnostic.catalog.code, "required-tool-missing");
  assert.equal(tracker.snapshot("current").serverStatus, "ready");
  tracker.observeReloadStarted();
  tracker.observeStatusList(catalog, null, { threadId: "current" });
  assert.equal(tracker.snapshot("current").status, "idle", "重载后目录不得借用旧启动通知");
});

test("[LCH-04] 空全局目录不能推翻同一已就绪任务的完整工具证据", async t => {
  const directory = await useTempDir(t, "host-health-task-catalog-");
  const tracker = await createHostHealthTracker({path: join(directory, "health.json")});
  try {
    tracker.observeStatusList({data: []});
    tracker.observeStartupStatus({name: "codex_app", status: "ready", threadId: "current"});
    assert.notEqual(tracker.snapshot().status, "ready");
    const catalog = {data: [{name: "codex_app", runtimeStatus: "connected",
      tools: Object.fromEntries(["list_threads", "read_thread", "list_projects", "get_usage_limits"].map(name => [name, {name}]))}]};
    tracker.observeStatusList(catalog, null, {threadId: "current"});
    proveHostTools(tracker, "current");
    tracker.observeStatusList({data: []});
    assert.equal(tracker.snapshot().status, "ready");
    tracker.observeStatusList({data: []}, null, {threadId: "current"});
    assert.equal(tracker.snapshot("current").diagnostic.catalog.code, "codex-app-not-listed");
    assert.equal(tracker.snapshot("current").status, "ready");
    tracker.observeStatusList(catalog, null, {threadId: "other"});
    tracker.observeStatusList({data: []});
    assert.equal(tracker.snapshot("current").diagnostic.catalog.code, "codex-app-not-listed", "其他任务不能覆盖当前任务的目录诊断");
    tracker.observeStatusList(catalog, null, {threadId: "current"});
    tracker.observeStartupStatus({name: "codex_app", status: "failed", threadId: "current"});
    tracker.observeStatusList({data: []});
    assert.notEqual(tracker.snapshot().status, "ready", "明确失败不能被旧目录掩盖");
  } finally { await tracker.close({disconnected: false}); }
});

test("[LCH-04] 主页初始化与空全局目录保持按需加载，实际任务启动后仍执行超时检查", async t => {
  const directory = await useTempDir(t, "host-health-lazy-task-");
  let timer = null;
  const tracker = await createHostHealthTracker({ path: join(directory, "health.json"),
    setTimer(handler) { timer = handler; return { unref() {} }; }, clearTimer() { timer = null; } });
  try {
    tracker.observeStatusList({ data: [] });
    assert.equal(tracker.snapshot().status, "idle");
    assert.equal(tracker.snapshot().toolsVerified, false);
    assert.equal(timer, null, "主页停留多久都不能伪造任务工具启动超时");
    const view = evaluateHostHealth({ binding: { hostToolsRequired: true, generation: null },
      relayState: { pid: tracker.snapshot().pid, startedAt: Date.now() - 600_000 },
      healthState: tracker.snapshot(), relayCurrent: true });
    assert.equal(view.status, "idle");
    tracker.observeStartupStatus({ name: "codex_app", status: "starting", threadId: "task" });
    tracker.observeStatusList({ data: [] });
    assert.equal(tracker.snapshot().status, "starting", "空全局目录不能重置真实启动检查");
    assert.equal(typeof timer, "function");
    timer();
    assert.equal(tracker.snapshot().code, "startup-status-timeout");
    tracker.observeStatusList({ data: [] });
    assert.equal(tracker.snapshot().status, "unconfirmed", "超时不得被转成按需加载或真实故障");
  } finally { await tracker.close({ disconnected: false }); }
});

test("[LCH-04] scoped 目录异常独立记录，空全局目录也不掩盖配置刷新结果", async t => {
  const directory = await useTempDir(t, "host-health-lazy-failure-");
  const tracker = await createHostHealthTracker({ path: join(directory, "health.json") });
  try {
    tracker.observeStatusList({ data: [] }, null, { threadId: "task" });
    assert.equal(tracker.snapshot("task").diagnostic.catalog.code, "codex-app-not-listed");
    assert.equal(tracker.snapshot("task").code, "awaiting-task");
    tracker.observeStatusList({ data: [] });
    assert.equal(tracker.snapshot("task").diagnostic.catalog.code, "codex-app-not-listed");
    tracker.observeStatusList({ data: [{ name: "codex_app", runtimeStatus: "disabled" }] }, null, { threadId: "task" });
    tracker.observeStatusList({ data: [] });
    assert.equal(tracker.snapshot("task").diagnostic.catalog.code, "codex-app-disabled");
    tracker.observeStatusList(null, { message: "query failed" }, { threadId: "task" });
    tracker.observeStatusList({ data: [] });
    assert.equal(tracker.snapshot("task").diagnostic.status, "unconfirmed");
    assert.equal(tracker.snapshot("task").diagnostic.detail, "query failed");
    assert.equal(tracker.snapshot("task").status, "idle");
    tracker.observeReloadStarted();
    tracker.observeStatusList({ data: [] });
    assert.equal(tracker.snapshot().status, "starting");
    tracker.observeReloadFailed(new Error("reload failed"));
    tracker.observeStatusList({ data: [] });
    assert.equal(tracker.snapshot().code, "codex-app-reload-failed");
  } finally { await tracker.close({ disconnected: false }); }
});

test("[LCH-04 UI-02] 按需加载显示中性说明，不提示重启或冒充工具通过", async () => {
  const { createHostHealth } = await import("../src/widget/host-health.mjs");
  const health = { required: true, status: "idle", canRestart: true, canOpenLogs: true };
  const widget = createHostHealth({ state: { data: { hostHealth: health } },
    escapeHtml: String, formatUpdatedAt: String });
  const banner = widget.renderHostHealthBanner(health);
  assert.equal(banner, "", "正常待命不占用提示卡片");
  assert.doesNotMatch(banner, /重新加载|重启|不可用|缺少/);
  const controls = widget.renderPanelControls(health);
  assert.match(controls, /status-idle/);
  assert.match(controls, /选择本机任务后自动检查/);
  assert.doesNotMatch(controls, /已加载|任务功能异常|建议：/);
});

const completeCatalog = { data: [{ name: "codex_app", runtimeStatus: "connected",
  tools: Object.fromEntries(["list_threads", "read_thread", "list_projects", "get_usage_limits"].map(name => [name, { name }])) }] };

test("[LCH-04] 多任务状态持久化互不覆盖，失败、重载与断开使对应证据失效", async t => {
  let tracker;
  t.after(() => tracker?.close({ disconnected: false }));
  const directory = await useTempDir(t, "host-health-task-isolation-");
  const path = join(directory, "health.json");
  tracker = await createHostHealthTracker({ path, generation: "isolated" });
  for (const threadId of ["initiating", "other"]) {
    tracker.observeStartupStatus({ name: "codex_app", status: "ready", threadId });
    tracker.observeStatusList(completeCatalog, null, { threadId });
    proveHostTools(tracker, threadId);
  }
  await tracker.claim();
  const persisted = JSON.parse(await readFile(path, "utf8"));
  const view = (healthState, threadId) => evaluateHostHealth({
    binding: { hostToolsRequired: true, generation: "isolated" },
    relayState: { pid: persisted.pid }, healthState, relayCurrent: true, threadId,
  });
  assert.equal(persisted.threadId, "other");
  assert.equal(view(persisted, "initiating").status, "ready");
  assert.equal(view(persisted, "other").status, "ready");
  assert.notEqual(view(persisted, "unseen").status, "ready");
  const revision = tracker.statusRevision("initiating");
  tracker.observeStartupStatus({ name: "codex_app", status: "failed", threadId: "initiating" });
  tracker.observeStatusList(completeCatalog, null, { threadId: "initiating", healthRevision: revision });
  assert.equal(view(tracker.snapshot(), "initiating").status, "degraded");
  assert.equal(view(tracker.snapshot(), "other").status, "ready");
  tracker.observeStartupStatus({ name: "codex_app", status: "starting", threadId: "other" });
  assert.equal(view(tracker.snapshot(), "other").toolsVerified, false);
  tracker.observeReloadStarted();
  tracker.observeStatusList(completeCatalog, null, { threadId: "initiating", healthRevision: revision });
  assert.notEqual(view(tracker.snapshot(), "initiating").status, "ready");
  tracker.observeStatusList(completeCatalog, null, { threadId: "other" });
  await tracker.disconnect();
  assert.notEqual(view(tracker.snapshot(), "other").status, "ready");
});

test("[LCH-04] 一个任务就绪不能取消另一任务的启动超时", async t => {
  let tracker;
  t.after(() => tracker?.close({ disconnected: false }));
  const directory = await useTempDir(t, "host-health-task-timeouts-");
  const timers = new Set();
  tracker = await createHostHealthTracker({ path: join(directory, "health.json"),
    setTimer(fn) { timers.add(fn); return fn; }, clearTimer(fn) { timers.delete(fn); } });
  tracker.observeStatusList({ data: [{ ...completeCatalog.data[0], runtimeStatus: null }] });
  assert.equal(timers.size, 0, "无作用域缓存目录不能留下会误报任务故障的全局超时");
  for (const threadId of ["waiting", "ready"]) {
    tracker.observeStartupStatus({ name: "codex_app", status: "starting", threadId });
  }
  tracker.observeStatusList(completeCatalog, null, { threadId: "ready" });
  proveHostTools(tracker, "ready");
  assert.equal(timers.size, 1);
  [...timers][0]();
  assert.equal(tracker.snapshot("waiting").code, "startup-status-timeout");
  assert.equal(tracker.snapshot("ready").status, "ready");
});
