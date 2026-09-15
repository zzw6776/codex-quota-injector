import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  backendComponentId,
  combineBStatuses,
  desktopComponentId,
  desktopHostProgressHtml,
  desktopHostPrompt,
  evaluateDesktopHostEvidence,
  findDesktopRolloutEvidence,
  isDesktopSessionTerminal,
  parseDesktopRollout,
  parseRequestToolInventory,
} from "../scripts/desktop-host-evidence.mjs";
import {
  desktopRuntimeInfrastructureReady,
  readDesktopWidgetState,
  retryDesktopRuntimeInspection,
} from "../scripts/test-desktop-host.mjs";
import { useTempDir } from "./helpers.mjs";

const marker = "BHOST_0123456789abcdef";

test("[A HAR-04 UI-01] 桌面版本门禁从 Widget 的 Shadow DOM 读取实际版本", () => {
  const lightDomVersion = { textContent: "v0.0.1" };
  const shadowDomVersion = { textContent: "  WSL · v1.2.3.dev  " };
  const root = {
    querySelector: () => lightDomVersion,
    shadowRoot: { querySelector: selector => selector === ".panel-version-text" ? shadowDomVersion : null },
  };
  const actual = readDesktopWidgetState({
    document: { getElementById: id => id === "codex-quota-injector-root" ? root : null },
    __codexQuotaWidget: { version: 125 },
  });
  assert.deepEqual(actual, {
    runtimeVersion: 125,
    footerText: "WSL · v1.2.3.dev",
  });
});

test("[A HAR-04 ENV-03] 桌面运行时轮换期间等待同代 Relay 恢复后再判定", async () => {
  const results = [
    { status: "failed", actual: { host: { readiness: { ready: false } } } },
    { status: "failed", actual: { host: { readiness: { ready: false } } } },
    { status: "passed", actual: { host: { readiness: { ready: true } } } },
  ];
  let calls = 0;
  const result = await retryDesktopRuntimeInspection(
    async () => results[Math.min(calls++, results.length - 1)],
    { attempts: 6, intervalMs: 0, wait: async () => undefined },
  );
  assert.equal(result.status, "passed");
  assert.equal(calls, 3);
});

test("[A HAR-04 ENV-03 TOOL-05] 桌面启动前检查不绑定发起任务的 codex_app 会话", () => {
  const readiness = {
    ready: false,
    codexRunning: true,
    debugReady: true,
    singleInjector: true,
    relayReady: true,
    protocolMatches: true,
    hostToolsReady: false,
  };
  assert.equal(desktopRuntimeInfrastructureReady(readiness), true);
  assert.equal(desktopRuntimeInfrastructureReady({ ...readiness, relayReady: false }), false);
});

test("[A HAR-04 TOOL-04 TOOL-05 TOOL-06] 桌面报告从真实任务记录和独立 HTTP 证据判定供应商及工具链", () => {
  const rollout = parseDesktopRollout(fixtureRollout("deepseek-flash"), {
    marker,
    profile: "deepseek",
    customModels: ["deepseek-flash", "custom-model"],
    path: "/fixture/rollout.jsonl",
  });
  assert.equal(rollout.threadId, "thread-desktop");
  assert.equal(rollout.model, "deepseek-flash");
  assert.equal(rollout.modelMatches, true);
  assert.deepEqual(rollout.checks, {
    functionsExec: true,
    functionsExecFailure: true,
    codexAppListThreads: true,
    codexAppReadThread: true,
    codexAppReadContent: true,
    codexAppReadEmptyCompletedTurns: false,
    codexAppReadMarker: true,
    codexAppListProjects: true,
    codexAppGetUsageLimits: true,
    webSearch: true,
    webOpen: true,
    webFind: true,
    webResult: true,
    computerUse: true,
    computerInput: true,
    computerSubmit: true,
    computerScreenshot: true,
  });
  assert.ok(!JSON.stringify(rollout).includes("SECRET_RESULT_BODY"), "报告不能复制工具正文");

  const result = evaluateDesktopHostEvidence({
    profile: "deepseek",
    marker,
    runtimeBinding: { status: "passed" },
    rollout,
    httpEvidence: {
      submissions: [{ value: marker, at: "2026-09-13T00:00:00.000Z" }],
      invalidSubmissions: 0,
      artifactRequests: 1,
    },
    sourceCurrent: true,
  });
  assert.equal(result.status, "passed");
  assert.ok(result.checks.every(check => check.status === "passed"));
});

