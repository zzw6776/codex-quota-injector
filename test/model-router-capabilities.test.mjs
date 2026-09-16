import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { ModelRouterManager } from "../src/model-router.mjs";
import { readJsonRequest, startHttpServer, useTempDir } from "./helpers.mjs";
import { MODEL_CAPABILITY_PROBE_VERSION } from "../src/model-capability-probe.mjs";
import { routerSettings, readEvents } from "./model-router/support.mjs";

test("自定义 Responses 请求只改写声明过的兼容字段并隔离官方凭据", async (t) => {
  let received;
  const requestShapes = [];
  const upstream = await startHttpServer(t, async (request, response) => {
    received = { headers: request.headers, body: await readJsonRequest(request) };
    response.writeHead(200, { "content-type": "application/json", "x-upstream": "yes" });
    response.end(JSON.stringify({
      id: "resp_custom",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
      usage: {
        input_tokens: 12,
        input_tokens_details: { cached_tokens: 3 },
        output_tokens: 5,
        output_tokens_details: { reasoning_tokens: 2 },
        total_tokens: 17,
      },
    }));
  });
  const dataDir = await useTempDir(t);
  const usageEventPath = join(dataDir, "usage.jsonl");
  const manager = new ModelRouterManager({ onRequestShape: shape => requestShapes.push(shape) });
  t.after(() => manager.close());
  const config = await manager.configure({
    ...routerSettings(upstream.origin),
    usageEventPath,
  });
  const source = {
    model: "custom-model",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
        internal_chat_message_metadata_passthrough: { turn_id: "private-turn" },
      },
      { type: "configuration_update", reasoning: { effort: "medium" } },
    ],
    tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
    service_tier: "priority",
    store: true,
    reasoning: { summary: "auto" },
    client_metadata: { thread_id: "thread-custom", turn_id: "turn-custom" },
  };
  const response = await fetch(new URL("responses?trace=1", config.baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer official-secret",
      "chatgpt-account-id": "account-id",
      "thread-id": "thread-custom",
      "turn-id": "turn-custom",
      "x-codex-test": "remove-me",
    },
    body: JSON.stringify(source),
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-upstream"), "yes");
  assert.equal((await response.json()).id, "resp_custom");
  assert.equal(received.headers.authorization, "Bearer custom-secret");
  assert.equal(received.headers["chatgpt-account-id"], undefined);
  assert.equal(received.headers["x-codex-test"], undefined);
  assert.equal(received.body.store, false);
  assert.equal(received.body.service_tier, undefined);
  assert.deepEqual(received.body.reasoning, { effort: "low" });
  assert.equal(received.body.input[0].internal_chat_message_metadata_passthrough, undefined);
  assert.deepEqual(received.body.input[0].content, source.input[0].content);
  assert.deepEqual(received.body.input[1], source.input[1],
    "公开的 Responses 配置更新必须保留，不能与 Codex 私有元数据一起误删");
  assert.deepEqual(source.input[0].internal_chat_message_metadata_passthrough, { turn_id: "private-turn" },
    "路由改写不能反向修改调用方请求对象");
  assert.deepEqual(received.body.tools, source.tools);
  assert.equal(requestShapes.length, 1);
  assert.equal(requestShapes[0].path, "/v1/responses");
  assert.equal(requestShapes[0].targetKind, "custom");
  assert.equal(requestShapes[0].shape.input[0].type, "message");
  assert.deepEqual(requestShapes[0].shape.input[0].content, [{ type: "input_text", keys: ["text", "type"] }]);
  assert.doesNotMatch(JSON.stringify(requestShapes), /hello|private-turn/);

  await manager.close();
  const events = await readEvents(usageEventPath);
  assert.equal(events.filter((event) => event.type === "turn-started").length, 1);
  assert.equal(events.filter((event) => event.type === "usage").length, 1);
  assert.equal(events.find((event) => event.type === "usage").responseId, "resp_custom");
  assert.equal(events.find((event) => event.type === "usage").tokenUsage.last.totalTokens, 17);
  assert.equal(events.filter((event) => event.type === "generation").length, 1);
  assert.equal(
    events.find((event) => event.type === "generation").generation.responseId,
    "resp_custom",
  );
  assert.equal(events.find((event) => event.type === "generation").generation.hasVisibleText, true);
});

