import assert from "node:assert/strict";
import { probeModelCompatibility } from "../../src/model-capability-probe.mjs";

const TARGET = {
  baseUrl: "https://provider.example/v1/",
  apiKey: "test-key",
  modelId: "test-model",
  now: () => 1234,
  retryDelayMs: 0,
  imageChallenge: {
    dataUrl: "data:image/png;base64,fixture",
    prompt: "inspect fixture",
    expected: "red-blue",
  },
};

// Reproduce a provider returning only reasoning, including budget-truncated replies.
function imageReasoningReply(protocol, { reasoning = "", answer = "", exhausted = true } = {}) {
  return protocol === "chat"
    ? jsonResponse({ choices: [{ message: { content: answer, reasoning_content: reasoning },
        finish_reason: exhausted ? "length" : "stop" }] })
    : jsonResponse({ status: exhausted ? "incomplete" : "completed",
        ...(exhausted ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
        output: [
          { type: "reasoning", content: [{ type: "reasoning_text", text: reasoning }] },
          ...(answer ? [message(answer)] : []),
        ] });
}

async function probeWithImageReplies(protocol, reply) {
  const provider = capabilityProvider({ responses: protocol === "chat" ? "missing" : "available" });
  const images = [];
  const result = await probeModelCompatibility({ ...TARGET, fetchImpl: (url, init) => {
    const body = JSON.parse(init.body);
    if (!isImageRequest(body)) return provider.fetch(url, init);
    const route = new URL(url).pathname.endsWith("/responses") ? "responses" : "chat";
    images.push({ route, body });
    assert.equal(route === "chat" ? body.max_tokens : body.max_output_tokens, 256);
    assert.equal(body.thinking, undefined, "图片检测不得自动关闭推理");
    assert.equal(body.reasoning, undefined, "图片检测不得自动切换推理设置");
    return reply(route, images);
  } });
  return { result, images };
}

function capabilityProvider(options = {}) {
  const config = {
    responses: "available",
    responsesHistory: "full",
    responsesReasoning: true,
    responsesContinuation: "terminal",
    reasoningToolOutput: false,
    reasoningHistoryContinuation: "completed",
    customTools: "native",
    namespaceTools: "native",
    hostedWebSearch: "ignored",
    image: "unsupported",
    rejectToolChoice: false,
    rejectSpecifiedToolChoiceWithSuccessStatus: false,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    reasoningToolChoice: "native",
    chatContinuation: "terminal",
    thinkingByDefault: false,
    ...options,
  };
  const requests = [];
  const counts = {
    responsesCoreContinuations: 0,
    responsesEmptyContinuations: 0,
    chatCoreContinuations: 0,
    chatEmptyContinuations: 0,
  };
  const fetch = async (url, init) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body);
    requests.push({ path, body });
    if (path.endsWith("/responses")) return responseFixture(body, config, counts);
    if (path.endsWith("/chat/completions")) return chatFixture(body, config, counts);
    return jsonResponse({ error: { message: "not found" } }, 404);
  };
  return { fetch, requests, counts };
}

