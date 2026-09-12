import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { setImmediate as nextTick } from "node:timers/promises";
import test from "node:test";

import { startChatCompatibilityProxy } from "../src/chat-compat-proxy.mjs";
import { json, readJsonRequest, startHttpServer, waitFor } from "./helpers.mjs";

const tool = (id, name, argumentsValue) => ({
  id, type: "function", function: { name, arguments: JSON.stringify(argumentsValue) },
});
const completed = (id, content = "done") => ({
  id, choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
});
const toolResponse = (id, calls) => ({
  id, choices: [{ message: { role: "assistant", content: null, tool_calls: calls }, finish_reason: "tool_calls" }],
});

async function startFixture(t, handler, ids = ["one"]) {
  const requests = [];
  const upstream = await startHttpServer(t, async (request, response) => {
    const body = await readJsonRequest(request);
    requests.push(body);
    await handler(body, response, request);
  });
  const platforms = ids.map((id) => ({
    id, enabled: true, baseUrl: `${upstream.origin}/v1/`, apiKey: "test-only",
    models: [{ id: "chat-model", chatCompatibility: true }, { id: "other-model", chatCompatibility: true }],
  }));
  const proxy = await startChatCompatibilityProxy(new Map(platforms.map((platform) => [platform.id, platform])));
  t.after(() => proxy.close());
  const url = (index = 0) => new URL("responses", proxy.baseUrlFor(platforms[index]));
  const post = (body, index = 0) => fetch(url(index), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "chat-model", stream: false, ...body }),
    signal: AbortSignal.timeout(5_000),
  });
  return { post, requests, url };
}

function events(raw) {
  return raw.trim().split(/\r?\n\r?\n/).filter(Boolean).map((block) => JSON.parse(
    block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n"),
  ));
}

const terminals = (values) => values.filter((value) =>
  ["response.completed", "response.incomplete", "response.failed"].includes(value.type));

test("TOOL-07 并行同名工具的乱序结果与部分失败按 call_id 续接，保留已有调用而不重复插入", async (t) => {
  const calls = [tool("call-a", "read", { path: "a" }), tool("call-b", "read", { path: "b" })];
  const fixture = await startFixture(t, (body, response) => {
    json(response, body.messages.some((message) => message.role === "tool")
      ? completed("continued") : toolResponse("parallel", calls));
  });
  const first = await (await fixture.post({ input: "read both" })).json();
  const second = await fixture.post({
    previous_response_id: first.id,
    input: [
      first.output[0],
      { type: "function_call_output", call_id: "call-b", output: { error: "file missing" } },
      { type: "function_call_output", call_id: "call-a", output: "contents of a" },
    ],
  });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).output[0].content[0].text, "done");
  const messages = fixture.requests[1].messages;
  assert.deepEqual(messages[0].tool_calls, calls);
  assert.deepEqual(messages.slice(1), [
    { role: "tool", tool_call_id: "call-b", content: '{"error":"file missing"}' },
    { role: "tool", tool_call_id: "call-a", content: "contents of a" },
  ]);
});

test("NET-04 自带完整工具历史时不依赖已过期的 previous_response_id 缓存", async (t) => {
  const fixture = await startFixture(t, (_body, response) => json(response, completed("full-history")));
  const response = await fixture.post({
    previous_response_id: "resp_evicted",
    input: [
      { type: "function_call", call_id: "call-explicit", name: "read", arguments: '{"path":"a"}' },
      { type: "function_call_output", call_id: "call-explicit", output: "verified contents" },
    ],
  });
  assert.equal(response.status, 200);
  await response.json();
  assert.deepEqual(fixture.requests[0].messages[0].tool_calls, [tool("call-explicit", "read", { path: "a" })]);
  assert.equal(fixture.requests[0].messages[1].content, "verified contents");
});

test("NET-04 缺少对应调用或结果 ID 不匹配时拒绝孤立工具输出，正常结果仍能续接", async (t) => {
  const fixture = await startFixture(t, (body, response) => json(response,
    body.messages.some((message) => message.role === "tool") ? completed("second")
      : toolResponse("known", [tool("call-known", "read", { path: "a" })])));
  const first = await (await fixture.post({ input: "read" })).json();
  for (const previous of [{ previous_response_id: first.id }, {}]) {
    const bad = await fixture.post({ ...previous,
      input: [{ type: "function_call_output", call_id: "call-other-task", output: "must not be forwarded" }] });
    assert.equal(bad.status, 502);
    assert.match((await bad.json()).error.message, /call-other-task/);
    assert.equal(fixture.requests.length, 1);
  }
  const good = await fixture.post({ previous_response_id: first.id,
    input: [{ type: "function_call_output", call_id: "call-known", output: "ok" }] });
  assert.equal(good.status, 200);
  await good.json();
  assert.equal(fixture.requests.length, 2);
});

