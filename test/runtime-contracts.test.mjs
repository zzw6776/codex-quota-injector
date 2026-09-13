import assert from "node:assert/strict";
import { createServer as createTcpServer } from "node:net";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";

import { CdpClient, findCodexTarget, isCodexDebugPortReady } from "../src/cdp-client.mjs";
import {
  isRelayConfigCurrent,
  isRelayStateCurrent,
  parseWindowsSubsystemSetting,
  updateWindowsSubsystemSetting,
  parseProcessList,
  requestMacCodexQuit,
  requestWindowsCodexQuit,
} from "../src/platform.mjs";
import {
  acquireSingleInstance,
  closeSingleInstance,
  compareVersions,
} from "../src/single-instance.mjs";
import { prepareWindowsUpdate } from "../src/windows-update.mjs";
import {
  WIDGET_RUNTIME_VERSION,
  averageGenerationNetworkLatency,
  calculatePopoverMaxHeight,
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

test("[A LCH-05] macOS 关闭 Codex 使用标准退出事件，不直接发送终止信号", async () => {
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

test("[A LCH-05] Windows 关闭 Codex 先请求主窗口正常退出", async () => {
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

test("[A LCH-02 LCH-06] Windows relay 模式只读取 desktop 段的 WSL 设置", () => {
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

test("[A LCH-02 LCH-06] Windows 生命周期只修改 desktop 运行方式并保留其余配置", () => {
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

test("macOS 进程列表只匹配完整官方可执行路径，避免误判 helper", () => {
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

test("Windows 安装接管允许同版本正式包退出，并在持锁期间关闭 Codex", async (t) => {
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
  assert.doesNotThrow(() => new Function("window", "document", widgetInstallExpression()));

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
    [{ toolName: "exec", description: "单项明细未记录", durationMs: null }]);
  const source = widgetInstallExpression();
  assert.ok(source.includes("max-height:240px;overflow-x:hidden;overflow-y:auto;scrollbar-gutter:stable"));
  assert.ok(source.includes("max-height:180px;overflow-x:hidden;overflow-y:auto;scrollbar-gutter:stable"));
  assert.ok(source.includes("padding-right:16px"), "outer request metrics keep clear of overlay scrollbars");
  assert.ok(source.includes("padding:4px 16px 4px 5px"), "expanded tool durations keep clear of overlay scrollbars");
  assert.ok(source.includes("display:flex;flex-wrap:wrap"));
  assert.ok(source.includes('name.style.cssText = "min-width:0;color:var(--color-token-text-tertiary,#9a9aa4);white-space:nowrap;overflow:hidden;text-overflow:ellipsis"'),
    "request tool names stay on one line and ellipsize within their grid column");
  assert.equal(source.includes("name.title = title;"), false, "truncated request tool names do not show a hover tooltip");
  assert.equal(source.includes('split(" → ")'), false);
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