test("[platform:windows-native] [A HAR-04 TOOL-06] Windows 桌面报告只接受原生应用的独立启动与提交证据", () => {
  const rollout = parseDesktopRollout(fixtureRollout("gpt-6-astra"), {
    marker,
    profile: "official",
  });
  const shared = {
    profile: "official",
    marker,
    runtimeBinding: { status: "passed" },
    rollout,
    httpEvidence: null,
    computerUseKind: "windows-native",
    nativeComputerUseEvidence: {
      schemaVersion: 1,
      marker,
      launchCount: 1,
      submissions: [{ value: marker }],
    },
  };
  const passed = evaluateDesktopHostEvidence(shared);
  assert.equal(passed.status, "passed");
  assert.equal(passed.checks.some((item) => item.id === "download"), false);

  const repeated = evaluateDesktopHostEvidence({
    ...shared,
    nativeComputerUseEvidence: {
      ...shared.nativeComputerUseEvidence,
      launchCount: 2,
    },
  });
  assert.equal(repeated.status, "failed");
  assert.equal(repeated.checks.find((item) => item.id === "computer-use").status, "not-run");
});

test("[A HAR-04 MOD-03] B1/B2 桌面证据不能继承其他模型、旧源码或另一组件结果", () => {
  const deepseek = parseDesktopRollout(fixtureRollout("deepseek-flash"), {
    marker,
    profile: "official",
    customModels: ["deepseek-flash"],
  });
  assert.equal(deepseek.modelMatches, false);
  const result = evaluateDesktopHostEvidence({
    profile: "official",
    marker,
    runtimeBinding: { status: "passed" },
    rollout: deepseek,
    httpEvidence: { submissions: [{ value: marker }], artifactRequests: 1 },
    sourceCurrent: false,
  });
  assert.equal(result.status, "failed");
  assert.equal(combineBStatuses("passed", "not-run"), "incomplete");
  assert.equal(combineBStatuses("passed", "passed"), "passed");
  assert.equal(combineBStatuses("passed", "failed"), "failed");
  assert.equal(backendComponentId("official", "windows-native"), "B1-official-backend/windows-native");
  assert.equal(desktopComponentId("deepseek", "wsl-native"), "B2-deepseek-desktop/wsl-native");
});

test("[A HAR-04 TOOL-04] 失败命令之后没有真实工具调用时不得声称任务已续接", () => {
  const content = fixtureRollout("gpt-6-astra").split("\n")
    .filter((line) => !line.includes('"call_id":"web-') && !line.includes('"call_id":"cua-') &&
      !line.includes('"call_id":"input-') && !line.includes('"call_id":"codex-'))
    .join("\n");
  const rollout = parseDesktopRollout(content, { marker, profile: "official" });
  assert.equal(rollout.checks.functionsExec, true);
  assert.equal(rollout.checks.functionsExecFailure, false);
});

test("[platform:windows-native] [A HAR-04 TOOL-04] Windows 失败命令重试后采信真实保留的退出码", () => {
  const records = fixtureRollout("gpt-6-astra").trim().split("\n").map(JSON.parse);
  const exactFailureIndex = records.findIndex((record) =>
    record.type === "response_item" && record.payload?.input?.includes(`FAIL_${marker}`));
  records.splice(exactFailureIndex, 0,
    functionTool("exec-normalized", "exec", `node -e \"process.stderr.write('FAIL_${marker}');process.exit(23)\"`),
    functionOutput("exec-normalized", JSON.stringify({ exit_code: 1, output: `FAIL_${marker}` })),
  );
  const rollout = parseDesktopRollout(records.map(JSON.stringify).join("\n"), { marker, profile: "official" });
  assert.equal(rollout.checks.functionsExecFailure, true);
});

test("[A HAR-04 TOOL-04] 常用只读入口返回工具错误时不得通过桌面验收", () => {
  const content = fixtureRollout("gpt-6-astra")
    .replace('"output":"rateLimits: available"',
      '"output":"{\\"isError\\":true,\\"message\\":\\"tool call failed\\"}"');
  const rollout = parseDesktopRollout(content, { marker, profile: "official" });
  assert.equal(rollout.checks.codexAppListProjects, true);
  assert.equal(rollout.checks.codexAppGetUsageLimits, false);
});

test("[A HAR-04 TOOL-04] 委托任务按自身 ID 重试 read_thread，不要求 list_threads 立即列出它", () => {
  const records = fixtureRollout("gpt-6-astra").trim().split("\n").map(JSON.parse);
  const listOutput = records.find((record) => record.payload?.call_id === "codex-list" &&
    record.payload?.type === "function_call_output");
  listOutput.payload.output = JSON.stringify({ schemaVersion: 4, threads: [] });
  const correctReadIndex = records.findIndex((record) => record.payload?.call_id === "codex-read" &&
    record.payload?.type === "function_call");
  records.splice(correctReadIndex, 0,
    functionTool("codex-read-wrong", "read_thread", '{"threadId":"another-thread"}', "mcp__codex_app"),
    functionOutput("codex-read-wrong", readThreadOutput(marker)),
  );
  const rollout = parseDesktopRollout(records.map(JSON.stringify).join("\n"), { marker, profile: "official" });
  assert.equal(rollout.checks.codexAppListThreads, true);
  assert.equal(rollout.callIds.codexAppReadThread, "codex-read");
  assert.equal(rollout.checks.codexAppReadThread, true);
});

