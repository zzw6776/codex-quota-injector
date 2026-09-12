import assert from "node:assert/strict";
import test from "node:test";

import { startChatCompatibilityProxy } from "../src/chat-compat-proxy.mjs";
import { readJsonRequest, startHttpServer } from "./helpers.mjs";

function platform(origin) {
  return {
    id: "platform-chat",
    name: "Chat Platform",
    baseUrl: `${origin}/v1/`,
    apiKey: "secret",
    enabled: true,
    models: [
      { id: "chat-model", chatCompatibility: true },
      { id: "native-model", chatCompatibility: false },
    ],
  };
}

function parseSse(text) {
  return text.trim().split(/\r?\n\r?\n/).map((block) => {
    const event = block.split(/\r?\n/).find((line) => line.startsWith("event:"))
      ?.slice(6).trim();
    const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim()).join("\n");
    return { event, data: JSON.parse(data) };
  });
}

async function startProxy(t, upstreamOrigin) {
  const value = platform(upstreamOrigin);
  const proxy = await startChatCompatibilityProxy(new Map([[value.id, value]]));
  t.after(() => proxy.close());
  return { proxy, platform: value, baseUrl: proxy.baseUrlFor(value) };
}

test("没有 Chat 兼容模型时不启动代理", async () => {
  const value = platform("http://127.0.0.1:1");
  value.models = [{ id: "native", chatCompatibility: false }];
  assert.equal(await startChatCompatibilityProxy(new Map([[value.id, value]])), null);
});

test("Chat 兼容代理保留文本、图片、工具、推理和 usage 语义", async (t) => {
  let received;
  const upstream = await startHttpServer(t, async (request, response) => {
    received = { url: request.url, headers: request.headers, body: await readJsonRequest(request) };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "chat_123",
      model: "chat-model",
      created: 123,
      choices: [{
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: "answer",
          reasoning_content: "reason",
          tool_calls: [{
            id: "call_lookup",
            type: "function",
            function: { name: "lookup", arguments: "{\"id\":1}" },
          }],
        },
      }],
      usage: {
        prompt_tokens: 20,
        prompt_tokens_details: { cached_tokens: 4 },
        completion_tokens: 7,
        completion_tokens_details: { reasoning_tokens: 2 },
      },
    }));
  });
  const { baseUrl } = await startProxy(t, upstream.origin);
  const body = {
    model: "chat-model",
    instructions: "system rule",
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: "question" },
        { type: "input_image", image_url: "https://example.test/image.png" },
      ],
    }],
    tools: [{
      type: "function",
      name: "lookup",
      description: "Lookup",
      strict: true,
      parameters: { type: "object", properties: { id: { type: "number" } } },
    }],
    tool_choice: "auto",
    parallel_tool_calls: true,
    max_output_tokens: 99,
    temperature: 0.2,
    stream: false,
  };
  const response = await fetch(new URL("responses", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer custom" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  const converted = await response.json();
  assert.equal(received.url, "/v1/chat/completions");
  assert.equal(received.body.stream, false);
  assert.equal(received.body.max_tokens, 99);
  assert.equal(received.body.messages[0].role, "system");
  assert.deepEqual(received.body.messages[1].content, [
    { type: "text", text: "question" },
    { type: "image_url", image_url: { url: "https://example.test/image.png" } },
  ]);
  assert.equal(received.body.tools[0].function.name, "lookup");
  assert.equal(received.headers.authorization, "Bearer custom");
  assert.equal(converted.id, "resp_chat_123");
  assert.equal(converted.status, "completed");
  assert.deepEqual(converted.output.map((item) => item.type), [
    "reasoning", "message", "function_call",
  ]);
  assert.equal(converted.output[2].call_id, "call_lookup");
  assert.deepEqual(converted.usage, {
    input_tokens: 20,
    input_tokens_details: { cached_tokens: 4 },
    output_tokens: 7,
    output_tokens_details: { reasoning_tokens: 2 },
    total_tokens: 27,
  });
});