function responseFixture(body, config, counts) {
  if (config.responses === "missing") {
    return jsonResponse({ error: { message: "responses endpoint not found" } }, 404);
  }
  if (config.rejectReferenceSiblings && hasReferenceSibling(body.tools)) {
    return jsonResponse({ error: { message: "tools.function.parameters is not a valid moonshot flavored json schema" } }, 400);
  }
  if (isImageRequest(body)) return imageResponse(imageMode(config, "responses"), "responses");
  if (body.stream) {
    return new Response([
      "event: response.created",
      'data: {"type":"response.created"}',
      "",
      "event: response.completed",
      'data: {"type":"response.completed","response":{"status":"completed"}}',
      "",
    ].join("\n"), { headers: { "content-type": "text/event-stream" } });
  }
  if (config.rejectToolChoice && body.tool_choice != null) {
    return jsonResponse({ error: { message: "Thinking mode does not support this tool_choice" } }, 400);
  }
  const tools = body.tools ?? [];
  const effort = body.reasoning?.effort;
  if (effort && effort !== "none" && tools.length === 0) {
    return config.reasoningEfforts.includes(effort)
      ? jsonResponse({
          status: "completed",
          output: [reasoningItem(), message("OK")],
          usage: { output_tokens_details: { reasoning_tokens: 2 } },
        })
      : jsonResponse({ error: { message: `reasoning effort ${effort} is unsupported` } }, 400);
  }
  if (effort && effort !== "none" && typeof body.tool_choice === "object" &&
    config.reasoningToolChoice === "auto-only") {
    return jsonResponse({ error: { message: "Thinking mode does not support this tool_choice" } }, 400);
  }
  if (tools.length >= 3) {
    return jsonResponse({ status: "completed", output: [{
      type: "function_call",
      name: "codex_quota_capability_probe",
      call_id: "conformance-call",
      arguments: '{"value":"codex-conformance"}',
    }] });
  }
  if (tools.some((tool) => tool.type === "web_search")) {
    return config.hostedWebSearch === "native"
      ? jsonResponse({ status: "completed", output: [{ type: "web_search_call", id: "web", status: "completed" }] })
      : jsonResponse({ status: "completed", output: [message("web search unavailable")] });
  }
  if (tools.length === 1 && tools[0]?.type === "custom") {
    if (hasInputType(body, "custom_tool_call_output")) return jsonResponse({ status: "completed", output: [message("continued")] });
    if (config.customTools === "native" ||
      (config.customTools === "apply-patch-only" && tools[0].name === "apply_patch")) {
      const input = tools[0].name === "apply_patch"
        ? "*** Begin Patch\n*** End Patch"
        : "CUSTOM-PROBE";
      return jsonResponse({ status: "completed", output: [
      ...(config.responsesReasoning ? [reasoningItem()] : []),
      { type: "custom_tool_call", name: tools[0].name, call_id: "custom-call", input },
    ] });
    }
    if (config.customTools === "wrong-shape") return jsonResponse({ status: "completed", output: [
      reasoningItem(),
      { type: "function_call", name: tools[0].name, call_id: "wrong-call", arguments: "{}" },
    ] });
    return jsonResponse({ status: "completed", output: [message("ignored custom tool")] });
  }
  if (tools.length === 1 && tools[0]?.type === "namespace") {
    if (hasInputType(body, "function_call_output")) return jsonResponse({ status: "completed", output: [message("continued")] });
    if (config.namespaceTools === "native") return jsonResponse({ status: "completed", output: [
      ...(config.responsesReasoning ? [reasoningItem()] : []),
      {
        type: "function_call",
        name: tools[0].tools[0].name,
        namespace: tools[0].name,
        call_id: "namespace-call",
        arguments: '{"value":"namespace-probe"}',
      },
    ] });
    return jsonResponse({ status: "completed", output: [message("ignored namespace tool")] });
  }
  if (hasInputType(body, "function_call_output")) {
    counts.responsesCoreContinuations += 1;
    const hasPrivateReasoning = body.input.some((item) =>
      item?.type === "reasoning" && (item.summary || item.encrypted_content));
    if (config.responsesHistory === "text-only" && hasPrivateReasoning) {
      return jsonResponse({ error: { message: "encrypted_content is unsupported" } }, 400);
    }
    if (body.reasoning?.effort &&
      config.reasoningHistoryContinuation === "budget-once" &&
      body.max_output_tokens < 1_024) {
      return jsonResponse({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [{ ...reasoningItem(), status: "incomplete" }],
      });
    }
    if (config.responsesContinuation === "next-tool") {
      return jsonResponse({ status: "completed", output: [{
        type: "function_call",
        status: "completed",
        name: "codex_quota_capability_probe",
        call_id: "continued-function-call",
        arguments: '{"value":"continued"}',
      }] });
    }
    if (config.responsesContinuation === "empty-once" &&
      counts.responsesEmptyContinuations === 0) {
      counts.responsesEmptyContinuations += 1;
      return jsonResponse({ status: "completed", output: [reasoningItem()] });
    }
    return jsonResponse({ status: "completed", output: [message("continued")] });
  }
  if (tools.length === 1 && tools[0]?.type === "function" && /^cq_custom_/.test(tools[0].name)) {
    if (config.bridgedCustom === "temporary-error") {
      return jsonResponse({ error: { message: "temporary unavailable" } }, 503);
    }
    return jsonResponse({ status: "completed", output: [{
      type: "function_call",
      name: tools[0].name,
      call_id: "bridged-custom-call",
      arguments: config.bridgedCustom === "invalid-arguments"
        ? "{}"
        : '{"input":"CUSTOM-PROBE"}',
    }] });
  }
  if (tools.length === 1 && tools[0]?.type === "function" && /^cq_namespace_/.test(tools[0].name)) {
    return jsonResponse({ status: "completed", output: [{
      type: "function_call",
      name: tools[0].name,
      call_id: "bridged-namespace-call",
      arguments: '{"value":"namespace-probe"}',
    }] });
  }
  if (tools.some((tool) => tool.name === "codex_quota_parallel_left")) {
    if (config.parallelTools === "temporary-error") {
      return jsonResponse({ error: { message: "parallel temporarily unavailable" } }, 503);
    }
    return jsonResponse({ status: "completed", output: tools.map((tool, index) => ({
      type: "function_call",
      name: tool.name,
      call_id: `parallel-${index}`,
      arguments: '{"value":"parallel-probe"}',
    })) });
  }
  return jsonResponse({ status: "completed", output: [
    ...(config.responsesReasoning ||
      (effort && effort !== "none" && config.reasoningToolOutput)
      ? [reasoningItem()]
      : []),
    {
      type: "function_call",
      name: "codex_quota_capability_probe",
      call_id: "function-call",
      arguments: '{"value":"probe"}',
    },
  ] });
}

