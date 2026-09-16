import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer as createTcpServer } from "node:net";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";

import { CdpClient, findCodexTarget, isCodexDebugPortReady } from "../src/cdp-client.mjs";
import { isCodexHostedDevLaunch } from "../src/dev-runtime.mjs";
import {
  codexLaunchEnvironment,
  isRelayConfigCurrent,
  isRelayStateCurrent,
  parseMacCodexLifecycleProcesses,
  parseWindowsSubsystemSetting,
  updateWindowsSubsystemSetting,
  parseProcessList,
  requestMacCodexQuit,
  requestWindowsCodexQuit,
  stopMacCodex,
} from "../src/platform.mjs";
import {
  acquireSingleInstance,
  closeSingleInstance,
  compareVersions,
} from "../src/single-instance.mjs";
import { prepareWindowsUpdate } from "../src/windows-update.mjs";
import { stopChild } from "../runtime-tests/support/offline-runtime.mjs";
import {
  WIDGET_RUNTIME_VERSION,
  averageGenerationNetworkLatency,
  calculatePopoverMaxHeight,
  calculateScrollbarEndPadding,
  createGenerationToolRow,
  formatConversationUsageSummary,
  formatGenerationDetailTitle,
  formatGenerationPhaseText,
  formatGenerationPrimaryText,
  generationExecutionRemainder,
  generationToolRows,
  formatNetworkLatencyText,
  paginateGenerationDetails,
  selectConversationNetworkLatency,
  widgetDrainActionsExpression,
  widgetInstallExpression,
  widgetRuntimeVersionExpression,
  widgetTokenUsageDeltaUpdateExpressionJson,
  widgetTokenUsageUpdateExpressionJson,
  widgetUpdateExpression,
  widgetUpdateExpressionJson,
} from "../src/widget.mjs";
import { json, startHttpServer, useTempDir } from "./helpers.mjs";

