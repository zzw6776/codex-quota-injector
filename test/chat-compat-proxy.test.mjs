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

async function startResponsesBridgeProxy(t, upstreamOrigin, capabilityOverrides = {}) {
  const value = {
    id: "platform-responses",
    name: "Responses Platform",
    baseUrl: `${upstreamOrigin}/v1/`,
    apiKey: "secret",
    enabled: true,
    models: [{
      id: "responses-model",
      displayName: "Responses Model",
      chatCompatibility: false,
      historyMode: "responses-full",
      capabilities: {
        customTools: "bridged",
        namespaceTools: "bridged",
        nativeCustomTools: ["apply_patch"],
        parallelTools: "native",
        toolChoice: "native",
        reasoningToolChoice: "native",
        hostedTools: { web_search: "unsupported" },
        ...capabilityOverrides,
      },
    }],
  };
  const proxy = await startChatCompatibilityProxy(new Map([[value.id, value]]));
  t.after(() => proxy.close());
  const post = (body) => fetch(new URL("responses", proxy.baseUrlFor(value)), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "responses-model", stream: false, ...body }),
  });
  return { proxy, platform: value, post };
}

test("第三方模型始终启动统一兼容边界", async (t) => {
  const value = platform("http://127.0.0.1:1");
  value.models = [{ id: "native", chatCompatibility: false }];
  const proxy = await startChatCompatibilityProxy(new Map([[value.id, value]]));
  t.after(() => proxy.close());
  assert.ok(proxy.baseUrlFor(value).startsWith("http://127.0.0.1:"));
});

test("按请求能力把图片转到 Chat，普通请求继续使用 Responses", async (t) => {
  const requests = [];
  const upstream = await startHttpServer(t, async (request, response) => {
    const body = await readJsonRequest(request);
    requests.push({ url: request.url, body });
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/v1/chat/completions") {
      response.end(JSON.stringify({
        id: "chat-image",
        model: "split-model",
        choices: [{ message: { role: "assistant", content: "red-blue" }, finish_reason: "stop" }],
      }));
      return;
    }
    response.end(JSON.stringify({ id: "responses-text", status: "completed", output: [] }));
  });
  const value = platform(upstream.origin);
  value.models = [{
    id: "split-model",
    chatCompatibility: false,
    routes: { default: "responses", imageInput: "chat" },
  }];
  const proxy = await startChatCompatibilityProxy(new Map([[value.id, value]]));
  t.after(() => proxy.close());
  const post = (input) => fetch(new URL("responses", proxy.baseUrlFor(value)), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "split-model", input, stream: false }),
  });

  assert.equal((await post("hello")).status, 200);
  const imageResponse = await post([{ role: "user", content: [
    { type: "input_text", text: "inspect" },
    { type: "input_image", image_url: "data:image/png;base64,fixture" },
  ] }]);
  assert.equal(imageResponse.status, 200);
  assert.deepEqual(requests.map((item) => item.url), [
    "/v1/responses",
    "/v1/chat/completions",
  ]);
  assert.equal(requests[1].body.messages[0].content[1].type, "image_url");
});

test("Chat 转换保留各回合的推理正文且不会串到后续工具调用", async (t) => {
  let received;
  const upstream = await startHttpServer(t, async (request, response) => {
    received = await readJsonRequest(request);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
  });
  const { baseUrl } = await startProxy(t, upstream.origin);
  const response = await fetch(new URL("responses", baseUrl), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "chat-model", input: [
      { type: "reasoning", summary: [{ type: "summary_text", text: "first reasoning" }] },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "continue" },
      { type: "reasoning", reasoning_text: "second reasoning" },
      { type: "function_call", name: "lookup", call_id: "call-1", arguments: "{}" },
      { type: "function_call_output", call_id: "call-1", output: "tool result" },
      { type: "reasoning", content: [{ type: "reasoning_text", text: "final reasoning" }] },
      { role: "assistant", content: "final answer" },
      { role: "user", content: "next tool" },
      { type: "function_call", name: "lookup", call_id: "call-2", arguments: "{}" },
      { type: "function_call_output", call_id: "call-2", output: "next result" },
    ] }),
  });
  assert.equal(response.status, 200);
  await response.json();
  const assistants = received.messages.filter((item) => item.role === "assistant");
  assert.deepEqual(assistants.map((item) => item.reasoning_content), [
    "first reasoning", "second reasoning", "final reasoning", undefined,
  ]);
  assert.deepEqual(assistants.filter((item) => item.tool_calls).map((item) => item.tool_calls[0].id), ["call-1", "call-2"]);
});

