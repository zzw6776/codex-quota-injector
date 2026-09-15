import assert from "node:assert/strict";
import test from "node:test";

import {
  MODEL_CAPABILITY_PROBE_TIMEOUT_MS,
  MODEL_CAPABILITY_PROBE_VERSION,
  probeModelCompatibility,
} from "../src/model-capability-probe.mjs";

const TARGET = {
  baseUrl: "https://provider.example/v1/",
  apiKey: "test-key",
  modelId: "test-model",
  now: () => 1234,
  imageChallenge: {
    dataUrl: "data:image/png;base64,fixture",
    prompt: "inspect fixture",
    expected: "red-blue",
  },
};

test("模型能力探测默认允许慢推理请求等待 30 秒", () => {
  assert.equal(MODEL_CAPABILITY_PROBE_TIMEOUT_MS, 30_000);
});

test("完整 Responses 能力必须逐项真实调用后才选择原生协议", async () => {
  const provider = capabilityProvider({
    responsesHistory: "full",
    customTools: "native",
    namespaceTools: "native",
    hostedWebSearch: "native",
    image: "supported",
  });
  const result = await probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch });

  assert.equal(result.protocol, "responses");
  assert.deepEqual(result.routes, { default: "responses", imageInput: "responses" });
  assert.equal(result.historyMode, "responses-full");
  assert.equal(result.codexConformance, "passed");
  assert.deepEqual(result.capabilities, {
    transport: { responses: "native", chat: "inconclusive" },
    streaming: "native",
    functionTools: "native",
    customTools: "native",
    namespaceTools: "native",
    nativeCustomTools: ["*"],
    parallelTools: "native",
    toolChoice: "native",
    reasoning: "native",
    reasoningToolChoice: "native",
    reasoningHistory: "native",
    imageInput: "native",
    hostedTools: { web_search: "native" },
  });
  assert.equal(result.supportsImage, true);
  assert.equal(result.probeVersion, MODEL_CAPABILITY_PROBE_VERSION);
  assert.deepEqual(result.reasoningEfforts, ["low", "medium", "high", "xhigh", "max"]);
  assert.ok(provider.requests.some(({ body }) =>
    body.tools?.some((tool) => tool.type === "custom")));
  assert.ok(provider.requests.some(({ body }) =>
    body.tools?.some((tool) => tool.type === "namespace")));
  assert.ok(provider.requests.some(({ body }) =>
    body.tools?.some((tool) => tool.type === "web_search")));
});

test("Responses 核心可用但仅原生支持 apply_patch 时保留 Responses 并局部转换工具", async () => {
  const provider = capabilityProvider({
    customTools: "apply-patch-only",
    namespaceTools: "ignored",
    hostedWebSearch: "native",
    image: "unsupported",
  });
  const result = await probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch });

  assert.equal(result.protocol, "responses");
  assert.equal(result.historyMode, "responses-full");
  assert.equal(result.capabilities.transport.responses, "native");
  assert.equal(result.capabilities.transport.chat, "native");
  assert.equal(result.capabilities.functionTools, "native");
  assert.equal(result.capabilities.customTools, "bridged");
  assert.equal(result.capabilities.namespaceTools, "bridged");
  assert.deepEqual(result.capabilities.nativeCustomTools, ["apply_patch"]);
  assert.equal(result.capabilities.hostedTools.web_search, "native");
  assert.equal(result.capabilities.imageInput, "unsupported");
  assert.equal(result.codexConformance, "passed");
  assert.deepEqual(result.routes, { default: "responses", imageInput: "responses" });
  assert.ok(provider.requests.some(({ body }) =>
    body.tools?.some((tool) => tool.type === "custom" && tool.name === "apply_patch")));
  assert.ok(provider.requests.some(({ body }) =>
    body.tools?.some((tool) => tool.type === "function" && /^cq_custom_/.test(tool.name))));
});

test("Responses 文本工具可用而图片不可用时自动验证并选择 Chat 图片路由", async () => {
  const provider = capabilityProvider({
    customTools: "native",
    namespaceTools: "native",
    imageByProtocol: { responses: "unsupported", chat: "supported" },
  });
  const result = await probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch });

  assert.equal(result.protocol, "responses");
  assert.deepEqual(result.routes, { default: "responses", imageInput: "chat" });
  assert.equal(result.supportsImage, true);
  assert.equal(result.capabilities.imageInput, "bridged");
  assert.equal(result.capabilities.transport.chat, "native");
  assert.ok(provider.requests.some(({ path, body }) =>
    path.endsWith("/chat/completions") && isImageRequest(body)));
});