test("[HAR-04 LCH-04] 测试进程回收等待 sidecar 释放继承的 stdio", async () => {
  const child = spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 150)"], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    process.stdout.write("ready\\n");
    setInterval(() => {}, 1_000);
  `], { stdio: ["pipe", "pipe", "pipe"] });
  await once(child.stdout, "data");
  let closed = false;
  child.once("close", () => { closed = true; });
  await stopChild(child);
  assert.equal(closed, true, "父进程退出但 sidecar 仍持有 stdio 时不能提前回收目录");
});

test("[LCH-05] 开发版拒绝从 Codex 内部工具进程接管生命周期", () => {
  assert.equal(isCodexHostedDevLaunch({ CODEX_APP_TOOLS_PIPE_PATH: "/tmp/codex-app-tools" }), true);
  assert.equal(isCodexHostedDevLaunch({ CODEX_APP_TOOLS_PIPE_PATH: "  " }), false);
  assert.equal(isCodexHostedDevLaunch({}), false);
});

test("[platform:macos-native] [LCH-05] macOS 关闭 Codex 使用标准退出事件，不直接发送终止信号", async () => {
  let invocation = null;
  await requestMacCodexQuit({
    execFileImpl: async (command, args, options) => {
      invocation = { command, args, options };
    },
  });
  assert.deepEqual(invocation, {
    command: "/usr/bin/osascript",
    args: ["-e", "tell application id \"com.openai.codex\" to quit"],
    options: { timeout: 5_000 },
  });
});

test("[platform:macos-native] [LCH-05] macOS 生命周期只识别目标 Bundle 的已知辅助进程", () => {
  const executable = "/Applications/Codex.app/Contents/MacOS/Codex";
  const bareModifier = "/Applications/Codex.app/Contents/Resources/native/bare-modifier-monitor";
  const crashpad = "/Applications/Codex.app/Contents/Frameworks/Codex Framework.framework/Versions/1/Helpers/browser_crashpad_handler";
  assert.deepEqual(parseMacCodexLifecycleProcesses([
    `  101 ${executable}`,
    `  102 ${bareModifier}`,
    `  103 ${crashpad}`,
    "  104 /Applications/Codex.app/Contents/Resources/cua_node/bin/node",
    "  105 /Applications/Codex.app/Contents/Resources/native/bare-modifier-monitor-copy",
    "  106 /Applications/Other.app/Contents/Resources/native/bare-modifier-monitor",
    "invalid",
  ].join("\n"), executable), [
    { pid: 101, executablePath: executable, role: "desktop" },
    { pid: 102, executablePath: bareModifier, role: "bare-modifier-monitor" },
    { pid: 103, executablePath: crashpad, role: "browser-crashpad-handler" },
  ]);
});

test("[platform:macos-native] [LCH-05] macOS 主进程退出后定向回收旧辅助进程并避开已复用 PID", async () => {
  const executable = "/Applications/Codex.app/Contents/MacOS/Codex";
  const bareModifier = "/Applications/Codex.app/Contents/Resources/native/bare-modifier-monitor";
  const crashpad = "/Applications/Codex.app/Contents/Frameworks/Codex Framework.framework/Versions/1/Helpers/browser_crashpad_handler";
  let processes = [
    { pid: 101, executablePath: executable, role: "desktop" },
    { pid: 102, executablePath: bareModifier, role: "bare-modifier-monitor" },
    { pid: 103, executablePath: crashpad, role: "browser-crashpad-handler" },
    { pid: 104, executablePath: crashpad, role: "browser-crashpad-handler" },
  ];
  let now = 0;
  let quitRequests = 0;
  const signals = [];
  await stopMacCodex({
    executable,
    timeoutMs: 200,
    listProcessesImpl: async () => structuredClone(processes),
    requestQuitImpl: async () => {
      quitRequests += 1;
      processes = processes
        .filter((entry) => entry.pid !== 101)
        .map((entry) => entry.pid === 104
          ? { ...entry, executablePath: "/usr/bin/reused-process", role: "other" }
          : entry);
    },
    signalProcessImpl: (pid, signal) => {
      signals.push([pid, signal]);
      if ((pid === 102 && signal === "SIGTERM") ||
        (pid === 103 && signal === "SIGKILL")) {
        processes = processes.filter((entry) => entry.pid !== pid);
      }
    },
    isProcessAliveImpl: (pid) => processes.some((entry) => entry.pid === pid),
    delayImpl: async (milliseconds) => { now += milliseconds; },
    nowImpl: () => now,
  });
  assert.equal(quitRequests, 1);
  assert.deepEqual(signals, [
    [102, "SIGTERM"],
    [103, "SIGTERM"],
    [103, "SIGKILL"],
  ]);
  assert.equal(processes.some((entry) => entry.pid === 104), true);
});

test("[platform:macos-native] [LCH-05] macOS 只剩历史辅助进程时不调用 AppleScript", async () => {
  const executable = "/Applications/Codex.app/Contents/MacOS/Codex";
  let processes = [{
    pid: 102,
    executablePath: "/Applications/Codex.app/Contents/Resources/native/bare-modifier-monitor",
    role: "bare-modifier-monitor",
  }];
  let now = 0;
  let quitRequests = 0;
  const signals = [];
  await stopMacCodex({
    executable,
    listProcessesImpl: async () => structuredClone(processes),
    requestQuitImpl: async () => { quitRequests += 1; },
    signalProcessImpl: (pid, signal) => {
      signals.push([pid, signal]);
      processes = [];
    },
    isProcessAliveImpl: (pid) => processes.some((entry) => entry.pid === pid),
    delayImpl: async (milliseconds) => { now += milliseconds; },
    nowImpl: () => now,
  });
  assert.equal(quitRequests, 0);
  assert.deepEqual(signals, [[102, "SIGTERM"]]);
});

test("[platform:windows-native] [LCH-05] Windows 关闭 Codex 先请求主窗口正常退出", async () => {
  let invocation = null;
  const requested = await requestWindowsCodexQuit({
    processIds: [42, 42, -1, 73],
    execFileImpl: async (command, args, options) => {
      invocation = { command, args, options };
      return { stdout: "requested\r\n" };
    },
  });
  assert.equal(requested, true);
  assert.equal(invocation.command, "powershell.exe");
  assert.deepEqual(invocation.args.slice(0, 4), [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
  ]);
  assert.match(invocation.args.at(-1), /foreach \(\$processId in @\(42,73\)\)/);
  assert.match(invocation.args.at(-1), /CloseMainWindow\(\)/);
  assert.doesNotMatch(invocation.args.at(-1), /Stop-Process|taskkill|\/F/);
  assert.deepEqual(invocation.options, {
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });
});

test("[platform:windows-native] [LCH-02 TOOL-04] Windows 启动新桌面不会继承旧任务的 app-tools 管道", () => {
  assert.deepEqual(codexLaunchEnvironment({
    Path: "C:\\Windows",
    CODEX_APP_TOOLS_PIPE_PATH: "\\\\.\\pipe\\stale",
  }, {
    CODEX_QUOTA_RELAY_EXECUTABLE: "D:\\relay.exe",
    CODEX_APP_TOOLS_PIPE_PATH: "\\\\.\\pipe\\also-stale",
  }), {
    Path: "C:\\Windows",
    CODEX_QUOTA_RELAY_EXECUTABLE: "D:\\relay.exe",
  });
});

test("[platform:windows-native][platform:wsl-native] [LCH-02 LCH-06] Windows relay 模式只读取 desktop 段的 WSL 设置", () => {
  assert.equal(parseWindowsSubsystemSetting(`
runCodexInWindowsSubsystemForLinux = true
[desktop]
runCodexInWindowsSubsystemForLinux = false
`), false);
  assert.equal(parseWindowsSubsystemSetting(`
[features]
runCodexInWindowsSubsystemForLinux = false
[desktop]
runCodexInWindowsSubsystemForLinux = true # desktop runtime
`), true);
  assert.equal(parseWindowsSubsystemSetting(`
[desktop.extra]
runCodexInWindowsSubsystemForLinux = true
`), false);
});

test("[platform:windows-native][platform:wsl-native] [LCH-02 LCH-06] Windows 生命周期只修改 desktop 运行方式并保留其余配置", () => {
  const original = [
    'model = "gpt-5"',
    "[desktop]",
    "  runCodexInWindowsSubsystemForLinux = false # keep comment",
    "theme = \"dark\"",
    "[features]",
    "multi_agent = true",
    "",
  ].join("\r\n");
  const enabled = updateWindowsSubsystemSetting(original, true);
  assert.match(enabled, /  runCodexInWindowsSubsystemForLinux = true # keep comment/);
  assert.match(enabled, /model = "gpt-5"/);
  assert.match(enabled, /multi_agent = true/);
  assert.ok(enabled.includes("\r\n"));
  assert.equal(parseWindowsSubsystemSetting(enabled), true);
  assert.equal(parseWindowsSubsystemSetting(updateWindowsSubsystemSetting(enabled, false)), false);

  const inserted = updateWindowsSubsystemSetting("[features]\na = true\n", true);
  assert.match(inserted, /\[desktop\]\nrunCodexInWindowsSubsystemForLinux = true\n$/);
  assert.throws(() => updateWindowsSubsystemSetting([
    "[desktop]",
    "runCodexInWindowsSubsystemForLinux = true",
    "runCodexInWindowsSubsystemForLinux = false",
  ].join("\n"), true), /重复/);
});

test("CDP 客户端按请求 ID 配对结果，并传播协议错误和 evaluate 异常", async (t) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const request = JSON.parse(raw.toString());
      if (request.method === "Runtime.evaluate" && request.params.expression === "throw") {
        socket.send(JSON.stringify({
          id: request.id,
          result: { exceptionDetails: { text: "synthetic exception" } },
        }));
      } else if (request.method === "Broken.method") {
        socket.send(JSON.stringify({ id: request.id, error: { message: "protocol failed" } }));
      } else {
        socket.send(JSON.stringify({
          id: request.id,
          result: request.method === "Runtime.evaluate"
            ? { result: { value: 42 } }
            : { echoed: request.params },
        }));
      }
    });
  });
  const { port } = server.address();
  const client = new CdpClient(`ws://127.0.0.1:${port}`, {
    connectTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
  });
  t.after(async () => {
    client.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });

  await client.connect();
  assert.equal(client.isConnected, true);
  assert.deepEqual(await client.request("Test.echo", { value: "ok" }), {
    echoed: { value: "ok" },
  });
  assert.equal(await client.evaluate("6 * 7"), 42);
  await assert.rejects(client.request("Broken.method"), /protocol failed/);
  await assert.rejects(client.evaluate("throw"), /synthetic exception/);
});