test("能力矩阵按模型过滤不可用 Hosted 工具和未通过的请求选项", async (t) => {
  const received = [];
  const upstream = await startHttpServer(t, async (request, response) => {
    received.push(await readJsonRequest(request));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "resp_capability", status: "completed", output: [] }));
  });
  const manager = new ModelRouterManager();
  t.after(() => manager.close());
  const config = await manager.configure(routerSettings(upstream.origin, {
    compatibility: {
      status: "verified",
      protocol: "responses",
      historyMode: "responses-full",
      toolContinuation: true,
      supportsImage: false,
      imageStatus: "unsupported",
      capabilities: {
        streaming: "native",
        functionTools: "native",
        customTools: "native",
        namespaceTools: "native",
        parallelTools: "unsupported",
        toolChoice: "unsupported",
        hostedTools: { web_search: "unsupported" },
      },
      codexConformance: "passed",
      checkedAt: 1,
      probeVersion: 6,
      targetFingerprint: "fixture",
    },
  }));
  const optional = await fetch(new URL("responses", config.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "custom-model",
      input: [
        { role: "user", content: [{ type: "input_text", text: "fixture" }] },
        { type: "additional_tools", tools: [{ type: "web_search" }] },
      ],
      tools: [
        { type: "function", name: "lookup", parameters: { type: "object" } },
        { type: "web_search" },
        { type: "future_hosted_tool" },
        { type: "namespace", name: "hosted", tools: [{ type: "web_search" }] },
      ],
      tool_choice: "auto",
      parallel_tool_calls: true,
    }),
  });
  assert.equal(optional.status, 200);
  assert.deepEqual(received[0].tools, [
    { type: "function", name: "lookup", parameters: { type: "object" } },
  ]);
  assert.equal(received[0].input.some((item) => item?.type === "additional_tools"), false);
  assert.equal(received[0].tool_choice, undefined);
  assert.equal(received[0].parallel_tool_calls, undefined);

  const required = await fetch(new URL("responses", config.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "custom-model",
      input: "fixture",
      tools: [{ type: "web_search" }],
      tool_choice: {
        type: "allowed_tools",
        mode: "required",
        tools: [{ type: "web_search" }],
      },
    }),
  });
  assert.equal(required.status, 400);
  assert.match((await required.json()).error.message, /不支持服务端工具 web_search/);
  const unknownRequired = await fetch(new URL("responses", config.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "custom-model",
      input: "fixture",
      tools: [{ type: "future_hosted_tool" }],
      tool_choice: { type: "future_hosted_tool" },
    }),
  });
  assert.equal(unknownRequired.status, 400);
  assert.match((await unknownRequired.json()).error.message, /不支持服务端工具 future_hosted_tool/);
  assert.equal(received.length, 1);
});