test("组合验收使用 Codex 复杂引用 schema，并在发送前统一规范化", async () => {
  const provider = capabilityProvider({
    customTools: "native",
    namespaceTools: "native",
    image: "supported",
    rejectReferenceSiblings: true,
  });
  const result = await probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch });

  assert.equal(result.codexConformance, "passed");
  const conformance = provider.requests.find(({ body }) =>
    body.tools?.some((tool) =>
      tool.parameters?.properties?.value?.description === "Codex-style referenced tool parameter."));
  assert.ok(conformance, "探针必须编译与真实 Codex 同类的 $defs/$ref 工具 schema");
  assert.equal(hasReferenceSibling(conformance.body), false);
  assert.equal(hasReference(conformance.body), false);
});

test("Responses 不可用时通过 Chat 的工具、流式和组合请求检测", async () => {
  const provider = capabilityProvider({ responses: "missing", image: "unsupported" });
  const result = await probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch });

  assert.equal(result.protocol, "chat");
  assert.equal(result.capabilities.transport.responses, "unsupported");
  assert.equal(result.capabilities.transport.chat, "native");
  assert.equal(result.capabilities.streaming, "native");
  assert.equal(result.capabilities.customTools, "bridged");
  assert.equal(result.capabilities.namespaceTools, "bridged");
  assert.deepEqual(result.capabilities.nativeCustomTools, []);
});

test("Responses 核心可用但 custom 转换不可靠时自动选择通过完整验收的 Chat", async () => {
  const provider = capabilityProvider({
    customTools: "ignored",
    bridgedCustom: "invalid-arguments",
    image: "unsupported",
    imageByProtocol: null,
    rejectReferenceSiblings: false,
  });
  const result = await probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch });

  assert.equal(result.protocol, "chat");
  assert.equal(result.capabilities.transport.responses, "native");
  assert.equal(result.capabilities.transport.chat, "native");
  assert.equal(result.capabilities.customTools, "bridged");
  assert.equal(result.capabilities.namespaceTools, "bridged");
  assert.equal(result.codexConformance, "passed");
  assert.ok(provider.requests.some(({ path }) => path.endsWith("/responses")));
  assert.ok(provider.requests.some(({ path }) => path.endsWith("/chat/completions")));
});

test("Responses custom 转换遇到临时上游故障时不错误降级到 Chat", async () => {
  const provider = capabilityProvider({
    customTools: "ignored",
    bridgedCustom: "temporary-error",
  });
  await assert.rejects(
    probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch }),
    /Responses custom 工具转换检测失败：temporary unavailable/,
  );
  assert.equal(provider.requests.some(({ path }) => path.endsWith("/chat/completions")), false);
});

test("Chat 普通模式支持指定工具且推理模式只允许 auto 时分别记录能力", async () => {
  const provider = capabilityProvider({
    responses: "missing",
    thinkingByDefault: true,
    reasoningToolChoice: "auto-only",
    image: "unsupported",
  });
  const result = await probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch });

  assert.equal(result.protocol, "chat");
  assert.equal(result.capabilities.toolChoice, "native");
  assert.equal(result.capabilities.reasoning, "native");
  assert.equal(result.capabilities.reasoningToolChoice, "auto-only");
  assert.equal(result.supportsReasoning, true);
  assert.deepEqual(result.reasoningEfforts, ["low", "medium", "high", "xhigh", "max"]);
  assert.ok(provider.requests.some(({ body }) =>
    body.reasoning_effort === "none" && body.tool_choice?.function?.name === "codex_quota_capability_probe"),
  "普通模式必须真实验证指定工具选择");
  assert.ok(provider.requests.some(({ body }) =>
    body.reasoning_effort === "high" && body.tool_choice === "auto"),
  "推理模式必须真实验证自动工具选择");
});

test("推理参数未产生推理内容时不发布推理能力和强度", async () => {
  const provider = capabilityProvider({
    customTools: "native",
    bridgedCustom: "valid",
    namespaceTools: "native",
    reasoningEfforts: [],
    image: "supported",
  });
  const result = await probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch });

  assert.equal(result.capabilities.reasoning, "unsupported");
  assert.equal(result.capabilities.reasoningToolChoice, "unsupported");
  assert.equal(result.supportsReasoning, false);
  assert.deepEqual(result.reasoningEfforts, []);
});