test("MOD-03 不同平台返回相同 response_id 时，工具历史保持隔离且同平台切换模型仍可续接", async (t) => {
  const fixture = await startFixture(t, (body, response) => {
    if (body.messages.some((message) => message.role === "tool")) return json(response, completed("continued"));
    const path = body.messages[0].content;
    json(response, toolResponse("same-upstream-id", [tool("same-call-id", "read", { path })]));
  }, ["one", "two"]);
  const contexts = [
    { platform: 0, model: "chat-model", nextModel: "other-model", path: "platform-one" },
    { platform: 1, model: "chat-model", path: "platform-two" },
  ];
  for (const context of contexts) {
    context.first = await (await fixture.post({ model: context.model, input: context.path }, context.platform)).json();
  }
  for (const context of contexts) {
    const response = await fixture.post({ model: context.nextModel ?? context.model, previous_response_id: context.first.id,
      input: [{ type: "function_call_output", call_id: "same-call-id", output: context.path }] }, context.platform);
    assert.equal(response.status, 200);
    await response.json();
    assert.equal(fixture.requests.at(-1).model, context.nextModel ?? context.model);
    assert.deepEqual(fixture.requests.at(-1).messages[0].tool_calls, [tool("same-call-id", "read", { path: context.path })]);
  }
});

test("TOOL-01 指定函数的 tool_choice 转为 Chat 格式并保留工具参数契约", async (t) => {
  const fixture = await startFixture(t, (_body, response) => json(response, completed("forced")));
  const response = await fixture.post({ input: "read a",
    tools: [{ type: "function", name: "read", strict: true,
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } }],
    tool_choice: { type: "function", name: "read" }, parallel_tool_calls: false,
  });
  assert.equal(response.status, 200);
  await response.json();
  const request = fixture.requests[0];
  assert.deepEqual(request.tool_choice, { type: "function", function: { name: "read" } });
  assert.equal(request.parallel_tool_calls, false);
  assert.equal(request.tools[0].function.strict, true);
  assert.deepEqual(request.tools[0].function.parameters.required, ["path"]);
});

test("NET-02 两个流式工具的参数交错与中文字节分片保持完整，并可用于后续结果续接", async (t) => {
  const fixture = await startFixture(t, async (body, response) => {
    if (!body.stream) return json(response, completed("continued"));
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunks = [
      { choices: [{ delta: { reasoning_content: "先读取" } }] },
      { choices: [{ delta: { tool_calls: [
        { index: 0, id: "a", function: { name: "read", arguments: '{"path":"' } },
        { index: 1, id: "b", function: { name: "read", arguments: '{"path":"' } },
      ] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '乙"}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '甲"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 3 } },
    ];
    const raw = chunks.map((chunk) => `data: ${JSON.stringify({ id: "parallel-stream", ...chunk })}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n";
    const bytes = Buffer.from(raw);
    for (let offset = 0; offset < bytes.length; offset += 7) {
      if (!response.write(bytes.subarray(offset, offset + 7))) await once(response, "drain");
      await nextTick();
    }
    response.end();
  });
  const stream = await fixture.post({ input: "read", stream: true });
  const values = events(await stream.text());
  assert.equal(terminals(values).length, 1);
  const result = terminals(values)[0].response;
  assert.equal(result.status, "completed");
  assert.equal(result.usage.total_tokens, 13);
  const calls = result.output.filter((item) => item.type === "function_call");
  assert.deepEqual(calls.map((call) => [call.call_id, JSON.parse(call.arguments).path]), [["a", "甲"], ["b", "乙"]]);
  for (const call of calls) {
    assert.equal(values.filter((value) => value.type === "response.function_call_arguments.delta" && value.item_id === call.id)
      .map((value) => value.delta).join(""), call.arguments);
  }
  const continuation = await fixture.post({ previous_response_id: result.id,
    input: calls.toReversed().map((call) => ({ type: "function_call_output", call_id: call.call_id, output: call.call_id })) });
  assert.equal(continuation.status, 200);
  await continuation.json();
  assert.deepEqual(fixture.requests.at(-1).messages[0].tool_calls.map((call) => call.id), ["a", "b"]);
  assert.equal(fixture.requests.at(-1).messages[0].reasoning_content, "先读取");
});

test("NET-05 SSE 正常断开但缺少完成标记时不能伪报成功，下一次请求仍能完成", async (t) => {
  let count = 0;
  const fixture = await startFixture(t, (_body, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "truncated", choices: [{ delta: { content: "unfinished" } }] })}\n\n`);
    if (++count > 1) response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    response.end();
  });
  const first = events(await (await fixture.post({ input: "first", stream: true })).text());
  assert.deepEqual(terminals(first).map((value) => value.type), ["response.failed"]);
  const second = events(await (await fixture.post({ input: "second", stream: true })).text());
  assert.deepEqual(terminals(second).map((value) => value.type), ["response.completed"]);
});

test("NET-02 上游错误终态之后的迟到帧不会追加文字、工具或第二个终态", async (t) => {
  const fixture = await startFixture(t, (_body, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "failed", error: { message: "provider failed" } })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "must not appear" }, finish_reason: "stop" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  const values = events(await (await fixture.post({ input: "test", stream: true })).text());
  assert.deepEqual(terminals(values).map((value) => value.type), ["response.failed"]);
  assert.equal(values.at(-1).type, "response.failed");
  assert.equal(values.some((value) => value.type === "response.output_text.delta"), false);
});

test("NET-05 流式传输中途断开时输出失败终态并保留已收到的文字", async (t) => {
  let upstreamResponse;
  const fixture = await startFixture(t, (_body, response) => {
    upstreamResponse = response;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "interrupted", choices: [{ delta: { content: "partial" } }] })}\n\n`);
  });
  const response = await fixture.post({ input: "test", stream: true });
  const reader = response.body.getReader();
  const chunks = [(await reader.read()).value];
  upstreamResponse.destroy();
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    chunks.push(result.value);
  }
  const values = events(Buffer.concat(chunks).toString("utf8"));
  assert.equal(values.find((value) => value.type === "response.output_text.delta").delta, "partial");
  assert.deepEqual(terminals(values).map((value) => value.type), ["response.failed"]);
});

test("NET-02 finish_reason 已确认时允许无 DONE 的结束，重复 DONE 不产生多个终态", async (t) => {
  for (const suffix of ["", "data: [DONE]\n\ndata: [DONE]\n\n"]) {
    const fixture = await startFixture(t, (_body, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ id: "finished", choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n${suffix}`);
    });
    const values = events(await (await fixture.post({ input: "test", stream: true })).text());
    assert.deepEqual(terminals(values).map((value) => value.type), ["response.completed"]);
    assert.equal(terminals(values)[0].response.output[0].content[0].text, "ok");
  }
});

