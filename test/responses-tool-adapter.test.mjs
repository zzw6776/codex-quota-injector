import assert from "node:assert/strict";
import test from "node:test";

import {
  createResponsesToolStreamTranslator,
  prepareResponsesToolRequest,
  translateResponsesPayload,
} from "../src/responses-tool-adapter.mjs";

const rawTool = { type: "custom", name: "exec", description: "Run raw code." };
const namespaceTool = {
  type: "namespace",
  name: "functions",
  tools: [{
    type: "function",
    name: "read_thread",
    parameters: { type: "object", properties: { id: { type: "string" } } },
  }],
};

test("Responses 保留原生能力并只转换不支持的 custom、namespace 工具", () => {
  const prepared = prepareResponsesToolRequest({
    model: "fixture",
    input: [{
      type: "additional_tools",
      tools: [namespaceTool],
    }, { role: "user", content: "run" }],
    tools: [
      { type: "function", name: "lookup", parameters: { type: "object" } },
      { type: "custom", name: "apply_patch" },
      rawTool,
      { type: "web_search" },
    ],
    tool_choice: { type: "custom", name: "exec" },
  }, {
    nativeCustomTools: ["apply_patch"],
  });

  assert.equal(prepared.body.input.some((item) => item.type === "additional_tools"), false);
  assert.ok(prepared.body.tools.some((tool) => tool.type === "function" && tool.name === "lookup"));
  assert.ok(prepared.body.tools.some((tool) => tool.type === "custom" && tool.name === "apply_patch"));
  assert.ok(prepared.body.tools.some((tool) => tool.type === "web_search"));
  const custom = prepared.plan.entries.find((entry) => entry.original.name === "exec");
  const namespaced = prepared.plan.entries.find((entry) => entry.original.namespace === "functions");
  assert.equal(custom.bridged, true);
  assert.equal(namespaced.bridged, true);
  assert.match(custom.upstreamName, /^cq_custom_/);
  assert.match(namespaced.upstreamName, /^cq_namespace_/);
  assert.deepEqual(prepared.body.tool_choice, { type: "function", name: custom.upstreamName });

  const converted = translateResponsesPayload({
    id: "resp",
    status: "completed",
    output: [
      { type: "function_call", name: custom.upstreamName, call_id: "raw", arguments: '{"input":"line 1\\nline 2"}' },
      { type: "function_call", name: namespaced.upstreamName, call_id: "thread", arguments: '{"id":"123"}' },
      { type: "function_call", name: "lookup", call_id: "lookup", arguments: "{}" },
    ],
  }, prepared.plan);
  assert.deepEqual(converted.output, [
    { type: "custom_tool_call", name: "exec", call_id: "raw", input: "line 1\nline 2" },
    { type: "function_call", name: "read_thread", namespace: "functions", call_id: "thread", arguments: '{"id":"123"}' },
    { type: "function_call", name: "lookup", call_id: "lookup", arguments: "{}" },
  ]);
});

test("Responses 转换后的 custom 工具调用和结果可以完整续接", () => {
  const first = prepareResponsesToolRequest({ model: "fixture", tools: [rawTool], input: "run" });
  const entry = first.plan.entries[0];
  const continuation = prepareResponsesToolRequest({
    model: "fixture",
    tools: [rawTool],
    input: [
      { type: "custom_tool_call", name: "exec", call_id: "call", input: "中文代码" },
      { type: "custom_tool_call_output", call_id: "call", output: "完成" },
    ],
  });
  assert.deepEqual(continuation.body.input, [
    {
      type: "function_call",
      name: entry.upstreamName,
      call_id: "call",
      arguments: '{"input":"中文代码"}',
    },
    { type: "function_call_output", call_id: "call", output: "完成" },
  ]);
});

test("Responses namespace 的强制选择在桥接时展开，原生时保持 namespace", () => {
  const bridged = prepareResponsesToolRequest({
    model: "fixture",
    tools: [namespaceTool],
    input: "read",
    tool_choice: { type: "namespace", name: "functions" },
  });
  assert.equal(bridged.body.tool_choice.type, "function");
  assert.match(bridged.body.tool_choice.name, /^cq_namespace_/);

  const native = prepareResponsesToolRequest({
    model: "fixture",
    tools: [namespaceTool],
    input: "read",
    tool_choice: { type: "namespace", name: "functions" },
  }, { nativeNamespaceTools: true });
  assert.deepEqual(native.body.tools, [namespaceTool]);
  assert.deepEqual(native.body.tool_choice, { type: "namespace", name: "functions" });
});

test("Responses allowed_tools 过滤不可用服务端工具并保留可用桥接工具", () => {
  const mixed = prepareResponsesToolRequest({
    model: "fixture",
    tools: [rawTool, { type: "web_search" }],
    input: "run",
    tool_choice: {
      type: "allowed_tools",
      mode: "required",
      tools: [
        { type: "custom", name: "exec" },
        { type: "web_search" },
      ],
    },
  }, { ignoredToolTypes: new Set(["web_search"]) });
  assert.equal(mixed.body.tools.some((tool) => tool.type === "web_search"), false);
  assert.deepEqual(mixed.body.tool_choice, {
    type: "allowed_tools",
    mode: "required",
    tools: [{ type: "function", name: mixed.plan.entries[0].upstreamName }],
  });

  const unavailableOnly = prepareResponsesToolRequest({
    model: "fixture",
    tools: [{ type: "web_search" }],
    input: "run",
    tool_choice: {
      type: "allowed_tools",
      mode: "auto",
      tools: [{ type: "web_search" }],
    },
  }, { ignoredToolTypes: new Set(["web_search"]) });
  assert.equal(Object.hasOwn(unavailableOnly.body, "tool_choice"), false);
});

test("Responses SSE 将桥接 function 还原成单个 custom 工具输入和终态", () => {
  const prepared = prepareResponsesToolRequest({ model: "fixture", tools: [rawTool], input: "run" });
  const name = prepared.plan.entries[0].upstreamName;
  const translator = createResponsesToolStreamTranslator(prepared.plan);
  const output = [];
  const accept = (type, value) => output.push(...translator.accept(type, { type, ...value }));
  accept("response.output_item.added", {
    output_index: 0,
    item: { id: "item", type: "function_call", name, call_id: "call", arguments: "" },
  });
  accept("response.function_call_arguments.delta", { item_id: "item", output_index: 0, delta: '{"input":"中' });
  accept("response.function_call_arguments.delta", { item_id: "item", output_index: 0, delta: '文"}' });
  accept("response.function_call_arguments.done", { item_id: "item", output_index: 0, arguments: '{"input":"中文"}' });
  accept("response.output_item.done", {
    output_index: 0,
    item: { id: "item", type: "function_call", name, call_id: "call", arguments: '{"input":"中文"}' },
  });
  accept("response.completed", {
    response: {
      id: "resp",
      status: "completed",
      output: [{ id: "item", type: "function_call", name, call_id: "call", arguments: '{"input":"中文"}' }],
    },
  });

  assert.equal(output.some((event) => event.data.type === "response.function_call_arguments.delta"), false);
  assert.equal(output.filter((event) => event.data.type === "response.custom_tool_call_input.delta").length, 1);
  assert.equal(output.find((event) => event.data.type === "response.custom_tool_call_input.done").data.input, "中文");
  assert.equal(output.find((event) => event.data.type === "response.output_item.done").data.item.type, "custom_tool_call");
  assert.equal(output.at(-1).data.response.output[0].input, "中文");
});
