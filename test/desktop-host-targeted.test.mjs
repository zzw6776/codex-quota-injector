import assert from "node:assert/strict";
import test from "node:test";
import { desktopHostPrompt, parseDesktopRollout, evaluateDesktopHostEvidence } from "../scripts/desktop-host-evidence.mjs";

const marker = "BHOST_targeted_regression";
const officialPage = "https://developers.openai.com/codex/app-server";
const hit = `${officialPage}\nL976: Call thread/fork to branch history into a new thread id.`;
const miss = `${officialPage}\nSource: find({pattern: "thread/fork"})\nNo matching text found for "thread/fork"`;

function call(id, input, result, name = "exec", namespace) {
  return [
    { type: "response_item", payload: { type: "function_call", call_id: id, name, namespace, arguments: input } },
    { type: "response_item", payload: { type: "function_call_output", call_id: id, output: result } },
  ];
}

function parse(records, later = []) {
  return parseDesktopRollout([
    { type: "session_meta", payload: { id: "targeted-thread" } },
    { type: "turn_context", payload: { model: "gpt-5.6-luna", turn_id: "targeted-turn" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ text: marker }] } },
    ...records,
    { type: "event_msg", payload: { type: "task_complete" } },
    ...later,
  ].map(JSON.stringify).join("\n"), { marker, profile: "official" });
}

function evaluate(rollout, submissions = [{ value: marker }]) {
  return evaluateDesktopHostEvidence({
    profile: "official", marker, rollout, runtimeBinding: { status: "passed" },
    httpEvidence: { submissions, invalidSubmissions: 0 },
  }).checks;
}

test("网页证据：同回合后续 open/click 与 find 成功可通过，失败和跨回合拼接不可通过", () => {
  const search = call("search", "await tools.web__run({search_query:[{q:'Codex app-server'}]})", officialPage);
  const first = [
    ...search,
    ...call("home", "await tools.web__run({open:[{ref_id:'search'}]})", "https://developers.openai.com/"),
    ...call("miss", "await tools.web__run({find:[{ref_id:'home',pattern:'thread/fork'}]})", miss),
  ];
  for (const navigation of ["open", "click"]) {
    const retry = [
      ...call("document", `await tools.web__run({${navigation}:[{ref_id:'home',id:338}]})`, officialPage),
      ...call("hit", "await tools.web__run({find:[{ref_id:'document',pattern:'thread/fork'}]})",
        [{ type: "input_text", text: JSON.stringify(hit) }]),
    ];
    const result = parse([...first, ...retry]);
    assert.equal(evaluate(result).find(c => c.id === "web-find").status, "passed");
    assert.ok(result.callIds.webOpen.includes("document"));
    assert.equal(parse(first, retry).checks.webResult, false, "下一回合结果不得补入");
    assert.equal(parse([...first, ...retry.slice(0, -1)]).checks.webResult, false, "调用没有返回不能通过");
  }
  assert.equal(parse(first).checks.webResult, false, "find 参数回显不能当正文命中");
  const navigate = call("document", "await tools.web__run({open:[{ref_id:'search'}]})", officialPage);
  for (const invalid of ["", `Internal Error: ${hit}`, JSON.stringify({ isError: true, text: hit }),
    hit.replace(officialPage, "https://example.test/?next=openai.com/app-server"),
    "thread/fork on an unrelated page"]) {
    assert.equal(parse([...search, ...navigate,
      ...call("bad", "await tools.web__run({find:[{ref_id:'document',pattern:'thread/fork'}]})", invalid),
    ]).checks.webResult, false);
  }
  assert.equal(parse([...navigate,
    ...call("hit", "await tools.web__run({find:[{ref_id:'document',pattern:'thread/fork'}]})", hit),
  ]).checks.webResult, false, "缺少实际搜索不能通过完整网页链");
});