test("CDP 目标发现优先官方 app 主页面，并能探测回环调试端口", async (t) => {
  let targets = [
    { type: "page", url: "https://chatgpt.com/other", webSocketDebuggerUrl: "ws://web" },
    { type: "page", url: "app://-/index.html?initialRoute=settings", webSocketDebuggerUrl: "ws://settings" },
    { type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://main" },
    { type: "worker", url: "app://-/worker", webSocketDebuggerUrl: "ws://worker" },
  ];
  const { server } = await startHttpServer(t, (request, response) => {
    if (request.url === "/json/version") return json(response, { Browser: "Codex" });
    if (request.url === "/json/list") return json(response, targets);
    return json(response, {}, 404);
  });
  const { port } = server.address();

  assert.equal(await isCodexDebugPortReady(port), true);
  assert.equal((await findCodexTarget(port)).webSocketDebuggerUrl, "ws://main");
  targets = [{ type: "page", url: "https://chatgpt.com/codex", webSocketDebuggerUrl: "ws://web" }];
  assert.equal((await findCodexTarget(port)).webSocketDebuggerUrl, "ws://web");
  assert.equal(await isCodexDebugPortReady(port + 1, { timeoutMs: 50 }), false);
});

test("relay 配置和进程状态同时校验 generation、PID 与进程身份", async (t) => {
  const directory = await useTempDir(t, "codex-relay-readiness-");
  const configPath = join(directory, "config.json");
  const statePath = join(directory, "state.json");
  await writeFile(configPath, JSON.stringify({ generation: "g1" }));
  assert.equal(await isRelayConfigCurrent(configPath, "g1"), true);
  assert.equal(await isRelayConfigCurrent(configPath, "g2"), false);
  assert.equal(await isRelayConfigCurrent(join(directory, "missing.json"), "g1"), false);

  await writeFile(statePath, JSON.stringify({
    generation: "g1",
    pid: process.pid,
    processStartedAt: Date.now() - process.uptime() * 1_000,
  }));
  assert.equal(
    await isRelayStateCurrent(statePath, "g1"),
    process.platform === "darwin" || process.platform === "win32",
  );
  assert.equal(await isRelayStateCurrent(statePath, "g2"), false);
  await writeFile(statePath, JSON.stringify({ generation: "g1", pid: -1 }));
  assert.equal(await isRelayStateCurrent(statePath, "g1"), false);
});

test("[platform:macos-native] macOS 进程列表只匹配完整官方可执行路径，避免误判 helper", () => {
  const executable = "/Applications/Codex.app/Contents/MacOS/Codex";
  assert.deepEqual(parseProcessList([
    `  101 ${executable}`,
    `  102 ${executable} Helper`,
    "  103 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    "invalid",
  ].join("\n"), executable), [101]);
});

test("单实例版本比较覆盖升级、降级、预发布后缀和非法版本", () => {
  assert.equal(compareVersions("0.1.176", "0.1.175"), 1);
  assert.equal(compareVersions("v1.0.0-beta", "1.0.0"), 0);
  assert.equal(compareVersions("1.2.2", "1.2.10"), -1);
  assert.equal(compareVersions("invalid", "1.0.0"), 0);
});

test("单实例协议会保留普通重复启动，并允许显式正式版接管开发版", async (t) => {
  const reservation = createTcpServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const { port } = reservation.address();
  await new Promise((resolve) => reservation.close(resolve));
  let takeoverRequest = null;
  const owner = await acquireSingleInstance({
    port,
    mode: "dev",
    version: "1.0.0",
    explicitStart: true,
    onTakeover: async (request) => {
      takeoverRequest = request;
      await closeSingleInstance(owner);
    },
  });
  let replacement = null;
  t.after(async () => {
    await closeSingleInstance(replacement);
    await closeSingleInstance(owner);
  });

  assert.equal(await acquireSingleInstance({
    port,
    mode: "dev",
    version: "1.0.1",
    explicitStart: false,
  }), null);
  replacement = await acquireSingleInstance({
    port,
    mode: "formal",
    version: "1.0.0",
    explicitStart: true,
  });
  assert.ok(replacement?.listening);
  assert.equal(takeoverRequest.mode, "formal");
  assert.equal(takeoverRequest.explicitStart, true);
});

test("[platform:windows-native] Windows 安装接管允许同版本正式包退出，并在持锁期间关闭 Codex", async (t) => {
  const reservation = createTcpServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const { port } = reservation.address();
  await new Promise((resolve) => reservation.close(resolve));
  let takeoverRequest = null;
  const owner = await acquireSingleInstance({
    port,
    mode: "formal",
    version: "1.2.3",
    explicitStart: true,
    onTakeover: async (request) => {
      takeoverRequest = request;
      await closeSingleInstance(owner);
    },
  });
  const replacement = await acquireSingleInstance({
    port,
    mode: "formal",
    version: "1.2.3",
    explicitStart: true,
    purpose: "install-update",
  });
  t.after(async () => {
    await closeSingleInstance(replacement);
    await closeSingleInstance(owner);
  });
  assert.ok(replacement?.listening);
  assert.equal(takeoverRequest.purpose, "install-update");

  const calls = [];
  const lock = { listening: true };
  await prepareWindowsUpdate({
    version: "1.2.3",
    acquireSingleInstanceImpl: async (options) => {
      calls.push(["acquire", options]);
      return lock;
    },
    stopCodexImpl: async (options) => { calls.push(["stop", options]); },
    closeSingleInstanceImpl: async (value) => { calls.push(["close", value]); },
  });
  assert.deepEqual(calls, [
    ["acquire", {
      mode: "formal",
      version: "1.2.3",
      explicitStart: true,
      purpose: "install-update",
    }],
    ["stop", { timeoutMs: 10_000 }],
    ["close", lock],
  ]);
});

test("Widget 桥接表达式安全传输完整数据、revision 和增量，不依赖页面操作", () => {
  const calls = [];
  const window = {
    __codexQuotaWidget: {
      version: WIDGET_RUNTIME_VERSION,
      update(...args) { calls.push(["update", ...args]); },
      updateTokenUsage(...args) { calls.push(["usage", ...args]); },
      updateTokenUsageDelta(...args) { calls.push(["delta", ...args]); },
      drainActions() { return [{ type: "refresh" }]; },
    },
  };
  const evaluate = (expression) => Function("window", `return (${expression})`)(window);
  const payload = { text: "引号 ' \" 与 </script>", nested: { enabled: true } };
  evaluate(widgetUpdateExpression(payload));
  evaluate(widgetUpdateExpressionJson(JSON.stringify(payload), "view-2"));
  evaluate(widgetTokenUsageUpdateExpressionJson(JSON.stringify({ turns: [payload] }), 3));
  evaluate(widgetTokenUsageDeltaUpdateExpressionJson(JSON.stringify({ upserts: [payload] }), 4));

  assert.deepEqual(calls, [
    ["update", payload],
    ["update", payload, "view-2"],
    ["usage", { turns: [payload] }, 3],
    ["delta", { upserts: [payload] }, 4],
  ]);
  assert.equal(evaluate(widgetRuntimeVersionExpression()), WIDGET_RUNTIME_VERSION);
  assert.deepEqual(evaluate(widgetDrainActionsExpression()), [{ type: "refresh" }]);
  const installExpression = widgetInstallExpression();
  assert.doesNotThrow(() => new Function("window", "document", installExpression));
  assert.match(installExpression, /迁移账号/);
  assert.match(installExpression, /临时使用/);
  assert.match(installExpression, /完整转移/);
  assert.match(installExpression, /已转出/);
  assert.match(installExpression, /可能使新设备登录失效/);
  assert.doesNotMatch(installExpression, /导出全部|两台设备都要长期使用/);

  const details = Array.from({ length: 45 }, (_value, index) => ({ sequence: index + 1 }));
  assert.deepEqual(paginateGenerationDetails(details, 20), {
    total: 45,
    items: details.slice(25).reverse(),
    remaining: 25,
  });
  assert.deepEqual(paginateGenerationDetails(details, 40), {
    total: 45,
    items: details.slice(5).reverse(),
    remaining: 5,
  });
  assert.equal(formatGenerationDetailTitle({
    toolNames: ["exec_command", "read_thread"],
    toolTiming: { toolCount: 3 },
  }), "exec_command、read_thread");
  assert.equal(formatGenerationDetailTitle({
    toolNames: ["exec_command", "read_thread", "web_search"],
    toolTiming: { toolCount: 5 },
  }), "exec_command、read_thread、web_search");
  assert.equal(formatGenerationDetailTitle({
    toolExecutions: { complete: true, calls: [{ toolName: "exec_command" }, { toolName: "exec_command" }] },
  }), "exec_command ×2");
  assert.equal(formatGenerationDetailTitle({
    toolNames: ["exec"],
    toolExecutions: { complete: true, calls: [
      { toolName: "exec_command" }, { toolName: "apply_patch" },
      { toolName: "exec_command" }, { toolName: "view_image" },
    ] },
  }), "exec_command ×2、apply_patch、view_image");
  assert.equal(formatGenerationDetailTitle({
    toolExecutions: { complete: true, calls: [{ toolName: "apply_patch" }] },
  }), "apply_patch");
  assert.equal(formatGenerationDetailTitle({ hasVisibleText: true }, true), "最终回复");
  assert.equal(formatGenerationDetailTitle({ followsToolResult: true }), "处理工具结果");
  assert.equal(formatGenerationPhaseText({
    hasVisibleText: true,
    responseLatencyMs: 300,
    firstTokenLatencyMs: 1_500,
    generationDurationMs: 500,
    textPhases: [{ phase: "final_answer", startLatencyMs: 1_500, durationMs: 500 }],
  }), "响应 300ms · 模型处理 1.2s · 回复生成 500ms");
  assert.equal(formatGenerationPhaseText({
    hasVisibleText: true,
    responseLatencyMs: 300,
    textPhases: [{ phase: "commentary", startLatencyMs: 1_300, durationMs: 700 }],
    toolNames: ["exec"],
    toolTiming: {
      readyLatencyMs: 3_000,
      preparationStartLatencyMs: 2_600,
      preparationDurationMs: 400,
      durationMs: 200,
    },
  }), "响应 300ms · 模型处理 1.0s · 中间说明 700ms · 继续处理 600ms · 生成调用 400ms");
  assert.equal(formatGenerationPhaseText({}), "");
  assert.equal(formatGenerationPrimaryText({
    firstTokenLatencyMs: 10_900,
    outputSpeed: 62.9,
    networkLatency: { status: "stable", latencyMs: 260 },
  }), "首字 10.9s · 速率 62.9 tok/s · 延时 260ms");
  assert.equal(formatGenerationPrimaryText({
    toolTiming: { readyLatencyMs: 7_700, durationMs: 196 },
    networkLatency: { status: "fluctuating", latencyMs: 420 },
  }), "延时 420ms（网络波动）");
  assert.equal(formatGenerationPrimaryText({
    firstTokenLatencyMs: 5_800,
    hasVisibleText: true,
    outputSpeed: 99,
    toolTiming: { readyLatencyMs: 8_900, durationMs: 8_100 },
  }), "首字 5.8s · 速率 99.0 tok/s · 延时 —");
  assert.equal(averageGenerationNetworkLatency([
    { networkLatency: { latencyMs: 260 } },
    { networkLatency: { latencyMs: 276 } },
    { networkLatency: null },
    { networkLatency: { latencyMs: 244 } },
  ]), 260);
  assert.equal(averageGenerationNetworkLatency([{ networkLatency: null }]), null);
});

test("可归属输出段展示速率，混合请求只在上层展示平均速率，不给子段编造速率", () => {
  const tool = {
    hasVisibleText: false, outputSpeed: 40,
    toolTiming: { readyLatencyMs: 3_000, durationMs: 7_000 },
    outputPhases: [{ kind: "tool", startLatencyMs: 1_000, durationMs: 1_000, outputSpeed: 40 }],
  };
  assert.equal(formatGenerationPrimaryText(tool), "速率 40.0 tok/s · 延时 —");
  assert.equal(formatGenerationPhaseText(tool), "生成调用 1.0s（40 tok/s）");
  const text = {
    hasVisibleText: true, firstTokenLatencyMs: 1_000, outputSpeed: 25,
    textPhases: [{ phase: "commentary", startLatencyMs: 1_000, durationMs: 2_000 }],
    outputPhases: [{ kind: "text", textPhaseIndex: 0, startLatencyMs: 1_000, durationMs: 2_000, outputSpeed: 25 }],
  };
  assert.equal(formatGenerationPhaseText(text), "中间说明 2.0s（25 tok/s）");
  const mixed = { ...text, toolTiming: tool.toolTiming,
    outputPhases: [
      { kind: "text", textPhaseIndex: 0, startLatencyMs: 1_000, durationMs: 2_000 },
      { kind: "tool", startLatencyMs: 4_000, durationMs: 1_000 },
    ],
  };
  assert.ok(formatGenerationPrimaryText(mixed).includes("速率 25.0 tok/s"));
  assert.equal(formatGenerationPhaseText(mixed), "中间说明 2.0s · 继续处理 1.0s · 生成调用 1.0s");
});

test("请求分层保留中间说明和最终回复阶段，工具单项不重复摊派模型时间", () => {
  const detail = {
    hasVisibleText: true, firstTokenLatencyMs: 1_000, responseLatencyMs: 300,
    textPhases: [
      { phase: "commentary", startLatencyMs: 1_000, durationMs: 500 },
      { phase: "commentary", startLatencyMs: 2_000, durationMs: 500 },
      { phase: "final_answer", startLatencyMs: 3_000, durationMs: 1_000 },
    ],
  };
  assert.equal(formatGenerationPhaseText(detail),
    "响应 300ms · 模型处理 700ms · 中间说明 500ms · 继续处理 500ms · 中间说明 500ms · 继续处理 500ms · 回复生成 1.0s");
  assert.equal(formatGenerationDetailTitle(detail, true), "最终回复");
  const calls = Array.from({ length: 60 }, (_, index) => ({
    id: `call-${index}`, toolName: "exec_command", description: "npm test", durationMs: index,
  }));
  const tools = { toolExecutions: { calls, durationMs: 6_500, complete: true },
    toolTiming: { readyLatencyMs: 3_000, durationMs: 7_000 },
    hasVisibleText: false, firstTokenLatencyMs: 1_000 };
  assert.equal(formatGenerationDetailTitle(tools), "exec_command ×60");
  assert.deepEqual(generationToolRows(tools), calls, "all invocations, including repeated names, stay flat");
  assert.equal(generationToolRows({ toolExecutions: { calls: calls.slice(0, 1) } }).length, 1);
  assert.equal(formatGenerationPrimaryText(tools), "延时 —");
  assert.deepEqual(generationToolRows({ toolTiming: { calls: [{ toolName: "exec", durationMs: 6_500 }] } }),
    [{ toolName: "exec", description: "调用耗时", durationMs: 6_500, durationSource: "outer-exec" }]);
  const source = widgetInstallExpression();
  assert.ok(source.includes("max-height:240px;overflow-x:hidden;overflow-y:auto;scrollbar-gutter:stable"));
  assert.ok(source.includes("max-height:180px;overflow-x:hidden;overflow-y:auto;scrollbar-gutter:stable"));
  assert.ok(source.includes("data-codex-scrollbar-container"));
  assert.ok(source.includes("display:flex;flex-wrap:wrap"));
  assert.ok(source.includes('name.style.cssText = "min-width:0;color:var(--color-token-text-tertiary,#9a9aa4);white-space:nowrap;overflow:hidden;text-overflow:ellipsis"'),
    "request tool names stay on one line and ellipsize within their grid column");
  assert.equal(source.includes("name.title = title;"), false, "truncated request tool names do not show a hover tooltip");
  assert.equal(source.includes('split(" → ")'), false);
});

test("请求明细只在覆盖式滚动条下补右侧保护间距", () => {
  assert.equal(calculateScrollbarEndPadding(394, 379), 1,
    "Windows 实测 15px 经典滚动条后只补足剩余的 1px");
  assert.equal(calculateScrollbarEndPadding(394, 394), 16,
    "macOS 覆盖式滚动条没有 gutter，保留内容保护间距");
  assert.equal(calculateScrollbarEndPadding(394, 393, 1), 16,
    "容器边框不能被误算成滚动条宽度");
  assert.equal(calculateScrollbarEndPadding(394, 374), 0,
    "宽滚动条已经超过目标保护间距时不再增加空白");
  assert.equal(calculateScrollbarEndPadding(undefined, undefined), 16);
});

test("截图请求的标题保留首字速率延时，展开补齐最后输出到工具调用完成的 141ms", () => {
  const detail = {
    hasVisibleText: true, firstTokenLatencyMs: 4_417, responseLatencyMs: 407,
    outputSpeed: 35.149840227998965,
    networkLatency: { status: "stable", latencyMs: 220 },
    textPhases: [{ phase: "commentary", startLatencyMs: 4_417, durationMs: 3_441 }],
    outputPhases: [
      { kind: "text", textPhaseIndex: 0, startLatencyMs: 4_417, durationMs: 3_441 },
      { kind: "tool", startLatencyMs: 8_262, durationMs: 8_138 },
    ],
    outputPhasesComplete: true,
    toolTiming: { readyLatencyMs: 16_541, durationMs: 183 },
    toolExecutions: { complete: true, durationMs: 173,
      calls: [{ toolName: "exec_command", durationMs: 0.00375 }] },
  };
  assert.equal(formatGenerationPrimaryText(detail), "首字 4.4s · 速率 35.1 tok/s · 延时 220ms");
  assert.equal(formatGenerationPhaseText(detail),
    "响应 407ms · 模型处理 4.0s · 中间说明 3.4s · 继续处理 404ms · 生成调用 8.1s · 调用收尾 141ms");
  assert.equal(generationExecutionRemainder(detail), 173 - 0.00375);
  assert.equal(formatGenerationPhaseText({ ...detail, outputPhasesComplete: false }).includes("调用收尾"), false,
    "missing output phases cannot be relabeled as a measured completion tail");
});

test("其余调用耗时扣除并行子工具的覆盖区间，缺少计时不能伪造差额", () => {
  const execution = { complete: true, durationMs: 120, calls: [
    { startedAt: 10, durationMs: 70 },
    { startedAt: 30, durationMs: 60 },
  ] };
  assert.equal(generationExecutionRemainder({ toolExecutions: execution }), 40);
  for (const incomplete of [
    { ...execution, complete: false },
    { ...execution, durationMs: null },
    { ...execution, calls: [...execution.calls, { startedAt: 50, durationMs: null }] },
    { ...execution, calls: execution.calls.map(({ durationMs }) => ({ durationMs })) },
    { ...execution, durationMs: 50 },
  ]) {
    assert.equal(generationExecutionRemainder({ toolExecutions: incomplete }), null);
  }
  assert.equal(generationExecutionRemainder({ toolTiming: { durationMs: 173 } }), null);
});

test("悬浮面板高度只使用标题栏以下空间并限制在 720px", () => {
  assert.equal(calculatePopoverMaxHeight(1_000), 720);
  assert.equal(calculatePopoverMaxHeight(300.9), 246);
  assert.equal(calculatePopoverMaxHeight(40), 0);
  assert.equal(calculatePopoverMaxHeight("not-a-number"), 0);
});

test("文件与命令共用原生折叠列表，完整逐行展示且耗时只属于工具行", () => {
  // Test the actual injected renderer without a browser, clicks or Codex.
  const render = new Function(`return (${createGenerationToolRow.toString()})`)();
  const document = { createElement(tag) {
    return { tag, style: {}, children: [], textContent: "", append(...children) { this.children.push(...children); } };
  } };
  const cases = [
    { toolName: "apply_patch", kind: "files", unit: "个文件",
      items: Array.from({ length: 80 }, (_, index) => `${"long-name-".repeat(15)}${index}.mjs`) },
    { toolName: "exec_command", kind: "commands", unit: "条命令",
      items: ["node --check tool-executions.mjs", "git diff", "npm test"] },
    { toolName: "exec_command", kind: "commands", unit: "条命令", items: ["node launcher.mjs"] },
  ];
  for (const { toolName, kind, unit, items } of cases) {
    let durationFormats = 0;
    const row = render(document, { toolName, durationMs: 152, detailList: { kind, items } }, (value) => {
      durationFormats += 1;
      return `${value}ms`;
    });
    assert.equal(row.tag, "details");
    assert.equal(Boolean(row.open), false, "default state is collapsed");
    const [summary, list] = row.children;
    assert.equal(summary.tag, "summary", "native summary provides click/keyboard toggling");
    const [name, duration] = summary.children[0].children;
    assert.equal(name.textContent, `${toolName} · ${items.length} ${unit}`);
    assert.equal(duration.textContent, "152ms");
    assert.equal(durationFormats, 1, "no invented per-file or per-command duration");
    assert.deepEqual(list.children.map((entry) => entry.textContent), items);
    assert.ok(list.children.every((entry) => entry.children.length === 0));
    assert.ok(list.children.every((entry) => entry.style.cssText.includes("overflow-wrap:anywhere")));
    assert.ok(!list.style.cssText.includes("overflow"), "reuse request scrolling instead of another scroll area");
  }
  const missing = render(document, { toolName: "exec", description: "单项明细未记录" }, () => assert.fail("no measured duration"));
  assert.equal(missing.tag, "div", "do not reconstruct a list from truncated legacy text");
  assert.equal(missing.children[1].textContent, "未记录");
  const outer = render(document, {
    toolName: "write_stdin", description: "调用耗时", durationMs: 5_100, durationSource: "outer-exec",
  }, (value) => `${value / 1_000}s`);
  assert.equal(outer.children[0].textContent, "write_stdin · 调用耗时");
  assert.equal(outer.children[1].textContent, "5.1s");
  assert.ok(outer.children[1].title.includes("由外层 exec 计时"));
  assert.ok(outer.children[1].title.includes("不等同于子工具自身执行耗时"));
  const tiny = render(document, { toolName: "exec_command", durationMs: 0.00375 }, () => assert.fail("must not round to zero"));
  assert.equal(tiny.children[1].textContent, "<1ms");
  const remainder = render(document, {
    toolName: "其余调用耗时", durationMs: 173 - 0.00375, approximate: true,
  }, (value) => `${Math.round(value)}ms`);
  assert.equal(remainder.children[0].textContent, "其余调用耗时");
  assert.equal(remainder.children[1].textContent, "约173ms");
  assert.ok(remainder.children[1].title.includes("不能直接归因为网络或调度耗时"));
});

test("会话外层按约定展示缓存命中率、加权速率和连接 RTT", () => {
  const usage = {
    completed: false,
    totalTokens: 184_000,
    inputTokens: 184_000,
    cachedInputTokens: 183_000,
    cumulativeTotalTokens: 2_285_000,
    firstTokenLatencyMs: 7_400,
    outputSpeed: 56.8,
    networkLatencySupported: true,
    networkConnectionId: "official-ws-1",
    networkLatency: {
      status: "stable",
      latencyMs: 52,
      sampledAt: 10,
      connectionId: "official-ws-1",
    },
    cost: { available: true, totalCny: 0.5685 },
  };
  const liveNetwork = {
    status: "stable",
    latencyMs: 48,
    sampledAt: 20,
    connectionId: "official-ws-1",
  };
  assert.equal(selectConversationNetworkLatency(usage, liveNetwork), liveNetwork);
  assert.equal(
    formatConversationUsageSummary(
      usage,
      selectConversationNetworkLatency(usage, liveNetwork),
    ),
    "本轮 Token 0.184M · 缓存命中率 99.5% · 累计 2.285M · 首字 7.4s · 速率 56.8 tok/s · 延时 48ms · 价格 ¥0.5685",
  );

  const completed = { ...usage, completed: true };
  assert.equal(selectConversationNetworkLatency(completed, liveNetwork), usage.networkLatency);
  const unsupported = {
    ...usage,
    networkLatencySupported: false,
    networkConnectionId: null,
    networkLatency: null,
  };
  assert.equal(selectConversationNetworkLatency(unsupported, liveNetwork), null);
  assert.equal(formatNetworkLatencyText({ status: "stable", latencyMs: 48 }), "延时 48ms");
  assert.equal(
    formatNetworkLatencyText({ status: "fluctuating", latencyMs: 420 }),
    "延时 420ms（网络波动）",
  );
  assert.equal(
    formatNetworkLatencyText({ status: "reconnecting", latencyMs: null }),
    "延时 —（连接重建）",
  );
});