test("[A HAR-04 TOOL-06] 当前 computer use 的 getScreenshot 调用会计入真实截图证据", () => {
  const content = fixtureRollout("gpt-6-astra").replace("await tab.screenshot();", "await tab.getScreenshot();");
  const rollout = parseDesktopRollout(content, { marker, profile: "official" });
  assert.equal(rollout.checks.computerScreenshot, true);
});

test("[A HAR-04 TOOL-06] Computer Use 截图调用失败不能因调用发生而通过", () => {
  const content = fixtureRollout("gpt-6-astra")
    .replace('"output":"SECRET_RESULT_BODY"',
      '"output":"tool call error: SetIsBorderRequired failed: 0x80004002"');
  const rollout = parseDesktopRollout(content, { marker, profile: "official" });
  assert.equal(rollout.checks.computerUse, false);
  assert.equal(rollout.checks.computerScreenshot, false);
  assert.equal(rollout.callIds.computerScreenshot.length, 1);
});

test("[platform:windows-native] [A HAR-04 TOOL-06] Windows 截图仅在官方无 Relay 对照一致时标记上游阻断", () => {
  const records = fixtureRollout("gpt-6-astra")
    .replace(" await tab.screenshot();", "")
    .trim().split("\n").map(JSON.parse);
  records.splice(-2, 0,
    functionTool("cua-screenshot", "js",
      "await sky.get_window_state({window,include_screenshot:true})"),
    functionOutput("cua-screenshot",
      "SetIsBorderRequired failed: 不支持此接口 (0x80004002)"),
  );
  const rollout = parseDesktopRollout(records.map(JSON.stringify).join("\n"), {
    marker,
    profile: "official",
  });
  assert.equal(rollout.computerUseFailure, "windows-capture-interface-unsupported");
  assert.equal(rollout.checks.computerUse, true);
  assert.equal(rollout.checks.computerScreenshot, false);
  const shared = {
    profile: "official",
    marker,
    runtimeBinding: { status: "passed", expected: { runtimeTarget: "windows-native" } },
    rollout,
    computerUseKind: "windows-native",
    nativeComputerUseEvidence: {
      schemaVersion: 1,
      marker,
      launchCount: 1,
      submissions: [{ value: marker }],
    },
  };
  const attribution = {
    status: "blocked-upstream",
    layer: "official-windows-computer-use-screenshot",
    reason: "同版本官方无 Relay Computer Use 返回相同截图接口错误",
    controls: {
      officialNoRelay: {
        relayRemoved: true,
        runtimeTarget: "windows-native",
        failure: "windows-capture-interface-unsupported",
      },
      productionRelay: {
        runtimeTarget: "windows-native",
        failure: "windows-capture-interface-unsupported",
      },
    },
  };
  const blocked = evaluateDesktopHostEvidence({
    ...shared,
    upstreamAttributions: { "computer-screenshot": attribution },
  });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.checks.find((item) => item.id === "computer-use").status, "passed");
  assert.equal(blocked.checks.find((item) => item.id === "computer-screenshot").status,
    "blocked-upstream");

  const unverified = structuredClone(attribution);
  unverified.controls.officialNoRelay.relayRemoved = false;
  const failed = evaluateDesktopHostEvidence({
    ...shared,
    upstreamAttributions: { "computer-screenshot": unverified },
  });
  assert.equal(failed.status, "failed");

});

test("[platform:wsl-native] [A HAR-04 TOOL-06] WSL 官方 sandboxCwd 阻断单独标记为上游能力阻断", () => {
  const content = fixtureRollout("gpt-6-astra")
    .replace('"output":"SECRET_RESULT_BODY"',
      '"output":"Mcp error: sandboxCwd is not a local file URI: file:///mnt/d/project"');
  const rollout = parseDesktopRollout(content, { marker, profile: "official" });
  assert.equal(rollout.computerUseFailure, "sandbox-cwd-not-local-file-uri");
  const shared = {
    profile: "official",
    marker,
    rollout,
    computerUseKind: "windows-native",
  };
  const blocked = evaluateDesktopHostEvidence({
    ...shared,
    runtimeBinding: { status: "passed", expected: { runtimeTarget: "wsl-native" } },
  });
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.upstreamReason, /sandboxCwd/);
  assert.equal(blocked.checks.find((item) => item.id === "computer-use").status,
    "blocked-upstream");

  const windowsFailure = evaluateDesktopHostEvidence({
    ...shared,
    runtimeBinding: { status: "passed", expected: { runtimeTarget: "windows-native" } },
  });
  assert.equal(windowsFailure.status, "failed");
});