test("纯文本历史模式在原生 Responses 转发前移除私有 reasoning 信封", async (t) => {
  let received;
  const upstream = await startHttpServer(t, async (request, response) => {
    received = { url: request.url, body: await readJsonRequest(request) };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "response-compatible", output: [] }));
  });
  const value = platform(upstream.origin);
  value.models = [{
    id: "native-model",
    chatCompatibility: false,
    historyMode: "reasoning-text-only",
  }];
  const proxy = await startChatCompatibilityProxy(new Map([[value.id, value]]));
  t.after(() => proxy.close());
  const source = {
    model: "native-model",
    input: [{
      type: "reasoning",
      reasoning_text: "visible reasoning",
      summary: [{ type: "summary_text", text: "private" }],
      encrypted_content: "opaque",
    }],
  };
  const response = await fetch(new URL("responses", proxy.baseUrlFor(value)), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(source),
  });
  assert.equal(response.status, 200);
  assert.equal(received.url, "/v1/responses");
  assert.deepEqual(received.body.input, [{
    type: "reasoning",
    reasoning_text: "visible reasoning",
  }]);
  assert.equal(source.input[0].encrypted_content, "opaque");
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

test("Chat 兼容按推理强度传参，并把推理模式的指定工具降为 auto", async (t) => {
  const received = [];
  const upstream = await startHttpServer(t, async (request, response) => {
    received.push(await readJsonRequest(request));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: `chat-${received.length}`,
      model: "chat-model",
      choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
    }));
  });
  const value = platform(upstream.origin);
  value.models[0] = {
    ...value.models[0],
    defaultReasoningEffort: "high",
    capabilities: {
      toolChoice: "native",
      reasoningToolChoice: "auto-only",
      parallelTools: "native",
      hostedTools: {},
    },
  };
  const proxy = await startChatCompatibilityProxy(new Map([[value.id, value]]));
  t.after(() => proxy.close());
  const post = (reasoning) => fetch(new URL("responses", proxy.baseUrlFor(value)), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "chat-model",
      input: "Call lookup.",
      reasoning,
      tools: [{
        type: "function",
        name: "lookup",
        parameters: { type: "object", additionalProperties: false },
      }],
      tool_choice: { type: "function", name: "lookup" },
      stream: false,
    }),
  });

  assert.equal((await post({ effort: "high" })).status, 200);
  assert.equal(received[0].reasoning_effort, "high");
  assert.equal(received[0].tool_choice, "auto");

  assert.equal((await post({ effort: "none" })).status, 200);
  assert.equal(received[1].reasoning_effort, "none");
  assert.deepEqual(received[1].tool_choice, {
    type: "function",
    function: { name: "lookup" },
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

test("Responses custom 工具只转换工具形态，并通过缓存续接工具结果", async (t) => {
  const requests = [];
  const upstream = await startHttpServer(t, async (request, response) => {
    const body = await readJsonRequest(request);
    requests.push(body);
    const output = Array.isArray(body.input)
      ? body.input.find((item) => item.type === "function_call_output")
      : null;
    if (output) {
      assert.ok(body.input.some((item) =>
        item.type === "function_call" && item.call_id === output.call_id));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "resp-finished",
        status: "completed",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "continued" }],
        }],
      }));
      return;
    }
    assert.deepEqual(body.tools.map((tool) => tool.type), ["custom", "function"]);
    assert.equal(body.tools[0].name, "apply_patch");
    assert.match(body.tools[1].name, /^cq_custom_/);
    assert.equal(body.tool_choice.name, body.tools[1].name);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "resp-tool",
      status: "completed",
      output: [{
        id: "tool-item",
        type: "function_call",
        name: body.tools[1].name,
        call_id: "call-exec",
        arguments: '{"input":"console.log(1)"}',
      }],
    }));
  });
  const fixture = await startResponsesBridgeProxy(t, upstream.origin);
  const firstResponse = await fixture.post({
    input: "run",
    tools: [
      { type: "custom", name: "apply_patch" },
      { type: "custom", name: "exec" },
      { type: "web_search" },
      { type: "future_hosted_tool" },
    ],
    tool_choice: { type: "custom", name: "exec" },
  });
  const firstText = await firstResponse.text();
  assert.equal(firstResponse.status, 200, firstText);
  const first = JSON.parse(firstText);
  assert.deepEqual(first.output[0], {
    id: "tool-item",
    type: "custom_tool_call",
    name: "exec",
    call_id: "call-exec",
    input: "console.log(1)",
  });

  const second = await fixture.post({
    previous_response_id: first.id,
    input: [{ type: "custom_tool_call_output", call_id: "call-exec", output: "done" }],
  });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).output[0].content[0].text, "continued");
  assert.equal(requests.length, 2);
});