test("输入证据：真实 fill 返回和单次正确提交才通过，错误、重复或无调用不能通过", () => {
  const input = JSON.stringify({ code: `await tab.playwright.getByLabel('测试标记').fill('${marker}'); await tab.playwright.getByRole('button',{name:'发送'}).click();` });
  const records = call("fill", input, "已收到", "js", "mcp__cua_repl");
  const result = parse(records);
  assert.equal(result.checks.computerInput, true);
  const status = (rollout, submissions) => evaluate(rollout, submissions).find(c => c.id === "computer-use").status;
  assert.equal(status(result), "passed");
  for (const submissions of [[], [{ value: "wrong" }], [{ value: marker }, { value: marker }]]) {
    assert.notEqual(status(result, submissions), "passed");
  }
  for (const output of ["", "Script failed: locator not found", '{"isError":true}']) {
    assert.notEqual(status(parse(call("fill", input, output, "js", "mcp__cua_repl"))), "passed");
  }
  assert.notEqual(status(parse(call("fake", input, "已收到"))), "passed", "普通 exec 不能冒充 computer use");
});

test("Windows 原生测试引导使用专用 sky API，并在自动关闭前独立截图", () => {
  for (const profile of ["official", "deepseek"]) {
    const executable = String.raw`D:\fixture with spaces\computer-use.exe`;
    const prompt = desktopHostPrompt({ profile, marker, nativeExecutablePath: executable, runId: "native-api", root: "D:\\project" });
    assert.match(prompt, /node_repl 的 @oai\/sky/);
    assert.match(prompt, /sky\.target === "windows"/);
    assert.ok(prompt.includes(`sky.launch_app({app:${JSON.stringify(executable)}})`), "JS 示例必须保留 Windows 路径转义和空格");
    assert.match(prompt, /不要调用 cua_repl 的 cua\.getApp/);
    assert.match(prompt, /初始化失败或工具未开放时保留原始错误/);
    assert.ok(prompt.indexOf("提交前对该窗口调用一次真实截图") < prompt.indexOf("正确提交后应用会自动关闭"));
    assert.match(prompt, /截图失败仍单独留证，重新读取辅助功能树/);
  }
});

test("原生 API 缺失的真实返回不能当成功，也不能继承旧截图上游归因", () => {
  const rollout = parse(call("launch", JSON.stringify({code:"await cua.getApp('fixture.exe')"}),
    [{type:"input_text",text:"cua.getApp is not a function"}], "js", "mcp__cua_repl"));
  assert.equal(rollout.checks.computerUse, false);
  assert.equal(rollout.checks.computerScreenshot, false);
  assert.equal(rollout.computerUseFailure, "native-api-unavailable");
  const result = evaluateDesktopHostEvidence({profile:"official",marker,rollout,
    runtimeBinding:{status:"passed",expected:{runtimeTarget:"windows-native"}}, computerUseKind:"windows-native"});
  const interaction = result.checks.find(item => item.id === "computer-use");
  assert.equal(interaction.status, "failed");
  assert.match(interaction.reason, /运行时未提供的 API/);
  assert.equal(result.checks.find(item => item.id === "computer-screenshot").status, "not-executed");
  assert.equal(result.upstreamReason, null);
});

test("辅助功能读取及图片转发分支不能把失败截图误计为通过", () => {
  const wrapped = code => `const r=await tools.mcp__node_repl__js({code:${JSON.stringify(code)}});for(const c of r.content??[]){if(c.type==='image') image(c);else if(c.type==='text') text(c.text);}`;
  const accessibility = call("ax", wrapped("await sky.get_window_state({window,include_screenshot:false,include_text:true});"), "Marker input focused");
  const failed = call("capture", wrapped("await sky.get_window_state({window,include_screenshot:true,include_text:false});"), "SetIsBorderRequired failed: 不支持此接口 (0x80004002)");
  const result = parse([...accessibility, ...failed]);
  assert.deepEqual(result.callIds.computerScreenshot, ["capture"]);
  assert.equal(result.checks.computerScreenshot, false);
  assert.equal(parse(accessibility).checks.computerScreenshot, false);
  const successful = parse(call("capture", wrapped("await sky.get_window_state({window,include_screenshot:true});"), "Screenshot captured"));
  assert.equal(successful.checks.computerScreenshot, true);
  const defaultCapture = parse(call("default", wrapped("await sky.get_window_state({window});"), "Screenshot captured"));
  assert.equal(defaultCapture.checks.computerScreenshot, true);
});
