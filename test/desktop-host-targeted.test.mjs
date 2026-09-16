import assert from "node:assert/strict";
import test from "node:test";
import { parseDesktopRollout, evaluateDesktopHostEvidence } from "../scripts/desktop-host-evidence.mjs";

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