function chatFixture(body, config, counts) {
  if (config.rejectReferenceSiblings && hasReferenceSibling(body.tools)) {
    return jsonResponse({ error: { message: "tools.function.parameters is not a valid moonshot flavored json schema" } }, 400);
  }
  if (isImageRequest(body)) return imageResponse(imageMode(config, "chat"), "chat");
  if (body.stream) {
    return new Response([
      'data: {"id":"chat-stream","choices":[{"delta":{"content":"OK"}}]}',
      "",
      'data: {"id":"chat-stream","choices":[{"delta":{},"finish_reason":"stop"}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"), { headers: { "content-type": "text/event-stream" } });
  }
  if (config.rejectToolChoice && body.tool_choice != null) {
    return jsonResponse({ error: { message: "Thinking mode does not support this tool_choice" } }, 400);
  }
  if (config.rejectSpecifiedToolChoiceWithSuccessStatus && typeof body.tool_choice === "object") {
    return jsonResponse({ error: { message: "tool_choice 'specified' is incompatible with thinking enabled" } });
  }
  const tools = body.tools ?? [];
  const effort = body.reasoning_effort;
  const reasoningEnabled = effort ? effort !== "none" : config.thinkingByDefault;
  if (reasoningEnabled && typeof body.tool_choice === "object" &&
    config.reasoningToolChoice === "auto-only") {
    return jsonResponse({ error: { message: "Thinking mode does not support this tool_choice" } }, 400);
  }
  if (effort && effort !== "none" && tools.length === 0) {
    return config.reasoningEfforts.includes(effort)
      ? jsonResponse({ choices: [{ message: {
          role: "assistant",
          content: "OK",
          reasoning_content: `reasoning-${effort}`,
        }, finish_reason: "stop" }], usage: {
          completion_tokens_details: { reasoning_tokens: 2 },
        } })
      : jsonResponse({ error: { message: `reasoning effort ${effort} is unsupported` } }, 400);
  }
  if (body.messages?.some((item) => item.role === "tool")) {
    counts.chatCoreContinuations += 1;
    if (config.chatContinuation === "next-tool") {
      return jsonResponse({ choices: [{ message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "continued-chat-call",
          type: "function",
          function: { name: "codex_quota_capability_probe", arguments: '{"value":"continued"}' },
        }],
      }, finish_reason: "tool_calls" }] });
    }
    if (config.chatContinuation === "empty-once" && counts.chatEmptyContinuations === 0) {
      counts.chatEmptyContinuations += 1;
      return jsonResponse({ choices: [{ message: {
        role: "assistant",
        content: "",
        reasoning_content: "reasoning without a usable continuation",
      }, finish_reason: "stop" }] });
    }
    return jsonResponse({ choices: [{ message: { role: "assistant", content: "continued" }, finish_reason: "stop" }] });
  }
  const names = tools.map((tool) => tool.function?.name);
  if (names.includes("codex_quota_parallel_left") && config.parallelTools === "temporary-error") {
    return jsonResponse({ error: { message: "parallel temporarily unavailable" } }, 503);
  }
  const selectedNames = names.includes("codex_quota_parallel_left")
    ? ["codex_quota_parallel_left", "codex_quota_parallel_right"]
    : ["codex_quota_capability_probe"];
  return jsonResponse({ choices: [{ message: {
    role: "assistant",
    content: null,
    tool_calls: selectedNames.map((name, index) => ({
      id: `chat-call-${index}`,
      type: "function",
      function: { name, arguments: '{"value":"probe"}' },
    })),
  }, finish_reason: "tool_calls" }] });
}

