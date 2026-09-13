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
import { readDesktopWidgetState } from "../scripts/test-desktop-host.mjs";
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

test("[A HAR-04 TOOL-04 TOOL-05 TOOL-06 INT-02] 桌面报告从真实任务记录和独立 HTTP 证据判定供应商及工具链", () => {
  const rollout = parseDesktopRollout(fixtureRollout("deepseek-v4-flash"), {
    marker,
    profile: "deepseek",
    customModels: ["deepseek-v4-flash", "custom-model"],
    path: "/fixture/rollout.jsonl",
  });
  assert.equal(rollout.threadId, "thread-desktop");
  assert.equal(rollout.model, "deepseek-v4-flash");
  assert.equal(rollout.modelMatches, true);
  assert.deepEqual(rollout.checks, {
    functionsExec: true,
    functionsExecFailure: true,
    codexAppListThreads: true,
    codexAppReadThread: true,
    codexAppReadMarker: true,
    codexAppListProjects: true,
    codexAppGetUsageLimits: true,
    webSearch: true,
    webOpen: true,
    webFind: true,
    webResult: true,
    computerUse: true,
    computerScreenshot: true,
    userInput: true,
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

test("[A HAR-04 MOD-03] B1/B2 桌面证据不能继承其他模型、旧源码或另一组件结果", () => {
  const deepseek = parseDesktopRollout(fixtureRollout("deepseek-v4-flash"), {
    marker,
    profile: "official",
    customModels: ["deepseek-v4-flash"],
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

test("[A HAR-04 TOOL-04] 常用只读入口返回工具错误时不得通过桌面验收", () => {
  const content = fixtureRollout("gpt-6-astra")
    .replace('"output":"rateLimits: available"',
      '"output":"{\\"isError\\":true,\\"message\\":\\"tool call failed\\"}"');
  const rollout = parseDesktopRollout(content, { marker, profile: "official" });
  assert.equal(rollout.checks.codexAppListProjects, true);
  assert.equal(rollout.checks.codexAppGetUsageLimits, false);
});

test("[A HAR-04 TOOL-06] 当前 computer use 的 getScreenshot 调用会计入真实截图证据", () => {
  const content = fixtureRollout("gpt-6-astra").replace("await tab.screenshot();", "await tab.getScreenshot();");
  const rollout = parseDesktopRollout(content, { marker, profile: "official" });
  assert.equal(rollout.checks.computerScreenshot, true);
});

test("[A HAR-04 INT-02] 用户输入工具失败不能通过，直接补充输入并续接可以通过", () => {
  const failedTool = fixtureRollout("gpt-6-astra")
    .replace('"output":"继续"', '"output":"request_user_input is unavailable in Default mode"');
  const failed = parseDesktopRollout(failedTool, { marker, profile: "official" });
  assert.equal(failed.checks.userInput, false);
  assert.equal(failed.userInputMode, null);

  const records = failedTool.trim().split("\n").map(JSON.parse);
  records.push({ type: "response_item", payload: {
    type: "message", role: "user", content: [{ type: "input_text", text: "继续验收" }],
  } });
  records.push({ type: "response_item", payload: {
    type: "message", role: "assistant", content: [{ type: "output_text", text: "继续执行" }],
  } });
  const continued = parseDesktopRollout(records.map(JSON.stringify).join("\n"), {
    marker,
    profile: "official",
  });
  assert.equal(continued.checks.userInput, true);
  assert.equal(continued.userInputMode, "direct-follow-up");
});

test("[A HAR-04 INT-02] Codex 跨任务委托记录可作为真实补充输入且必须在随后续接", () => {
  const content = fixtureRollout("deepseek-v4-flash")
    .replace('"output":"继续"', '"output":"request_user_input is unavailable in Default mode"');
  const records = content.trim().split("\n").map(JSON.parse);
  records.push({ type: "response_item", payload: {
    type: "function_call_output",
    id: "fco_delegation",
    name: "send_message_to_thread",
    namespace: "codex_app",
    output: [
      "<codex_delegation>",
      "  <source_thread_id>thread-source</source_thread_id>",
      "  <input>继续本次桌面验收</input>",
      "</codex_delegation>",
    ].join("\n"),
  } });
  const withoutContinuation = parseDesktopRollout(records.map(JSON.stringify).join("\n"), {
    marker,
    profile: "deepseek",
  });
  assert.equal(withoutContinuation.checks.userInput, false);

  records.push({ type: "response_item", payload: {
    type: "message", role: "assistant", content: [{ type: "output_text", text: "已继续" }],
  } });
  const continued = parseDesktopRollout(records.map(JSON.stringify).join("\n"), {
    marker,
    profile: "deepseek",
  });
  assert.equal(continued.checks.userInput, true);
  assert.equal(continued.userInputMode, "direct-follow-up");
});

test("[A HAR-04 TOOL-04] 跨任务委托只放宽 read_thread 活动输入回显，直接模式仍要求标记", () => {
  const content = fixtureRollout("deepseek-v4-flash")
    .replace(`current task contains ${marker}`, "items: []");
  const rollout = parseDesktopRollout(content, { marker, profile: "deepseek" });
  assert.equal(rollout.checks.codexAppReadThread, true);
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
  assert.equal(evaluateDesktopHostEvidence({ ...shared, triggerMode: "delegated" }).status, "passed");
});

test("[A HAR-04 OBS-04] 请求工具清单只保留脱敏标识并能确认 web 能力是否下发", () => {
  const content = [
    { type: "request-tool-inventory", threadId: "other", model: "deepseek-v4-flash", recordedAt: 2000,
      tools: [{ type: "custom", name: "web.run" }] },
    { type: "request-tool-inventory", threadId: "thread-desktop", model: "deepseek-v4-flash", recordedAt: 2001,
      tools: [{ type: "function", name: "exec" }, { type: "mcp", serverLabel: "codex_app" }] },
    { type: "request-tool-inventory", threadId: "thread-desktop", model: "deepseek-v4-flash", recordedAt: 2002,
      tools: [{ type: "custom", name: "web.run" }, { type: "function", name: "exec" }] },
  ].map(JSON.stringify).join("\n");
  const inventory = parseRequestToolInventory(content, {
    threadId: "thread-desktop",
    model: "deepseek-v4-flash",
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
    model: "deepseek-v4-flash",
    recordedAt: 2001,
    tools: [{ type: "web_search" }],
  }), {
    threadId: "thread-desktop",
    model: "deepseek-v4-flash",
    startedAt: 2000,
  });
  assert.deepEqual(inventory.offers, { webRun: false, hostedWebSearch: true });

  const rollout = parseDesktopRollout(fixtureRollout("deepseek-v4-flash").split("\n")
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
  assert.match(prompt, /list_projects/);
  assert.match(prompt, /get_usage_limits/);
  assert.match(prompt, /web\.run/);
  assert.match(prompt, /computer use/);
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
});

test("[A HAR-04 ENV-03] 自动发现只读取本次标记所在的近期 rollout", async t => {
  const codexHome = await useTempDir(t, "desktop-rollout-");
  const directory = join(codexHome, "sessions", "2026", "09", "13");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "rollout-fixture.jsonl"), fixtureRollout("gpt-6-astra"));
  await writeFile(join(directory, "rollout-other.jsonl"), fixtureRollout("deepseek-v4-flash", "BHOST_ffffffffffffffff"));
  const rollout = await findDesktopRolloutEvidence({
    marker,
    profile: "official",
    customModels: ["deepseek-v4-flash"],
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
    customModels: ["deepseek-v4-flash"],
    startedAt: Date.now() - 1_000,
    codexHome,
  });
  assert.equal(beforeTarget, null);

  await writeFile(join(directory, "rollout-target.jsonl"), fixtureRollout("deepseek-v4-flash"));
  const target = await findDesktopRolloutEvidence({
    marker,
    profile: "deepseek",
    customModels: ["deepseek-v4-flash"],
    startedAt: Date.now() - 1_000,
    codexHome,
  });
  assert.equal(target.model, "deepseek-v4-flash");
  assert.equal(target.modelMatches, true);
});

test("[A HAR-04 TOOL-05 TOOL-06] 目标模型任务结束但宿主工具缺失时标记 blocked 并停止监视", () => {
  const content = fixtureRollout("deepseek-v4-flash").split("\n")
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
    functionOutput("codex-read", `current task contains ${testMarker}`),
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
    functionTool("cua-1", "js", "let tab=await cua.createBrowserTab('iab','http://127.0.0.1'); await tab.screenshot();"),
    functionOutput("cua-1", "SECRET_RESULT_BODY"),
    functionTool("input-1", "request_user_input_async", "是否继续"),
    functionOutput("input-1", "继续"),
    { type: "response_item", payload: {
      type: "message", role: "assistant", content: [{ type: "output_text", text: "验收结束" }],
    } },
    { type: "event_msg", payload: { type: "task_complete" } },
  ];
  return records.map(JSON.stringify).join("\n") + "\n";
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