test("Responses SSE 将桥接工具还原为 Codex custom 事件", async (t) => {
  const upstream = await startHttpServer(t, async (request, response) => {
    const body = await readJsonRequest(request);
    const name = body.tools[0].name;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const values = [
      { type: "response.output_item.added", output_index: 0, item: {
        id: "item", type: "function_call", name, call_id: "call", arguments: "",
      } },
      { type: "response.function_call_arguments.delta", item_id: "item", output_index: 0, delta: '{"input":"raw"}' },
      { type: "response.function_call_arguments.done", item_id: "item", output_index: 0, arguments: '{"input":"raw"}' },
      { type: "response.output_item.done", output_index: 0, item: {
        id: "item", type: "function_call", name, call_id: "call", arguments: '{"input":"raw"}',
      } },
      { type: "response.completed", response: { id: "stream", status: "completed", output: [{
        id: "item", type: "function_call", name, call_id: "call", arguments: '{"input":"raw"}',
      }] } },
    ];
    for (const value of values) response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
    response.end();
  });
  const fixture = await startResponsesBridgeProxy(t, upstream.origin);
  const response = await fixture.post({
    input: "run",
    stream: true,
    tools: [{ type: "custom", name: "exec" }],
  });
  const values = parseSse(await response.text());
  assert.equal(values.some((entry) => entry.event === "response.function_call_arguments.delta"), false);
  assert.equal(values.find((entry) => entry.event === "response.custom_tool_call_input.done").data.input, "raw");
  assert.equal(values.find((entry) => entry.event === "response.output_item.done").data.item.type, "custom_tool_call");
  assert.equal(values.at(-1).data.response.output[0].input, "raw");
});

test("Responses 直接入口过滤 allowed_tools 中不可用的服务端工具并拒绝无可用必选项", async (t) => {
  const requests = [];
  const upstream = await startHttpServer(t, async (request, response) => {
    const body = await readJsonRequest(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "resp", status: "completed", output: [] }));
  });
  const fixture = await startResponsesBridgeProxy(t, upstream.origin);
  const mixed = await fixture.post({
    input: "run",
    tools: [{ type: "custom", name: "exec" }, { type: "web_search" }],
    tool_choice: {
      type: "allowed_tools",
      mode: "required",
      tools: [{ type: "custom", name: "exec" }, { type: "web_search" }],
    },
  });
  assert.equal(mixed.status, 200);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].tool_choice, {
    type: "allowed_tools",
    mode: "required",
    tools: [{ type: "function", name: requests[0].tools[0].name }],
  });

  const unavailableOnly = await fixture.post({
    input: "search",
    tools: [{ type: "web_search" }],
    tool_choice: {
      type: "allowed_tools",
      mode: "required",
      tools: [{ type: "web_search" }],
    },
  });
  assert.equal(unavailableOnly.status, 502);
  assert.match((await unavailableOnly.json()).error.message, /不支持服务端工具 web_search/);
  assert.equal(requests.length, 1);
});

test("完全原生 Responses 的直接入口仍按能力矩阵过滤未来工具和请求选项", async (t) => {
  const requests = [];
  const upstream = await startHttpServer(t, async (request, response) => {
    requests.push(await readJsonRequest(request));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "native", status: "completed", output: [] }));
  });
  const fixture = await startResponsesBridgeProxy(t, upstream.origin, {
    customTools: "native",
    namespaceTools: "native",
    nativeCustomTools: ["*"],
    parallelTools: "unsupported",
    toolChoice: "auto-only",
    reasoningToolChoice: "auto-only",
  });
  const response = await fixture.post({
    input: "run",
    tools: [
      { type: "function", name: "lookup", parameters: { type: "object" } },
      { type: "future_hosted_tool" },
    ],
    tool_choice: { type: "function", name: "lookup" },
    parallel_tool_calls: true,
  });
  assert.equal(response.status, 200);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].tools, [
    { type: "function", name: "lookup", parameters: { type: "object" } },
  ]);
  assert.equal(requests[0].tool_choice, "auto");
  assert.equal(Object.hasOwn(requests[0], "parallel_tool_calls"), false);
});

test("Responses 原生与桥接入口都展开工具引用并保留 false 参数约束", async (t) => {
  const requests = [];
  const upstream = await startHttpServer(t, async (request, response) => {
    requests.push(await readJsonRequest(request));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "schema", status: "completed", output: [] }));
  });
  for (const native of [false, true]) {
    const fixture = await startResponsesBridgeProxy(t, upstream.origin, native ? {
      customTools: "native", namespaceTools: "native", nativeCustomTools: ["*"],
    } : {});
    const response = await fixture.post({ input: "read", tools: [{
      type: "function", name: "read", parameters: {
        type: "object",
        $defs: { path: { type: "string", minLength: 1 }, forbidden: false },
        properties: { path: { $ref: "#/$defs/path" }, unsafe: { $ref: "#/$defs/forbidden" } },
        required: ["path"], additionalProperties: false,
      },
    }] });
    assert.equal(response.status, 200, await response.text());
    assert.deepEqual(requests.at(-1).tools[0].parameters, {
      type: "object",
      properties: { path: { type: "string", minLength: 1 }, unsafe: false },
      required: ["path"], additionalProperties: false,
    });
  }
  assert.equal(requests.length, 2);
});