test("reasoning 私有信封被拒绝后使用纯文本历史，且 tool_choice 能力独立记录", async () => {
  const provider = capabilityProvider({
    responsesHistory: "text-only",
    customTools: "native",
    namespaceTools: "native",
    rejectToolChoice: true,
    image: "supported",
  });
  const result = await probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch });

  assert.equal(result.protocol, "responses");
  assert.equal(result.historyMode, "reasoning-text-only");
  assert.equal(result.capabilities.toolChoice, "unsupported");
  assert.equal(result.capabilities.reasoningHistory, "bridged");
  const strippedContinuation = provider.requests.find(({ body }) =>
    Array.isArray(body.input) && body.input.some((item) => item?.type === "custom_tool_call_output"));
  assert.ok(strippedContinuation);
  assert.equal(strippedContinuation.body.input.some((item) => item?.encrypted_content), false);
});

test("没有实际产生 reasoning 项时不把推理历史能力误标为原生", async () => {
  const provider = capabilityProvider({
    responsesReasoning: false,
    customTools: "native",
    namespaceTools: "native",
    image: "supported",
  });
  const result = await probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch });

  assert.equal(result.protocol, "responses");
  assert.equal(result.capabilities.reasoningHistory, "inconclusive");
  assert.equal(result.historyMode, "reasoning-text-only");
});

test("基础工具请求不含 reasoning 时用推理工具续接检测选择纯文本历史", async () => {
  const provider = capabilityProvider({
    responsesReasoning: false,
    reasoningToolOutput: true,
    responsesHistory: "text-only",
    customTools: "native",
    namespaceTools: "native",
    image: "supported",
  });
  const result = await probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch });

  assert.equal(result.protocol, "responses");
  assert.equal(result.historyMode, "reasoning-text-only");
  assert.equal(result.capabilities.reasoningHistory, "bridged");
  const fullContinuation = provider.requests.find(({ body }) =>
    body.reasoning?.effort === "high" && Array.isArray(body.input) &&
    body.input.some((item) => item?.type === "function_call_output") &&
    body.input.some((item) => item?.encrypted_content));
  assert.ok(fullContinuation, "必须先真实提交完整推理历史");
  const strippedContinuation = provider.requests.find(({ body }) =>
    body.reasoning?.effort === "high" && Array.isArray(body.input) &&
    body.input.some((item) => item?.type === "function_call_output") &&
    body.input.some((item) => item?.type === "reasoning") &&
    !body.input.some((item) => item?.encrypted_content));
  assert.ok(strippedContinuation, "完整历史失败后必须真实验证纯文本历史");
});

test("推理历史续接默认提供 1024 Token 输出预算且不误降级历史格式", async () => {
  const provider = capabilityProvider({
    responsesReasoning: false,
    reasoningToolOutput: true,
    reasoningHistoryContinuation: "budget-once",
    customTools: "native",
    namespaceTools: "native",
    image: "supported",
  });
  const result = await probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch });

  assert.equal(result.protocol, "responses");
  assert.equal(result.historyMode, "responses-full");
  assert.equal(result.capabilities.reasoningHistory, "native");
  const continuations = provider.requests.filter(({ body }) =>
    body.reasoning?.effort === "high" && Array.isArray(body.input) &&
    body.input.some((item) => item?.type === "function_call_output"));
  assert.deepEqual(continuations.map(({ body }) => body.max_output_tokens), [1_024]);
  assert.ok(continuations.every(({ body }) => body.input.some((item) => item?.encrypted_content)),
    "输出预算不足不能触发 reasoning 历史降级");
});

test("Responses 工具结果后返回结构正确的下一次工具调用也算续接成功", async () => {
  const provider = capabilityProvider({
    responsesContinuation: "next-tool",
    customTools: "native",
    namespaceTools: "native",
    image: "supported",
  });
  const result = await probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch });

  assert.equal(result.protocol, "responses");
  assert.equal(result.codexConformance, "passed");
  assert.equal(result.capabilities.functionTools, "native");
});

test("Chat 工具结果后返回结构正确的下一次工具调用也算续接成功", async () => {
  const provider = capabilityProvider({
    responses: "missing",
    chatContinuation: "next-tool",
    image: "unsupported",
  });
  const result = await probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch });

  assert.equal(result.protocol, "chat");
  assert.equal(result.codexConformance, "passed");
  assert.equal(result.capabilities.functionTools, "native");
});

test("Responses 工具握手首次缺少有效后续输出时完整重试一次", async () => {
  const progress = [];
  const provider = capabilityProvider({
    responsesContinuation: "empty-once",
    customTools: "native",
    namespaceTools: "native",
    image: "supported",
  });
  const result = await probeModelCompatibility({
    ...TARGET,
    fetchImpl: provider.fetch,
    onProgress: (event) => progress.push(event),
  });

  assert.equal(result.protocol, "responses");
  assert.equal(result.codexConformance, "passed");
  assert.equal(provider.counts.responsesEmptyContinuations, 1);
  assert.equal(provider.counts.responsesCoreContinuations, 2);
  assert.ok(progress.some((event) => event.stage === "responses-retry" && event.retry));
  assert.deepEqual(progress.at(-1), {
    current: 8,
    total: 8,
    stage: "complete",
    message: "检测完成，正在整理能力结果",
    retry: false,
  });
});