test("[A HAR-04 TOOL-06] functions.exec 编排的官方 node_repl Computer Use 仍按真实结果留证", () => {
  const content = fixtureRollout("gpt-6-astra")
    .replace('"name":"js","arguments":"let tab=await cua.createBrowserTab(\'iab\',\'http://127.0.0.1\'); await tab.screenshot();"',
      '"name":"exec","input":"await tools.mcp__node_repl__js({code: \\"await sky.type_text({window,text: marker}); await sky.press_key({window,key: \\\'Return\\\'}); await sky.get_window_state({window,include_screenshot:true})\\"})"');
  const rollout = parseDesktopRollout(content, { marker, profile: "official" });
  assert.equal(rollout.checks.computerUse, true);
  assert.equal(rollout.checks.computerInput, true);
  assert.equal(rollout.checks.computerSubmit, true);
  assert.equal(rollout.checks.computerScreenshot, true);
});

test("[A HAR-04 TOOL-04] read_thread 以正确任务和完整完成回合判定，不依赖活动输入回显", () => {
  const content = fixtureRollout("deepseek-flash")
    .replace(
      JSON.stringify(functionOutput("codex-read", readThreadOutput(marker))),
      JSON.stringify(functionOutput("codex-read", readThreadOutput(marker, { items: [] }))),
    );
  const rollout = parseDesktopRollout(content, { marker, profile: "deepseek" });
  assert.equal(rollout.checks.codexAppReadThread, true);
  assert.equal(rollout.checks.codexAppReadContent, false);
  assert.equal(rollout.checks.codexAppReadMarker, false);
  const shared = {
    profile: "deepseek",
    marker,
    runtimeBinding: { status: "passed" },
    rollout,
    toolInventory: { offers: { webRun: true } },
    httpEvidence: { submissions: [{ value: marker }], artifactRequests: 1 },
  };
  assert.equal(evaluateDesktopHostEvidence({ ...shared, triggerMode: "direct" }).status, "failed");
  assert.equal(evaluateDesktopHostEvidence({ ...shared, triggerMode: "delegated" }).status, "failed");

  const partiallyEmptyContent = fixtureRollout("deepseek-flash")
    .replace(
      JSON.stringify(functionOutput("codex-read", readThreadOutput(marker))),
      JSON.stringify(functionOutput("codex-read", readThreadOutput(marker, { turns: [
        { id: "turn-empty", status: "completed", items: [] },
        { id: "turn-full", status: "completed", items: [
          { type: "userMessage", content: [{ type: "text", text: marker }] },
          { type: "agentMessage", text: "reply" },
        ] },
      ] }))),
    );
  const partiallyEmpty = parseDesktopRollout(partiallyEmptyContent, {
    marker,
    profile: "deepseek",
  });
  assert.equal(partiallyEmpty.checks.codexAppReadContent, false);
  assert.equal(evaluateDesktopHostEvidence({
    ...shared,
    rollout: partiallyEmpty,
    triggerMode: "delegated",
  }).status, "failed");

  const delegatedContent = fixtureRollout("deepseek-flash")
    .replace(
      JSON.stringify(functionOutput("codex-read", readThreadOutput(marker))),
      JSON.stringify(functionOutput("codex-read", readThreadOutput("older-message"))),
    );
  const delegatedRollout = parseDesktopRollout(delegatedContent, {
    marker,
    profile: "deepseek",
  });
  assert.equal(delegatedRollout.checks.codexAppReadContent, true);
  assert.equal(delegatedRollout.checks.codexAppReadMarker, false);
  assert.equal(evaluateDesktopHostEvidence({
    ...shared,
    rollout: delegatedRollout,
    triggerMode: "direct",
  }).status, "passed");
  assert.equal(evaluateDesktopHostEvidence({
    ...shared,
    rollout: delegatedRollout,
    triggerMode: "delegated",
  }).status, "passed");
});

for (const delegationTool of ["create_thread", "send_message_to_thread"]) {
test(`[A HAR-04 TOOL-04] read_thread 接受 ${delegationTool} 的真实委托输入，不依赖本轮触发方式`, () => {
  const delegated = delegatedReadInput();
  delegated.name = delegationTool;
  for (const output of [delegated.output, delegated.output.text]) {
    const turns = [
      { id: "human", status: "completed", items: [
        { type: "userMessage", content: [{ type: "text", text: "previous input" }] },
        { type: "agentMessage", text: "previous reply" },
      ] },
      { id: "delegated", status: "completed", items: [
        { ...delegated, output }, { type: "agentMessage", text: "delegated reply" },
      ] },
      { id: "active", status: "inProgress", items: [] },
    ];
    const rollout = rolloutWithReadTurns(turns);
    assert.equal(rollout.checks.codexAppReadContent, true);
    assert.equal(rollout.checks.codexAppReadMarker, false);
    for (const triggerMode of ["direct", "delegated"]) {
      const result = evaluateDesktopHostEvidence({
        profile: "deepseek", marker, triggerMode, rollout,
        runtimeBinding: { status: "passed" },
        toolInventory: { offers: { webRun: true } },
        httpEvidence: { submissions: [{ value: marker }], artifactRequests: 1 },
      });
      assert.equal(result.status, "passed");
    }
  }
});
}

