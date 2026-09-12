import assert from "node:assert/strict";
import test from "node:test";
import { startChatCompatibilityProxy } from "../src/chat-compat-proxy.mjs";
import { ResponsesHistory } from "../src/responses-history.mjs";
import { json, readJsonRequest, startHttpServer } from "./helpers.mjs";

async function fixture(t, handler) {
  const seen = [];
  const { origin } = await startHttpServer(t, async (request, response) => {
    const body = await readJsonRequest(request); seen.push(body); handler(body, response);
  });
  const platform = { id: "test", enabled: true, baseUrl: `${origin}/v1/`, models: [{ id: "chat", chatCompatibility: true }] };
  const proxy = await startChatCompatibilityProxy(new Map([[platform.id, platform]]));
  t.after(() => proxy.close());
  return { seen, post: body => fetch(new URL("responses", proxy.baseUrlFor(platform)), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "chat", ...body }),
  }) };
}
const declaration = { type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec", description: "Run raw JavaScript" }] };

test("[A TOOL-04 NET-04] Responses Lite 命名空间和原始文本工具声明、结果、续接保持可执行格式", async t => {
  const rawInput = 'text("中文\\nwith escapes");';
  const f = await fixture(t, (body, response) => {
    if (body.messages.some(m => m.role === "tool")) return json(response, { id: "last", choices: [{ message: { content: "continued" }, finish_reason: "stop" }] });
    assert.equal(body.tools.length, 1);
    assert.match(body.tools[0].function.name, /^[a-zA-Z0-9_-]{1,64}$/);
    assert.equal(body.tools[0].function.parameters.properties.input.type, "string");
    assert.deepEqual(body.tool_choice, { type: "function", function: { name: body.tools[0].function.name } });
    json(response, { id: "first", choices: [{ message: { tool_calls: [{ id: "call-fixture", type: "function", function: {
      name: body.tools[0].function.name, arguments: JSON.stringify({ input: rawInput }),
    } }] }, finish_reason: "tool_calls" }] });
  });
  const first = await (await f.post({ tool_choice: { type: "custom", name: "exec", namespace: "functions" }, input: [{ type: "additional_tools", tools: [declaration] }, { role: "user", content: "run fixture" }] })).json();
  assert.equal(first.output[0].type, "custom_tool_call");
  assert.equal(first.output[0].name, "exec");
  assert.equal(first.output[0].namespace, "functions");
  assert.equal(first.output[0].input, rawInput);
  const next = await f.post({ previous_response_id: first.id, input: [{ type: "custom_tool_call_output", call_id: "call-fixture", output: "INDEPENDENT_RESULT" }] });
  assert.equal(next.status, 200);
  assert.equal((await next.json()).output[0].content[0].text, "continued");
  assert.equal(f.seen[1].messages.filter(m => m.role === "tool").length, 1);
  assert.equal(JSON.parse(f.seen[1].messages.find(m => m.tool_calls).tool_calls[0].function.arguments).input, rawInput);
  const invalid = await f.post({ previous_response_id: first.id, input: [{ type: "custom_tool_call_output", call_id: "different", output: "must not forward" }] });
  assert.equal(invalid.status, 502);
  assert.equal(f.seen.length, 2);
});

test("[A TOOL-04 NET-02 NET-05] 分片的原始文本工具参数还原一次；无效包装不能产生成功终态", async t => {
  let invalid = false;
  const f = await fixture(t, (body, response) => {
    const input = invalid ? '{"wrong":true}' : JSON.stringify({ input: "line 1\n第二行\"引用\"" });
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const [index, part] of [input.slice(0, 8), input.slice(8)].entries()) {
      response.write(`data: ${JSON.stringify({ id: "stream", choices: [{ delta: { tool_calls: [{ index: 0,
        ...(index === 0 ? { id: "raw-call" } : {}), function: { ...(index === 0 ? { name: body.tools[0].function.name } : {}), arguments: part } }] } }] })}\n\n`);
    }
    response.end('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
  });
  const post = async () => (await (await f.post({ stream: true, tools: [declaration], input: "fixture" })).text())
    .split("\n").filter(l => l.startsWith("data:")).map(l => JSON.parse(l.slice(5)));
  const events = await post();
  const completed = events.filter(e => e.type === "response.completed");
  assert.equal(completed.length, 1);
  assert.equal(completed[0].response.output[0].input, "line 1\n第二行\"引用\"");
  invalid = true;
  const failed = await post();
  assert.equal(failed.filter(e => e.type === "response.failed").length, 1);
  assert.equal(failed.filter(e => e.type === "response.completed").length, 0);
});

test("[A MOD-04 TOOL-04] Chat 不支持的原生工具能力明确拒绝，不静默删除工具后发送模型请求", async t => {
  const f = await fixture(t, () => assert.fail("不应访问模型"));
  const response = await f.post({ tools: [{ type: "web_search" }], input: "fixture" });
  assert.equal(response.status, 502);
  assert.match(await response.text(), /不支持工具类型 web_search/);
  assert.equal(f.seen.length, 0);
});

test("[A NET-03 TOOL-04 MOD-03] 本地预热的目录和历史保留到增量请求，响应 ID 不能跨路由引用", () => {
  const history = new ResponsesHistory();
  const declarationItem = { id: "tools", type: "additional_tools", tools: [declaration] };
  const prewarm = { model: "custom", instructions: "original", generate: false, input: [declarationItem] };
  history.remember(prewarm, { id: "prewarm", status: "completed", output: [] }, "provider-a");
  const first = history.expand({ model: "custom", previous_response_id: "prewarm", input: [{ id: "user", role: "user", content: "first" }] }, "provider-a");
  assert.equal(first.instructions, "original");
  assert.deepEqual(first.input[0], declarationItem);
  assert.equal(Object.hasOwn(first, "previous_response_id"), false);
  assert.equal(Object.hasOwn(first, "generate"), false);
  const toolCall = { id: "call-item", type: "custom_tool_call", call_id: "call", name: "exec", input: "code" };
  history.remember(first, { id: "response", status: "completed", output: [toolCall] }, "provider-a");
  const next = history.expand({ previous_response_id: "response", input: [toolCall, { id: "out", type: "custom_tool_call_output", call_id: "call", output: "result" }] }, "provider-a");
  assert.equal(next.input.filter(i => i.id === "call-item").length, 1);
  assert.equal(next.input.at(-1).output, "result");
  assert.throws(() => history.expand({ previous_response_id: "response" }, "provider-b"), /无法恢复/);
  assert.throws(() => new ResponsesHistory().expand({ previous_response_id: "response" }, "provider-a"), /无法恢复/);
});

test("[A OBS-03 NET-05] 有界历史淘汰后拒绝残缺续接；完整请求仍可用，失败响应不进入成功历史", () => {
  const history = new ResponsesHistory({ maxEntries: 1, maxBytes: 1024 });
  history.remember({ input: "first" }, { id: "old", status: "completed", output: [] }, "route");
  history.remember({ input: "second" }, { id: "new", status: "completed", output: [] }, "route");
  assert.throws(() => history.expand({ previous_response_id: "old" }, "route"), /完整历史/);
  assert.deepEqual(history.expand({ input: "complete new request" }, "route"), { input: "complete new request" });
  history.remember({ input: "x" }, { id: "failed", status: "failed", output: [] }, "route");
  assert.throws(() => history.expand({ previous_response_id: "failed" }, "route"), /无法恢复/);
  assert.equal(history.records.size, 1);
  history.remember({ input: "x".repeat(2048) }, { id: "oversized", status: "completed", output: [] }, "route");
  assert.ok(history.bytes <= 1024);
  assert.throws(() => history.expand({ previous_response_id: "oversized" }, "route"), /无法恢复/);
});