test("Chat 工具握手首次缺少有效后续输出时完整重试一次", async () => {
  const provider = capabilityProvider({
    responses: "missing",
    chatContinuation: "empty-once",
    image: "unsupported",
  });
  const result = await probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch });

  assert.equal(result.protocol, "chat");
  assert.equal(result.codexConformance, "passed");
  assert.equal(provider.counts.chatEmptyContinuations, 1);
  assert.equal(provider.counts.chatCoreContinuations, 2);
});

test("并行工具的临时故障记录为 inconclusive 且不跳过组合验收", async () => {
  const provider = capabilityProvider({
    customTools: "native",
    namespaceTools: "native",
    parallelTools: "temporary-error",
    image: "supported",
  });
  const result = await probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch });

  assert.equal(result.capabilities.parallelTools, "inconclusive");
  assert.equal(result.codexConformance, "passed");
});

test("认证、限流和网络失败不会被误判为另一个协议", async () => {
  let requests = 0;
  await assert.rejects(
    probeModelCompatibility({
      ...TARGET,
      fetchImpl: async () => {
        requests += 1;
        return jsonResponse({ error: { message: "invalid key" } }, 401);
      },
    }),
    /Responses 能力检测失败：invalid key/,
  );
  assert.equal(requests, 1);
});

test("图片检测的临时上游故障不会被保存成不支持", async () => {
  const provider = capabilityProvider({
    customTools: "native",
    namespaceTools: "native",
    parallelTools: "native",
    image: "temporary-error",
  });
  await assert.rejects(
    probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch }),
    /图片能力检测失败：temporary unavailable/,
  );
});

test("图片首次答案未命中时必须再次校验，不能因 HTTP 200 直接通过", async () => {
  let imageAttempt = 0;
  const provider = capabilityProvider({
    customTools: "native",
    namespaceTools: "native",
    image: () => {
      imageAttempt += 1;
      return imageAttempt === 1 ? "ambiguous" : "supported";
    },
  });
  const result = await probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch });

  assert.equal(result.supportsImage, true);
  assert.equal(result.imageStatus, "supported");
  assert.equal(result.capabilities.imageInput, "native");
  assert.equal(imageAttempt, 2);
});

test("生产探针的四颜色图片必须按实际内容校验通过", async () => {
  const provider = capabilityProvider({
    customTools: "native",
    namespaceTools: "native",
    image: "four-colors",
  });
  const result = await probeModelCompatibility({
    ...TARGET,
    imageChallenge: {
      ...TARGET.imageChallenge,
      expected: "red-yellow-blue-green",
    },
    fetchImpl: provider.fetch,
  });

  assert.equal(result.supportsImage, true);
  assert.equal(result.imageStatus, "supported");
  assert.equal(result.capabilities.imageInput, "native");
});

test("图片连续返回 HTTP 200 但内容校验失败时判定不支持而不影响其他能力", async () => {
  let imageAttempt = 0;
  const provider = capabilityProvider({
    customTools: "native",
    namespaceTools: "native",
    image: () => {
      imageAttempt += 1;
      return "ambiguous";
    },
  });

  const result = await probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch });

  assert.equal(result.supportsImage, false);
  assert.equal(result.imageStatus, "unsupported");
  assert.equal(result.capabilities.imageInput, "unsupported");
  assert.match(result.imageDetail, /连续两次图片请求成功/);
  assert.equal(result.codexConformance, "passed");
  assert.equal(imageAttempt, 4, "Responses 与 Chat 图片链路必须各自完成两次内容校验");
});

test("HTTP 200 错误包络仍按失败处理并移除不兼容的指定 tool_choice", async () => {
  const provider = capabilityProvider({
    responses: "missing",
    rejectSpecifiedToolChoiceWithSuccessStatus: true,
    image: "unsupported",
  });
  const result = await probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch });

  assert.equal(result.protocol, "chat");
  assert.equal(result.capabilities.toolChoice, "unsupported");
  assert.equal(result.codexConformance, "passed");
  const chatRequests = provider.requests.filter(({ path }) => path.endsWith("/chat/completions"));
  assert.ok(chatRequests.some(({ body }) => body.tool_choice?.function?.name === "codex_quota_capability_probe"));
  assert.ok(chatRequests.some(({ body }) =>
    body.tools?.length === 3 && body.tool_choice == null));
});

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