test("[A HAR-04 TOOL-04] read_thread 不把普通工具输出或不完整委托算作用户输入", () => {
  const input = delegatedReadInput();
  const invalidInputs = [
    { ...input, type: "mcpToolCall" },
    { ...input, name: "read_thread" },
    { ...input, namespace: "other" },
    { ...input, output: undefined },
    { ...input, output: { ...input.output, truncated: true } },
    { ...input, output: "ordinary tool result" },
    { ...input, output: "<codex_delegation><input>request</input></codex_delegation>" },
    { ...input, output: input.output.text.replace("source-task", "") },
    { ...input, output: input.output.text.replace("delegated request", "  \n ") },
    { ...input, output: input.output.text.replace("</codex_delegation>", "") },
  ];
  for (const invalid of invalidInputs) {
    const rollout = rolloutWithReadTurns([
      { id: "delegated", status: "completed", items: [invalid, { type: "agentMessage", text: "reply" }] },
    ]);
    assert.equal(rollout.checks.codexAppReadContent, false, JSON.stringify(invalid));
  }
  const splitTurns = rolloutWithReadTurns([
    { id: "input-only", status: "completed", items: [input] },
    { id: "reply-only", status: "completed", items: [{ type: "agentMessage", text: "reply" }] },
  ]);
  assert.equal(splitTurns.checks.codexAppReadContent, false);
});

test("[A HAR-04 TOOL-04] read_thread 不跳过缺失 items 的完成回合，不借用其他任务内容", () => {
  const validTurn = { id: "valid", status: "completed", items: [
    delegatedReadInput(), { type: "agentMessage", text: "reply" },
  ] };
  assert.equal(rolloutWithReadTurns([
    validTurn, { id: "missing", status: "completed" },
  ]).checks.codexAppReadContent, false);
  const content = fixtureRollout("deepseek-flash").replace(
    JSON.stringify(functionOutput("codex-read", readThreadOutput(marker))),
    JSON.stringify(functionOutput("codex-read", JSON.stringify([
      JSON.parse(readThreadOutput(marker, { items: [] })),
      { thread: { id: "other-task" }, turns: [validTurn] },
    ]))),
  );
  const rollout = parseDesktopRollout(content, { marker, profile: "deepseek" });
  assert.equal(rollout.checks.codexAppReadContent, false);
});

test("[A HAR-04 TOOL-04] read_thread 只在官方直连与 Relay 结果一致且桌面封装清空时标记上游阻断", () => {
  const content = fixtureRollout("gpt-6-astra")
    .replace(
      JSON.stringify(functionOutput("codex-read", readThreadOutput(marker))),
      JSON.stringify(functionOutput("codex-read", readThreadOutput(marker, { turns: [
        { id: "turn-large-1", status: "completed", items: [] },
        { id: "turn-large-2", status: "completed", items: [] },
      ] }))),
    );
  const rollout = parseDesktopRollout(content, { marker, profile: "official" });
  const attribution = {
    status: "blocked-upstream",
    layer: "official-codex-desktop-read-thread-wrapper",
    reason: "官方桌面 read_thread 封装将大回合 items 清空",
    verifiedFor: { marker, runtimeTarget: "windows-native", desktopBuild: "fixture-build",
      cliVersion: "fixture-cli", readingChainUnchanged: true },
    controls: {
      officialNoRelay: { completedItemCounts: [79, 140] },
      productionRelay: { completedItemCounts: [79, 140] },
      desktopReadThread: { completedItemCounts: [0, 0] },
    },
  };
  const shared = {
    profile: "official",
    marker,
    runtimeBinding: { status: "passed", expected: { runtimeTarget: "windows-native" } },
    rollout,
    toolInventory: { offers: { webRun: true } },
    httpEvidence: { submissions: [{ value: marker }], artifactRequests: 1 },
  };
  const blocked = evaluateDesktopHostEvidence({
    ...shared,
    upstreamAttributions: { "codex-app-read-thread": attribution },
  });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.checks.find((item) => item.id === "codex-app-read-thread").status,
    "blocked-upstream");
  assert.match(blocked.upstreamReason, /read_thread/);

  for (const verification of [undefined,
    { ...attribution.verifiedFor, marker: "OLD_RUN" },
    { ...attribution.verifiedFor, runtimeTarget: "macos-native" },
    { ...attribution.verifiedFor, readingChainUnchanged: false },
  ]) {
    const result = evaluateDesktopHostEvidence({ ...shared,
      upstreamAttributions: { "codex-app-read-thread": { ...attribution, verifiedFor: verification } },
    });
    assert.equal(result.status, "failed", "旧报告或未核对的读取链不能自动归因给上游");
  }

  const mismatchedControl = structuredClone(attribution);
  mismatchedControl.controls.productionRelay.completedItemCounts = [0, 0];
  const failed = evaluateDesktopHostEvidence({
    ...shared,
    upstreamAttributions: { "codex-app-read-thread": mismatchedControl },
  });
  assert.equal(failed.status, "failed");
  for (const turns of [
    [{ id: "missing-items", status: "completed" }],
    [{ id: "missing-input", status: "completed", items: [
      { type: "agentMessage", text: "reply" },
    ] }],
  ]) {
    const otherFailure = rolloutWithReadTurns(turns);
    const result = evaluateDesktopHostEvidence({
      ...shared, profile: "deepseek", rollout: otherFailure,
      upstreamAttributions: { "codex-app-read-thread": attribution },
    });
    assert.equal(result.checks.find((item) => item.id === "codex-app-read-thread").status, "failed");
    assert.equal(result.upstreamReason, null);
  }
});