function imageResponse(mode, protocol) {
  if (typeof mode === "function") return imageResponse(mode(), protocol);
  if (mode === "temporary-error") {
    return jsonResponse({ error: { message: "temporary unavailable" } }, 503);
  }
  if (mode === "supported") {
    return protocol === "responses"
      ? jsonResponse({ output: [message("red-blue")] })
      : jsonResponse({ choices: [{ message: { content: "red-blue" } }] });
  }
  if (mode === "four-colors") {
    return protocol === "responses"
      ? jsonResponse({ output: [message("The panels are red-yellow-blue-green.\nred-yellow-blue-green")] })
      : jsonResponse({ choices: [{ message: { content: "The panels are red-yellow-blue-green.\nred-yellow-blue-green" } }] });
  }
  if (mode === "ambiguous") {
    return protocol === "responses"
      ? jsonResponse({ output: [message("The picture contains two colored panels.")] })
      : jsonResponse({ choices: [{ message: { content: "The picture contains two colored panels." } }] });
  }
  return jsonResponse({ error: { message: "image modality is unsupported" } }, 400);
}

function imageMode(config, protocol) {
  return config.imageByProtocol?.[protocol] ?? config.image;
}

function isImageRequest(body) {
  const serialized = JSON.stringify(body);
  return serialized.includes("input_image") || serialized.includes("image_url");
}

function hasReferenceSibling(value) {
  if (Array.isArray(value)) return value.some(hasReferenceSibling);
  if (!value || typeof value !== "object") return false;
  if ((Object.hasOwn(value, "$ref") || Object.hasOwn(value, "$dynamicRef")) &&
    Object.keys(value).length > 1) return true;
  return Object.values(value).some(hasReferenceSibling);
}

function hasReference(value) {
  if (Array.isArray(value)) return value.some(hasReference);
  if (!value || typeof value !== "object") return false;
  if (Object.hasOwn(value, "$ref") || Object.hasOwn(value, "$dynamicRef")) return true;
  return Object.values(value).some(hasReference);
}

function hasInputType(body, type) {
  return Array.isArray(body.input) && body.input.some((item) => item?.type === type);
}

function reasoningItem() {
  return {
    type: "reasoning",
    reasoning_text: "visible reasoning",
    summary: [{ type: "summary_text", text: "private" }],
    encrypted_content: "opaque",
  };
}

function message(text) {
  return { type: "message", role: "assistant", content: [{ type: "output_text", text }] };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export { TARGET, capabilityProvider, isImageRequest, jsonResponse, hasReferenceSibling, hasReference, imageReasoningReply, probeWithImageReplies };