test("NET-05 非流式错误 JSON 或缺失 choices 不转换成空白成功，正常请求不受污染", async (t) => {
  for (const body of [{ error: { message: "provider error" } }, { id: "invalid", choices: [] }]) {
    await t.test(JSON.stringify(body), async (caseContext) => {
      let first = true;
      const fixture = await startFixture(caseContext, (_request, response) => {
        json(response, first ? body : completed("healthy"));
        first = false;
      });
      const invalid = await fixture.post({ input: "bad" });
      assert.equal(invalid.status, 502);
      assert.ok((await invalid.json()).error.message);
      const normal = await fixture.post({ input: "good" });
      assert.equal(normal.status, 200);
      assert.equal((await normal.json()).output[0].content[0].text, "done");
    });
  }
});

test("NET-05 401、429 和 503 保留错误状态且不偷偷重试，后续正常请求可恢复", async (t) => {
  for (const status of [401, 429, 503]) {
    await t.test(String(status), async (caseContext) => {
      let first = true;
      const fixture = await startFixture(caseContext, (_body, response) => {
        json(response, first ? { error: { message: `upstream-${status}` } } : completed("healthy"), first ? status : 200);
        first = false;
      });
      const failed = await fixture.post({ input: "first" });
      assert.equal(failed.status, status);
      assert.match((await failed.json()).error.message, new RegExp(`upstream-${status}`));
      assert.equal(fixture.requests.length, 1);
      const next = await fixture.post({ input: "second" });
      assert.equal(next.status, 200);
      await next.json();
      assert.equal(fixture.requests.length, 2);
    });
  }
});

test("NET-05 取消流式请求会关闭对应上游连接，不取消另一个任务", async (t) => {
  let cancelled = false;
  const fixture = await startFixture(t, (body, response) => {
    if (!body.stream) return json(response, completed("independent"));
    response.on("close", () => { cancelled = true; });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "waiting", choices: [{ delta: { content: "started" } }] })}\n\n`);
  });
  const request = httpRequest(fixture.url(), { method: "POST", headers: { "content-type": "application/json" } });
  request.on("error", () => {});
  t.after(() => request.destroy());
  request.end(JSON.stringify({ model: "chat-model", stream: true, input: "long task" }));
  const [stream] = await once(request, "response");
  await once(stream, "data");
  stream.destroy();
  await waitFor(() => cancelled);
  const another = await fixture.post({ input: "independent task" });
  assert.equal(another.status, 200);
  assert.equal((await another.json()).output[0].content[0].text, "done");
});