test("[A HAR-04 NET-05] 目标模型用量失败必须保留官方错误并判定失败", () => {
  const content = fixtureRollout("gpt-6-astra").replace(
    '"type":"task_complete"',
    '"type":"task_complete","error":{"message":"usage exhausted","codex_error_info":"usage_limit_exceeded"}',
  );
  const rollout = parseDesktopRollout(content, { marker, profile: "official" });
  assert.deepEqual(rollout.taskError, {
    code: "usage_limit_exceeded",
    message: "usage exhausted",
  });
  const result = evaluateDesktopHostEvidence({
    profile: "official",
    marker,
    runtimeBinding: { status: "passed" },
    rollout,
    httpEvidence: { submissions: [{ value: marker }], artifactRequests: 1 },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.checks.find((item) => item.id === "model-turn").status, "not-run");
});

test("[A HAR-04 OBS-04] 请求工具清单只保留脱敏标识并能确认 web 能力是否下发", () => {
  const content = [
    { type: "request-tool-inventory", threadId: "other", model: "deepseek-flash", recordedAt: 2000,
      tools: [{ type: "custom", name: "web.run" }] },
    { type: "request-tool-inventory", threadId: "thread-desktop", model: "deepseek-flash", recordedAt: 2001,
      tools: [{ type: "function", name: "exec" }, { type: "mcp", serverLabel: "codex_app" }] },
    { type: "request-tool-inventory", threadId: "thread-desktop", model: "deepseek-flash", recordedAt: 2002,
      tools: [{ type: "custom", name: "web.run" }, { type: "function", name: "exec" }] },
  ].map(JSON.stringify).join("\n");
  const inventory = parseRequestToolInventory(content, {
    threadId: "thread-desktop",
    model: "deepseek-flash",
    startedAt: 2000,
  });
  assert.equal(inventory.eventCount, 2);
  assert.equal(inventory.offers.webRun, true);
  assert.equal(inventory.offers.hostedWebSearch, false);
  assert.deepEqual(inventory.tools, [
    { type: "function", name: "exec", namespace: null, serverLabel: null },
    { type: "mcp", name: null, namespace: null, serverLabel: "codex_app" },
    { type: "custom", name: "web.run", namespace: null, serverLabel: null },
  ]);
  assert.doesNotMatch(JSON.stringify(inventory), /secret|schema|arguments/i);
});

test("[A HAR-04 TOOL-05] DeepSeek 的 Hosted web_search 描述不能冒充可调用的 web.run", () => {
  const inventory = parseRequestToolInventory(JSON.stringify({
    type: "request-tool-inventory",
    threadId: "thread-desktop",
    model: "deepseek-flash",
    recordedAt: 2001,
    tools: [{ type: "web_search" }],
  }), {
    threadId: "thread-desktop",
    model: "deepseek-flash",
    startedAt: 2000,
  });
  assert.deepEqual(inventory.offers, { webRun: false, hostedWebSearch: true });

  const rollout = parseDesktopRollout(fixtureRollout("deepseek-flash").split("\n")
    .filter((line) => !line.includes('"call_id":"web-'))
    .join("\n"), { marker, profile: "deepseek" });
  const result = evaluateDesktopHostEvidence({
    profile: "deepseek",
    marker,
    runtimeBinding: { status: "passed" },
    rollout,
    toolInventory: inventory,
    httpEvidence: { submissions: [{ value: marker }], artifactRequests: 1 },
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.checks.find((item) => item.id === "web-search").status, "unsupported");
});

test("[A HAR-04 TOOL-05] 仿冒 URL 不能作为 OpenAI 官方 web.run 结果", () => {
  const content = fixtureRollout("gpt-6-astra")
    .replaceAll("https://github.com/openai/codex", "https://example.test/?next=openai.com/openai/codex");
  const rollout = parseDesktopRollout(content, { marker, profile: "official" });
  assert.equal(rollout.checks.webFind, true);
  assert.equal(rollout.checks.webResult, false);
});

test("[A HAR-04 OBS-03] 桌面引导页展示实时步骤但不参与判定", () => {
  const prompt = desktopHostPrompt({
    profile: "official",
    marker,
    fixtureUrl: "http://127.0.0.1:54321/",
    runId: "20260913010101-deadbeef",
    root: "/tmp/project",
  });
  assert.match(prompt, /Codex 官方模型/);
  assert.match(prompt, new RegExp(`EXEC_${marker}`));
  assert.match(prompt, new RegExp(`FAIL_${marker}`));
  assert.match(prompt, /退出码 23/);
  assert.match(prompt, /codex_app/);
  assert.match(prompt, /list_threads/);
  assert.match(prompt, /read_thread/);
  assert.match(prompt, /includeOutputs: true/);
  assert.match(prompt, /maxOutputCharsPerItem: 20000/);
  assert.match(prompt, /codex_delegation/);
  assert.match(prompt, /list_projects/);
  assert.match(prompt, /get_usage_limits/);
  assert.match(prompt, /web\.run/);
  assert.match(prompt, /computer use/);
  assert.doesNotMatch(prompt, /request_user_input|用户补充输入/);
  const html = desktopHostProgressHtml({
    batch: "B1-official",
    status: "incomplete",
    platform: "win32",
    arch: "x64",
    runtimeTarget: "windows-native",
    projectVersion: "1.2.3",
    sourceSnapshot: { sha256: "abc" },
    prompt: `${prompt}<unsafe>`,
    evaluation: { checks: [{ label: "model", status: "not-run" }] },
  });
  assert.match(html, /http-equiv="refresh"/);
  assert.match(html, /B1-official/);
  assert.doesNotMatch(html, /<unsafe>/);
  assert.match(html, /&lt;unsafe&gt;/);

  const windowsPrompt = desktopHostPrompt({
    profile: "official",
    marker,
    nativeExecutablePath: String.raw`D:\\fixture\\computer-use.exe`,
    runId: "20260913010101-native",
    root: String.raw`D:\\project`,
  });
  assert.match(windowsPrompt, /Windows 原生应用/);
  assert.match(windowsPrompt, /Marker input/);
  assert.doesNotMatch(windowsPrompt, /点击下载测试产物/);
  assert.doesNotMatch(windowsPrompt, /request_user_input|用户补充输入/);
});

test("[A HAR-04 ENV-03] 自动发现只读取本次标记所在的近期 rollout", async t => {
  const codexHome = await useTempDir(t, "desktop-rollout-");
  const directory = join(codexHome, "sessions", "2026", "09", "13");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "rollout-fixture.jsonl"), fixtureRollout("gpt-6-astra"));
  await writeFile(join(directory, "rollout-other.jsonl"), fixtureRollout("deepseek-flash", "BHOST_ffffffffffffffff"));
  const rollout = await findDesktopRolloutEvidence({
    marker,
    profile: "official",
    customModels: ["deepseek-flash"],
    startedAt: Date.now() - 1_000,
    codexHome,
  });
  assert.equal(rollout.model, "gpt-6-astra");
  assert.equal(rollout.modelMatches, true);
});