test("Router 对 Responses 模型只桥接探针确认缺失的 Codex 工具形态", async (t) => {
  let received;
  const upstream = await startHttpServer(t, async (request, response) => {
    received = await readJsonRequest(request);
    const bridged = received.tools.find((tool) => /^cq_custom_/.test(tool.name));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "resp_bridged",
      status: "completed",
      output: [{
        id: "tool-item",
        type: "function_call",
        name: bridged.name,
        call_id: "call-exec",
        arguments: '{"input":"run"}',
      }],
    }));
  });
  const manager = new ModelRouterManager();
  t.after(() => manager.close());
  const config = await manager.configure(routerSettings(upstream.origin, {
    compatibility: {
      status: "verified",
      protocol: "responses",
      historyMode: "responses-full",
      toolContinuation: true,
      supportsImage: false,
      imageStatus: "unsupported",
      capabilities: {
        streaming: "native",
        functionTools: "native",
        customTools: "bridged",
        namespaceTools: "bridged",
        nativeCustomTools: ["apply_patch"],
        parallelTools: "native",
        toolChoice: "native",
        reasoningToolChoice: "native",
        hostedTools: { web_search: "unsupported" },
      },
      codexConformance: "passed",
      checkedAt: 1,
      probeVersion: MODEL_CAPABILITY_PROBE_VERSION,
      targetFingerprint: "fixture",
    },
  }));
  const response = await fetch(new URL("responses", config.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "custom-model",
      input: "run",
      tools: [
        { type: "custom", name: "apply_patch" },
        { type: "custom", name: "exec" },
        { type: "namespace", name: "functions", tools: [{
          type: "function",
          name: "read_thread",
          parameters: { type: "object" },
        }] },
        { type: "web_search" },
      ],
      tool_choice: { type: "custom", name: "exec" },
    }),
  });

  assert.equal(response.status, 200);
  const converted = await response.json();
  assert.deepEqual(converted.output[0], {
    id: "tool-item",
    type: "custom_tool_call",
    name: "exec",
    call_id: "call-exec",
    input: "run",
  });
  assert.ok(received.tools.some((tool) => tool.type === "custom" && tool.name === "apply_patch"));
  assert.ok(received.tools.some((tool) => /^cq_custom_/.test(tool.name)));
  assert.ok(received.tools.some((tool) => /^cq_namespace_/.test(tool.name)));
  assert.equal(received.tools.some((tool) => tool.type === "web_search"), false);
  assert.match(received.tool_choice.name, /^cq_custom_/);
});

test("推理模式仅支持自动工具选择时 Router 保留工具并移除强制选择", async (t) => {
  let received;
  const upstream = await startHttpServer(t, async (request, response) => {
    received = await readJsonRequest(request);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "chat-reasoning-policy",
      choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
    }));
  });
  const manager = new ModelRouterManager();
  t.after(() => manager.close());
  const config = await manager.configure(routerSettings(upstream.origin, {
    compatibility: {
      status: "verified",
      protocol: "chat",
      historyMode: "chat",
      toolContinuation: true,
      supportsImage: false,
      imageStatus: "unsupported",
      capabilities: {
        streaming: "native",
        functionTools: "native",
        customTools: "bridged",
        namespaceTools: "bridged",
        nativeCustomTools: [],
        parallelTools: "native",
        toolChoice: "native",
        reasoning: "native",
        reasoningToolChoice: "auto-only",
        hostedTools: { web_search: "unsupported" },
      },
      codexConformance: "passed",
      checkedAt: 1,
      probeVersion: MODEL_CAPABILITY_PROBE_VERSION,
      targetFingerprint: "fixture",
    },
    reasoningEfforts: ["low", "high", "max"],
    defaultReasoningEffort: "high",
  }));
  const response = await fetch(new URL("responses", config.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "custom-model",
      input: "Call lookup.",
      reasoning: { effort: "high" },
      tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
      tool_choice: { type: "function", name: "lookup" },
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(received.reasoning_effort, "high");
  assert.equal(received.tool_choice, "auto");
  assert.equal(received.tools[0].function.name, "lookup");
});

test("自动检测出的纯文本历史模式按能力清理 reasoning 信封且保留正文", async (t) => {
  let received;
  const upstream = await startHttpServer(t, async (request, response) => {
    received = await readJsonRequest(request);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "resp-compatible", status: "completed", output: [] }));
  });
  const manager = new ModelRouterManager();
  t.after(() => manager.close());
  const settings = routerSettings(upstream.origin, {
    compatibility: {
      status: "verified",
      protocol: "responses",
      historyMode: "reasoning-text-only",
      toolContinuation: true,
      supportsImage: false,
      imageStatus: "unsupported",
      checkedAt: 1,
      probeVersion: 5,
      targetFingerprint: "fixture",
    },
  });
  const config = await manager.configure(settings);
  const source = {
    model: "custom-model",
    input: [{
      type: "reasoning",
      id: "reasoning-1",
      summary: [{ type: "summary_text", text: "private summary" }],
      encrypted_content: "private encrypted content",
      reasoning_text: "provider-visible reasoning",
    }],
  };
  const response = await fetch(new URL("responses", config.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(source),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(received.input, [{
    type: "reasoning",
    id: "reasoning-1",
    reasoning_text: "provider-visible reasoning",
  }]);
  assert.equal(source.input[0].encrypted_content, "private encrypted content",
    "兼容改写不能修改调用方对象");
});