test("工具结果续接会按 previous_response_id 恢复助手工具调用", async (t) => {
  const requests = [];
  const upstream = await startHttpServer(t, async (request, response) => {
    const body = await readJsonRequest(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });
    if (requests.length === 1) {
      response.end(JSON.stringify({
        id: "first",
        model: "chat-model",
        choices: [{ message: { tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "read", arguments: "{\"path\":\"a\"}" },
        }] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }));
      return;
    }
    response.end(JSON.stringify({
      id: "second",
      model: "chat-model",
      choices: [{ message: { content: "done" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 8, completion_tokens: 1 },
    }));
  });
  const { baseUrl } = await startProxy(t, upstream.origin);
  const post = (body) => fetch(new URL("responses", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((response) => response.json());
  const first = await post({ model: "chat-model", input: "read", stream: false });
  assert.equal(first.id, "resp_first");
  const second = await post({
    model: "chat-model",
    previous_response_id: first.id,
    input: [{ type: "function_call_output", call_id: "call_1", output: { ok: true } }],
    stream: false,
  });
  assert.equal(second.output[0].content[0].text, "done");
  assert.deepEqual(requests[1].messages, [
    {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: { name: "read", arguments: "{\"path\":\"a\"}" },
      }],
    },
    { role: "tool", tool_call_id: "call_1", content: "{\"ok\":true}" },
  ]);
});

test("缺失工具调用历史时明确拒绝续接，不向错误上下文发送结果", async (t) => {
  let requests = 0;
  const upstream = await startHttpServer(t, (_request, response) => {
    requests += 1;
    response.end("{}");
  });
  const { baseUrl } = await startProxy(t, upstream.origin);
  const response = await fetch(new URL("responses", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "chat-model",
      previous_response_id: "resp_missing",
      input: [{ type: "function_call_output", call_id: "call_missing", output: "x" }],
    }),
  });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error.message, /未找到 previous_response_id/);
  assert.equal(requests, 0);
});

test("Chat SSE 会转换完整增量事件，长度截断使用 response.incomplete", async (t) => {
  const upstream = await startHttpServer(t, async (request, response) => {
    const body = await readJsonRequest(request);
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunks = [
      { id: "stream", model: "chat-model", choices: [{ delta: { reasoning_content: "why" } }] },
      { id: "stream", model: "chat-model", choices: [{ delta: { content: "hel" } }] },
      { id: "stream", model: "chat-model", choices: [{ delta: { content: "lo" } }] },
      {
        id: "stream",
        model: "chat-model",
        choices: [{ delta: {}, finish_reason: "length" }],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      },
    ];
    for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  const { baseUrl } = await startProxy(t, upstream.origin);
  const response = await fetch(new URL("responses", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "chat-model", input: "hi", stream: true }),
  });
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const events = parseSse(await response.text());
  assert.ok(events.some((entry) => entry.event === "response.reasoning_summary_text.delta"));
  assert.deepEqual(
    events.filter((entry) => entry.event === "response.output_text.delta")
      .map((entry) => entry.data.delta),
    ["hel", "lo"],
  );
  const terminal = events.at(-1);
  assert.equal(terminal.event, "response.incomplete");
  assert.equal(terminal.data.type, "response.incomplete");
  assert.equal(terminal.data.response.status, "incomplete");
  assert.equal(terminal.data.response.incomplete_details.reason, "max_output_tokens");
  assert.equal(terminal.data.response.usage.total_tokens, 14);
});

test("非兼容模型的 Responses 请求完全透传", async (t) => {
  let received;
  const upstream = await startHttpServer(t, async (request, response) => {
    received = { url: request.url, body: await readJsonRequest(request) };
    response.writeHead(207, { "content-type": "application/json" });
    response.end(JSON.stringify({ native: true }));
  });
  const { baseUrl } = await startProxy(t, upstream.origin);
  const body = { model: "native-model", input: "unchanged", store: true };
  const response = await fetch(new URL("responses?x=1", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 207);
  assert.deepEqual(await response.json(), { native: true });
  assert.equal(received.url, "/v1/responses?x=1");
  assert.deepEqual(received.body, body);
});