test("[A HAR-04 MOD-03] 自动发现忽略控制任务里同标记的错误供应商 rollout", async t => {
  const codexHome = await useTempDir(t, "desktop-rollout-profile-");
  const directory = join(codexHome, "sessions", "2026", "09", "13");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "rollout-controller.jsonl"), fixtureRollout("gpt-5.6-sol"));

  const beforeTarget = await findDesktopRolloutEvidence({
    marker,
    profile: "deepseek",
    customModels: ["deepseek-flash"],
    startedAt: Date.now() - 1_000,
    codexHome,
  });
  assert.equal(beforeTarget, null);

  await writeFile(join(directory, "rollout-target.jsonl"), fixtureRollout("deepseek-flash"));
  const target = await findDesktopRolloutEvidence({
    marker,
    profile: "deepseek",
    customModels: ["deepseek-flash"],
    startedAt: Date.now() - 1_000,
    codexHome,
  });
  assert.equal(target.model, "deepseek-flash");
  assert.equal(target.modelMatches, true);
});

test("[A HAR-04 TOOL-05 TOOL-06] 目标模型任务结束但宿主工具缺失时标记 blocked 并停止监视", () => {
  const content = fixtureRollout("deepseek-flash").split("\n")
    .filter((line) => !line.includes('"call_id":"web-'))
    .join("\n");
  const rollout = parseDesktopRollout(content, { marker, profile: "deepseek" });
  const result = evaluateDesktopHostEvidence({
    profile: "deepseek",
    marker,
    runtimeBinding: { status: "passed" },
    rollout,
    toolInventory: { offers: { webRun: false } },
    httpEvidence: { submissions: [{ value: marker }], artifactRequests: 1 },
  });
  assert.equal(rollout.turnCompleted, true);
  assert.equal(result.status, "blocked");
  assert.match(result.blockedReason, /web\.run/);
  assert.equal(result.checks.find((item) => item.id === "web-search").status, "unsupported");
  assert.equal(isDesktopSessionTerminal("blocked"), true);
  assert.equal(isDesktopSessionTerminal("incomplete"), false);
});