test("官方 HTTP 路由完整透传 Codex 能力字段且不重复记录 usage", async (t) => {
  const requests = [];
  const upstream = await startHttpServer(t, async (request, response) => {
    if (request.method === "GET") {
      requests.push({ method: request.method, url: request.url, headers: request.headers });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: "official-model" }] }));
      return;
    }
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: await readJsonRequest(request),
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "resp_official",
      status: "completed",
      output: [],
      usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 },
    }));
  });
  const dataDir = await useTempDir(t);
  const usageEventPath = join(dataDir, "usage.jsonl");
  const base = `${upstream.origin}/v1/`;
  const manager = new ModelRouterManager({
    officialApiBaseUrl: base,
    officialCodexBaseUrl: base,
  });
  t.after(() => manager.close());
  const config = await manager.configure({ ...routerSettings(upstream.origin), usageEventPath });
  const models = await fetch(new URL("models?limit=10", config.baseUrl), {
    headers: { authorization: "Bearer sk-test" },
  });
  assert.equal(models.status, 200);

  const payload = {
    model: "official-model",
    input: [
      { role: "user", content: [
        { type: "input_text", text: "inspect" },
        { type: "input_image", image_url: "data:image/png;base64,AA==" },
      ] },
      { type: "function_call_output", call_id: "call_1", output: "done" },
    ],
    previous_response_id: "resp_previous",
    tools: [
      { type: "function", name: "lookup", parameters: { type: "object" } },
      { type: "mcp", server_label: "yuque" },
      { type: "computer" },
      { type: "shell" },
      { type: "apply_patch" },
    ],
    tool_choice: "auto",
    parallel_tool_calls: true,
    reasoning: { effort: "high", summary: "auto" },
    client_metadata: { thread_id: "thread-official", turn_id: "turn-official" },
    stream: false,
  };
  const response = await fetch(new URL("responses?include=usage", config.baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer sk-test",
      "x-feature-header": "preserved",
    },
    body: JSON.stringify(payload),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).id, "resp_official");
  assert.equal(requests[0].url, "/v1/models?limit=10");
  assert.equal(requests[1].url, "/v1/responses?include=usage");
  assert.deepEqual(requests[1].body, payload);
  assert.equal(requests[1].headers.authorization, "Bearer sk-test");
  assert.equal(requests[1].headers["x-feature-header"], "preserved");

  await manager.close();
  const events = await readEvents(usageEventPath);
  const started = events.find((event) => event.type === "turn-started");
  assert.equal(started.rolloutUsageFallback, true);
  assert.equal(events.some((event) => event.type === "usage"), false);
  assert.equal(events.filter((event) => event.type === "generation").length, 1);
  assert.equal(
    events.find((event) => event.type === "generation").generation.responseId,
    "resp_official",
  );
});

test("手动配置经过 Router 保留图片、推理强度并转换 Codex 工具", async t => {
  const received = [];
  const upstream = await startHttpServer(t, async (request, response) => {
    received.push(await readJsonRequest(request));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "manual-reply", status: "completed", output: [] }));
  });
  const manager = new ModelRouterManager();
  t.after(() => manager.close());
  const config = await manager.configure(routerSettings(upstream.origin, {
    compatibility: { status: "manual", probeVersion: 0, protocol: "responses", supportsImage: true,
      historyMode: "reasoning-text-only", capabilities: { customTools: "bridged", namespaceTools: "bridged",
        nativeCustomTools: [], toolChoice: "unsupported", reasoningToolChoice: "unsupported",
        parallelTools: "unsupported", hostedTools: { web_search: "unsupported" } } },
  }));
  const response = await fetch(new URL("responses", config.baseUrl), { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "custom-model",
      input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }] }],
      reasoning: { effort: "high" }, tools: [{ type: "custom", name: "fixture_tool", description: "fixture" }],
    }) });
  assert.equal(response.status, 200);
  assert.equal(received.length, 1);
  assert.equal(received[0].reasoning.effort, "high");
  assert.equal(received[0].input[0].content[0].type, "input_image");
  assert.equal(received[0].tools[0].type, "function");
});