test("桌面证据只绑定标记所在回合，后续成功回合不能掩盖中断或改变模型", () => {
  const first = fixtureRollout("deepseek-flash").replace(
    '"type":"task_complete"', '"type":"turn_aborted"',
  );
  const later = fixtureRollout("gpt-5.5", "LATER_MARKER")
    .split("\n").filter((line) => !line.includes('"type":"session_meta"')).join("\n")
    .replaceAll("turn-desktop", "turn-later");
  const result = parseDesktopRollout(first + later, { marker, profile: "deepseek" });
  assert.equal(result.model, "deepseek-flash");
  assert.equal(result.turnId, "turn-desktop");
  assert.equal(result.turnCompleted, false);
  assert.equal(result.modelMatches, true);
  assert.deepEqual(result.callIds.webRun, ["web-1", "web-2", "web-3"]);
});

function fixtureRollout(model, testMarker = marker) {
  const records = [
    { type: "session_meta", payload: {
      id: "thread-desktop", session_id: "thread-desktop", model_provider: "openai",
      cli_version: "0.154.0", cwd: "/tmp/project",
    } },
    { type: "turn_context", payload: { turn_id: "turn-desktop", model } },
    { type: "response_item", payload: {
      type: "message", role: "user", content: [{ type: "input_text", text: `运行 ${testMarker}` }],
    } },
    tool("exec-1", "exec", `node -e process.stdout.write('EXEC_${testMarker}')`),
    output("exec-1", `EXEC_${testMarker}`),
    tool("exec-2", "exec", `node -e \"process.stderr.write('FAIL_${testMarker}');process.exit(23)\"`),
    output("exec-2", `Process exited with code 23\nFAIL_${testMarker}`),
    functionTool("codex-list", "list_threads", '{"limit":10}', "mcp__codex_app"),
    functionOutput("codex-list", "current task thread-desktop"),
    functionTool("codex-read", "read_thread", '{"threadId":"thread-desktop"}', "mcp__codex_app"),
    functionOutput("codex-read", readThreadOutput(testMarker)),
    functionTool("codex-projects", "list_projects", "{}", "mcp__codex_app"),
    functionOutput("codex-projects", "projects: []"),
    functionTool("codex-usage", "get_usage_limits", "{}", "mcp__codex_app"),
    functionOutput("codex-usage", "rateLimits: available"),
    tool("web-1", "exec", "await tools.web__run({search_query:[{q:'Codex app-server'}]})"),
    output("web-1", "https://github.com/openai/codex docs"),
    tool("web-2", "exec", "await tools.web__run({open:[{ref_id:'result'}]})"),
    output("web-2", "OpenAI Codex app-server"),
    tool("web-3", "exec", "await tools.web__run({find:[{ref_id:'page',pattern:'thread/fork'}]})"),
    output("web-3", "thread/fork https://github.com/openai/codex/tree/main/codex-rs/app-server"),
    functionTool("cua-1", "js", "let tab=await cua.createBrowserTab('iab','http://127.0.0.1'); await sky.type_text({window,text:marker}); await sky.press_key({window,key:'Return'}); await tab.screenshot();"),
    functionOutput("cua-1", "SECRET_RESULT_BODY"),
    { type: "response_item", payload: {
      type: "message", role: "assistant", content: [{ type: "output_text", text: "验收结束" }],
    } },
    { type: "event_msg", payload: { type: "task_complete" } },
  ];
  return records.map(JSON.stringify).join("\n") + "\n";
}

function delegatedReadInput() {
  return {
    type: "functionCallOutput", name: "send_message_to_thread", namespace: "codex_app",
    output: {
      text: "<codex_delegation>\n<source_thread_id>source-task</source_thread_id>\n<input>delegated request</input>\n</codex_delegation>",
      truncated: false,
    },
  };
}

function rolloutWithReadTurns(turns) {
  const content = fixtureRollout("deepseek-flash").replace(
    JSON.stringify(functionOutput("codex-read", readThreadOutput(marker))),
    JSON.stringify(functionOutput("codex-read", readThreadOutput(marker, { turns }))),
  );
  return parseDesktopRollout(content, { marker, profile: "deepseek" });
}

function readThreadOutput(value, { items = null, turns = null } = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    thread: { id: "thread-desktop" },
    turns: turns ?? [{
      id: "turn-read",
      status: "completed",
      items: items ?? [
        { type: "userMessage", content: [{ type: "text", text: value }] },
        { type: "agentMessage", text: "reply" },
      ],
    }],
  });
}

function tool(id, name, input) {
  return { type: "response_item", payload: { type: "custom_tool_call", call_id: id, name, input } };
}

function output(id, value) {
  return { type: "response_item", payload: { type: "custom_tool_call_output", call_id: id, output: value } };
}

function functionTool(id, name, argumentsValue, namespace) {
  return { type: "response_item", payload: {
    type: "function_call", call_id: id, name, namespace, arguments: argumentsValue,
  } };
}

function functionOutput(id, value) {
  return { type: "response_item", payload: { type: "function_call_output", call_id: id, output: value } };
}
