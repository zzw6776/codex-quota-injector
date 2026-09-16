import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
import {
  prepareResponsesToolRequest,
  translateResponsesPayload,
} from "./responses-tool-adapter.mjs";
import { normalizeToolParametersSchema } from "./tool-schema-compat.mjs";

export const MODEL_CAPABILITY_PROBE_VERSION = 15;
export const MODEL_CAPABILITY_PROBE_TIMEOUT_MS = 90_000;

const CONTINUATION_OUTPUT_TOKENS = 1_024;
const IMAGE_OUTPUT_TOKENS = 256;
const PROBE_TOOL_NAME = "codex_quota_capability_probe";
const PROBE_CUSTOM_TOOL_NAME = "codex_quota_custom_probe";
const PROBE_APPLY_PATCH_TOOL_NAME = "apply_patch";
const PROBE_NAMESPACE_NAME = "codex_quota_namespace";
const PROBE_NAMESPACE_TOOL_NAME = "codex_quota_namespace_probe";
const PROBE_PARALLEL_TOOL_NAMES = ["codex_quota_parallel_left", "codex_quota_parallel_right"];
const PROBE_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const TOOL_DEFINITION = {
  type: "function",
  name: PROBE_TOOL_NAME,
  description: "Return the supplied value so the client can verify tool-result continuation.",
  parameters: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
};
const CODEX_CONFORMANCE_TOOL_DEFINITION = {
  ...TOOL_DEFINITION,
  parameters: {
    type: "object",
    $defs: {
      codex_probe_value: { type: "string" },
      __schema20: {
        $ref: "#/$defs/codex_probe_value",
        type: "string",
        description: "Codex-style referenced tool parameter.",
      },
    },
    properties: { value: { $ref: "#/$defs/__schema20" } },
    required: ["value"],
    additionalProperties: false,
  },
};

export async function probeModelCompatibility({
  baseUrl,
  apiKey,
  modelId,
  fetchImpl = fetch,
  timeoutMs = MODEL_CAPABILITY_PROBE_TIMEOUT_MS,
  retryDelayMs = 500,
  now = Date.now,
  imageChallenge = null,
  onProgress = null,
  onDiagnostic = null,
} = {}) {
  const target = normalizeTarget({ baseUrl, apiKey, modelId });
  const reportProgress = createProbeProgressReporter(onProgress);
  const warnings = [];
  let requestSequence = 0;
  const diagnostic = record => {
    if (typeof onDiagnostic !== "function") return;
    try {
      const safe = JSON.stringify(record, (_key, value) => typeof value === "string"
        ? value.replaceAll(target.apiKey, "[凭据已隐藏]")
          .replace(/data:image\/[^\s"<>]+/gi, "[图片内容已隐藏]").slice(0, 512)
        : value);
      onDiagnostic(JSON.parse(safe));
    } catch { /* Diagnostics must not change probe results. */ }
  };
  const withRetry = async (send) => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await send(attempt);
      if (response.ok || !isRetryableProbeFailure(response)) return response;
      if (attempt === 3) {
        warnings.push(`${reportProgress.stage()}：连续 3 次请求失败，暂不可用（${response.message}）`);
        return { ...response, retryExhausted: true };
      }
      reportProgress.retry(`请求失败：${response.message}；正在重试（${attempt + 1}/3，每次最多 ${Math.ceil(timeoutMs / 1000)} 秒）`);
      diagnostic({ event: "request-retry", sequence: requestSequence, stage: reportProgress.stage(),
        nextAttempt: attempt + 1, delayMs: attempt * Math.max(0, retryDelayMs), error: response.message });
      await new Promise(resolve => setTimeout(resolve, attempt * Math.max(0, retryDelayMs)));
    }
  };
  const send = (path, body, stream) => withRetry(async attempt => {
    const started = Date.now();
    const info = { sequence: ++requestSequence, stage: reportProgress.stage(),
      protocol: path === "responses" ? "responses" : "chat", stream, attempt,
      startedAt: new Date(started).toISOString(), timeoutMs,
      outputBudget: body.max_output_tokens ?? body.max_tokens ?? null,
      reasoningEffort: body.reasoning?.effort ?? body.reasoning_effort ?? null,
      thinkingMode: body.thinking?.type ?? "default" };
    diagnostic({ event: "request-start", ...info });
    const response = await (stream ? postStream : postJson)({
      url: new URL(path, target.baseUrl), apiKey: target.apiKey, body, timeoutMs,
      fetchImpl: async (...args) => {
        const reply = await fetchImpl(...args);
        info.headersMs = Date.now() - started;
        info.httpStatus = reply.status;
        info.providerRequestId = reply.headers?.get?.("x-request-id") ?? reply.headers?.get?.("request-id") ?? null;
        info.contentType = reply.headers?.get?.("content-type") ?? null;
        diagnostic({ event: "response-headers", ...info });
        return reply;
      },
    });
    if (typeof onDiagnostic === "function") {
      // Malformed provider output or diagnostic callbacks cannot affect capability decisions.
      try {
        diagnostic({ event: "request-end", ...info, elapsedMs: Date.now() - started,
          httpStatus: info.httpStatus ?? null, ok: response.ok, error: response.message,
          failurePhase: response.ok ? null : response.status === 0
            ? info.headersMs == null ? "connection" : "body" : "provider",
          ...summarizeProbeResponse(response, info.protocol) });
      } catch {
        diagnostic({ event: "request-end", ...info, elapsedMs: Date.now() - started,
          ok: response.ok, error: response.message, summaryUnavailable: true });
      }
    }
    return response;
  });
  const request = (path, body) => send(path, body, false);
  const requestStream = (path, body) => send(path, body, true);
  const imageDiagnostic = record => diagnostic({ ...record, stage: reportProgress.stage(), sequence: requestSequence });

  reportProgress(1, "responses", "正在验证 Responses 连接与工具续接");
  const responses = await runProtocolProbeWithRetry(
    () => probeResponses(request, target.modelId),
    {
      onRetry: () => reportProgress(
        1,
        "responses-retry",
        "Responses 首次结果不稳定，正在完整重试",
        { retry: true },
      ),
    },
  );
  if (!responses.ok && !canTryAlternateProtocol(responses.failure)) {
    throw probeError("Responses 能力检测失败", responses.failure);
  }

  let responsesFailure = responses.failure ?? null;
  let responsesCustom = unavailableProbe(responses.failure);
  let responsesNamespace = unavailableProbe(responses.failure);
  let nativeCustomTools = [];
  if (responses.ok) {
    reportProgress(2, "responses-tools", "正在验证 Responses 的 Codex 工具格式");
    const rawCustom = await probeResponsesCustom(request, target.modelId, responses.historyMode);
    if (rawCustom.state === "native") {
      responsesCustom = rawCustom;
      nativeCustomTools = ["*"];
    } else {
      const rawApplyPatch = await probeResponsesCustom(
        request,
        target.modelId,
        responses.historyMode,
        {
          name: PROBE_APPLY_PATCH_TOOL_NAME,
          rawInput: "*** Begin Patch\n*** End Patch",
        },
      );
      if (rawApplyPatch.state === "native") nativeCustomTools.push(PROBE_APPLY_PATCH_TOOL_NAME);
      const bridgeRequest = createResponsesBridgeRequest(request, { nativeCustomTools });
      const bridged = await probeResponsesCustom(
        bridgeRequest,
        target.modelId,
        responses.historyMode,
      );
      if (bridged.state !== "native") {
        responsesFailure = bridged.failure ?? rawCustom.failure;
        if (!canTryAlternateProtocol(responsesFailure)) {
          throw probeError("Responses custom 工具转换检测失败", responsesFailure);
        }
      } else {
        responsesCustom = { state: "bridged", toolChoice: bridged.toolChoice };
      }
    }

    if (!responsesFailure) {
      const rawNamespace = await probeResponsesNamespace(request, target.modelId, responses.historyMode);
      if (rawNamespace.state === "native") {
        responsesNamespace = rawNamespace;
      } else {
        const bridgeRequest = createResponsesBridgeRequest(request, {
          nativeCustomTools,
          nativeNamespaceTools: false,
        });
        const bridged = await probeResponsesNamespace(
          bridgeRequest,
          target.modelId,
          responses.historyMode,
        );
        if (bridged.state !== "native") {
          responsesFailure = bridged.failure ?? rawNamespace.failure;
          if (!canTryAlternateProtocol(responsesFailure)) {
            throw probeError("Responses namespace 工具转换检测失败", responsesFailure);
          }
        } else {
          responsesNamespace = { state: "bridged", toolChoice: bridged.toolChoice };
        }
      }
    }
  }

  let responsesCodexReady = responses.ok && !responsesFailure;
  let hostedWebSearch = { state: "unsupported", toolChoice: "inconclusive" };
  let streaming = null;
  let parallelTools = null;
  if (responsesCodexReady) {
    reportProgress(3, "responses-conformance", "正在验证流式输出、并行工具和组合请求");
    hostedWebSearch = await probeHostedWebSearch(request, target.modelId);
    try {
      streaming = await probeStreaming(requestStream, target.modelId, "responses");
      parallelTools = await probeParallelTools(
        request,
        target.modelId,
        "responses",
        responses.toolChoice,
        responses.toolChoiceRequestFields,
      );
      await probeCodexConformance(
        request,
        target.modelId,
        "responses",
        responses.toolChoice,
        hostedWebSearch.state,
        parallelTools,
        responses.toolChoiceRequestFields,
        {
          customTools: responsesCustom.state,
          namespaceTools: responsesNamespace.state,
          nativeCustomTools,
        },
      );
    } catch (error) {
      if (!canTryAlternateAfterProbeError(error)) throw error;
      responsesFailure = contractFailure(422, error.message);
      responsesCodexReady = false;
      hostedWebSearch = { state: "unsupported", toolChoice: "inconclusive" };
      streaming = null;
      parallelTools = null;
    }
  }

  let chat = null;
  if (!responsesCodexReady) {
    reportProgress(3, "chat", "Responses 不适用，正在验证 Chat 工具续接");
    chat = await runProtocolProbeWithRetry(
      () => probeChat(request, target.modelId),
      {
        onRetry: () => reportProgress(
          3,
          "chat-retry",
          "Chat 首次结果不稳定，正在完整重试",
          { retry: true },
        ),
      },
    );
    if (!chat.ok) {
      throw probeError(
        "模型无法承接 Codex 工具：Responses 兼容链与 Chat 工具续接均未通过",
        chat.failure,
        responsesFailure,
      );
    }
  }

  const protocol = responsesCodexReady ? "responses" : "chat";
  let historyMode = protocol === "responses" ? responses.historyMode : "chat";
  const selectedToolChoice = protocol === "responses"
    ? responses.toolChoice
    : chat.toolChoice;
  const toolChoiceRequestFields = protocol === "responses"
    ? responses.toolChoiceRequestFields
    : chat.toolChoiceRequestFields;
  const effectiveHostedWebSearch = protocol === "responses"
    ? hostedWebSearch.state
    : "unsupported";
  reportProgress(4, "reasoning", "正在检测推理能力与可用强度");
  const reasoning = await probeReasoning(request, target.modelId, protocol, {
    onEffort: (effort) => reportProgress(
      4,
      "reasoning",
      `正在检测推理强度 ${effort}`,
    ),
  });
  reportProgress(5, "reasoning-history", "正在验证推理工具与历史续接");
  const reasoningToolChoice = reasoning.efforts.length > 0
    ? await probeReasoningToolChoice(
        request,
        target.modelId,
        protocol,
        reasoning.efforts.includes("high") ? "high" : reasoning.efforts[0],
      )
    : "unsupported";
  let reasoningHistory = protocol === "responses"
    ? responses.reasoningHistory
    : "bridged";
  if (protocol === "responses" && reasoning.state === "native" &&
    reasoningHistory === "inconclusive") {
    const historyProbe = await probeResponsesReasoningHistory(
      request,
      target.modelId,
      reasoning.efforts.includes("high") ? "high" : reasoning.efforts[0],
      reasoningToolChoice,
    );
    historyMode = historyProbe.historyMode;
    reasoningHistory = historyProbe.state;
  }
  if (protocol === "chat") {
    reportProgress(6, "chat-conformance", "正在验证 Chat 流式输出、并行工具和组合请求");
    streaming = await probeStreaming(requestStream, target.modelId, protocol);
    parallelTools = await probeParallelTools(
      request,
      target.modelId,
      protocol,
      selectedToolChoice,
      toolChoiceRequestFields,
    );
    await probeCodexConformance(
      request,
      target.modelId,
      protocol,
      selectedToolChoice,
      effectiveHostedWebSearch,
      parallelTools,
      toolChoiceRequestFields,
      {
        customTools: responsesCustom.state,
        namespaceTools: responsesNamespace.state,
        nativeCustomTools,
      },
    );
  }

  const imageChallengeFactory = typeof imageChallenge === "function"
    ? imageChallenge
    : imageChallenge
      ? () => imageChallenge
      : createImageChallenge;
  reportProgress(7, "image", "正在检测图片理解能力");
  let imageProtocol = protocol;
  let image = await probeImage(request, target.modelId, protocol, imageChallengeFactory, imageDiagnostic);
  if (protocol === "responses" && image.supportsImage !== true) {
    reportProgress(7, "image-chat-route", "Responses 图片未验证通过，正在验证 Chat 图片链路");
    const alternate = await probeAlternateChatImageRoute({
      request,
      requestStream,
      modelId: target.modelId,
      responsesTools: {
        customTools: responsesCustom.state,
        namespaceTools: responsesNamespace.state,
        nativeCustomTools,
      },
      onRetry: () => reportProgress(
        7,
        "image-chat-route-retry",
        "Chat 图片链路首次结果不稳定，正在完整重试",
        { retry: true },
      ),
    });
    if (alternate.ok) {
      chat = alternate.chat;
      const chatImage = await probeImage(
        request,
        target.modelId,
        "chat",
        imageChallengeFactory,
        imageDiagnostic,
      );
      if (chatImage.supportsImage) {
        imageProtocol = "chat";
        image = {
          ...chatImage,
          detail: "Responses 图片链路未通过，已由 Chat 图片链路验证",
        };
      } else {
        image = {
          ...chatImage,
          // Neither route succeeded. An unfinished route cannot be turned
          // into confirmed non-support by the other route's rejection.
          ...(image.status === "inconclusive"
            ? { supportsImage: null, status: "inconclusive" }
            : {}),
          detail: [
            image.detail ? `Responses：${image.detail}` : null,
            chatImage.detail ? `Chat：${chatImage.detail}` : null,
          ].filter(Boolean).join("；") || null,
        };
      }
    }
  }
  reportProgress(8, "complete", "检测完成，正在整理能力结果");
  const responseTransport = responses.ok ? "native" : capabilityFromFailure(responses.failure);
  const chatTransport = chat?.ok ? "native" : "inconclusive";
  return {
    status: "verified",
    protocol,
    routes: { default: protocol, imageInput: imageProtocol },
    historyMode,
    toolContinuation: true,
    supportsImage: image.supportsImage,
    imageStatus: image.status,
    imageDetail: image.detail,
    warnings,
    supportsReasoning: reasoning.state === "native",
    reasoningEfforts: reasoning.efforts,
    capabilities: {
      transport: { responses: responseTransport, chat: chatTransport },
      streaming,
      functionTools: "native",
      customTools: protocol === "responses" ? responsesCustom.state : "bridged",
      namespaceTools: protocol === "responses" ? responsesNamespace.state : "bridged",
      nativeCustomTools: protocol === "responses" ? nativeCustomTools : [],
      parallelTools,
      toolChoice: selectedToolChoice,
      reasoning: reasoning.state,
      reasoningToolChoice,
      reasoningHistory,
      imageInput: image.supportsImage
        ? imageProtocol === protocol ? "native" : "bridged"
        : image.status === "inconclusive" ? "inconclusive" : "unsupported",
      hostedTools: { web_search: effectiveHostedWebSearch },
    },
    codexConformance: "passed",
    checkedAt: now(),
    probeVersion: MODEL_CAPABILITY_PROBE_VERSION,
  };
}

async function probeResponses(request, modelId) {
  const firstRequest = {
    model: modelId,
    input: "Call codex_quota_capability_probe once with value probe. Do not answer directly.",
    tools: [TOOL_DEFINITION],
    tool_choice: { type: "function", name: PROBE_TOOL_NAME },
    max_output_tokens: 512,
    store: false,
  };
  let toolChoice = "native";
  let toolChoiceRequestFields = {};
  let first = await request("responses", firstRequest);
  if (isToolChoiceRejection(first)) {
    const withoutReasoning = { reasoning: { effort: "none" } };
    const disabled = await request("responses", { ...firstRequest, ...withoutReasoning });
    if (disabled.ok) {
      first = disabled;
      toolChoiceRequestFields = withoutReasoning;
    } else {
      toolChoice = "unsupported";
      const { tool_choice: _unsupported, ...withoutToolChoice } = firstRequest;
      first = await request("responses", withoutToolChoice);
    }
  }
  if (!first.ok) return { ok: false, failure: first };
  const firstOutput = responseOutput(first.payload);
  const reasoningObserved = firstOutput.some((item) => item?.type === "reasoning");
  const call = findResponseToolCall(first.payload);
  if (!call) {
    return { ok: false, failure: contractFailure(first.status, "Responses 未返回要求的工具调用") };
  }
  const fullInput = [
    ...firstOutput,
    { type: "function_call_output", call_id: call.callId, output: "probe-result" },
  ];
  const full = await request("responses", {
    model: modelId,
    input: fullInput,
    tools: [TOOL_DEFINITION],
    ...toolChoiceRequestFields,
    max_output_tokens: CONTINUATION_OUTPUT_TOKENS,
    store: false,
  });
  if (full.ok && hasResponseContinuation(full.payload)) {
    return {
      ok: true,
      historyMode: "responses-full",
      reasoningHistory: reasoningObserved ? "native" : "inconclusive",
      toolChoice,
      toolChoiceRequestFields,
    };
  }
  if (full.ok) {
    return {
      ok: false,
      failure: continuationFailure(
        full,
        "responses",
        "Responses 工具结果续接后未返回有效后续输出",
      ),
    };
  }

  const textOnlyInput = stripReasoningEnvelope(fullInput);
  if (!isReasoningEnvelopeRejection(full) ||
    JSON.stringify(textOnlyInput) === JSON.stringify(fullInput)) {
    return { ok: false, failure: full };
  }
  const textOnly = await request("responses", {
    model: modelId,
    input: textOnlyInput,
    tools: [TOOL_DEFINITION],
    max_output_tokens: CONTINUATION_OUTPUT_TOKENS,
    store: false,
  });
  if (textOnly.ok && hasResponseContinuation(textOnly.payload)) {
    return {
      ok: true,
      historyMode: "reasoning-text-only",
      reasoningHistory: "bridged",
      toolChoice,
      toolChoiceRequestFields,
    };
  }
  if (textOnly.ok) {
    return {
      ok: false,
      failure: continuationFailure(
        textOnly,
        "responses",
        "Responses 纯文本历史续接后未返回有效后续输出",
      ),
    };
  }
  return { ok: false, failure: textOnly };
}

async function probeResponsesCustom(
  request,
  modelId,
  historyMode,
  {
    name = PROBE_CUSTOM_TOOL_NAME,
    rawInput = "CUSTOM-PROBE",
  } = {},
) {
  const tool = {
    type: "custom",
    name,
    description: `Call this tool with the exact raw input ${rawInput}.`,
  };
  const first = await requestWithToolChoiceFallback(request, "responses", {
    model: modelId,
    input: `Call ${name} with exactly ${rawInput}. Do not answer in text.`,
    tools: [tool],
    tool_choice: { type: "custom", name },
    max_output_tokens: 1_024,
    store: false,
  });
  if (!first.response.ok) return {
    ...unavailableProbe(first.response, first.toolChoice),
    failure: first.response,
  };
  const output = responseOutput(first.response.payload);
  const call = output.find((item) => item?.type === "custom_tool_call" &&
    item?.name === name && (item?.call_id || item?.id) &&
    String(item?.input ?? "").includes(rawInput));
  if (!call) return {
    state: "unsupported",
    toolChoice: first.toolChoice,
    failure: contractFailure(first.response.status, `Responses 未返回 ${name} 的 custom 工具调用`),
  };
  const input = appendToolOutput(output, {
    type: "custom_tool_call_output",
    call_id: String(call.call_id ?? call.id),
    output: `${name}-RESULT`,
  }, historyMode);
  const continuation = await request("responses", {
    model: modelId,
    input,
    tools: [tool],
    ...first.toolChoiceRequestFields,
    max_output_tokens: CONTINUATION_OUTPUT_TOKENS,
    store: false,
  });
  if (continuation.ok) {
    const completed = hasResponseContinuation(continuation.payload);
    return {
      state: completed ? "native" : "unsupported",
      toolChoice: first.toolChoice,
      ...(completed ? {} : {
        failure: continuationFailure(
          continuation,
          "responses",
          `Responses ${name} 工具结果续接后未返回有效后续输出`,
        ),
      }),
    };
  }
  return { ...unavailableProbe(continuation, first.toolChoice), failure: continuation };
}

async function probeResponsesNamespace(request, modelId, historyMode) {
  const tool = {
    type: "namespace",
    name: PROBE_NAMESPACE_NAME,
    description: "Codex namespace capability probe.",
    tools: [{
      type: "function",
      name: PROBE_NAMESPACE_TOOL_NAME,
      description: "Return the supplied value.",
      parameters: TOOL_DEFINITION.parameters,
    }],
  };
  const first = await requestWithToolChoiceFallback(request, "responses", {
    model: modelId,
    input: `Call ${PROBE_NAMESPACE_NAME}.${PROBE_NAMESPACE_TOOL_NAME} with value namespace-probe. Do not answer in text.`,
    tools: [tool],
    tool_choice: "required",
    max_output_tokens: 1_024,
    store: false,
  });
  if (!first.response.ok) return {
    ...unavailableProbe(first.response, first.toolChoice),
    failure: first.response,
  };
  const output = responseOutput(first.response.payload);
  const call = output.find((item) => item?.type === "function_call" &&
    item?.name === PROBE_NAMESPACE_TOOL_NAME && item?.namespace === PROBE_NAMESPACE_NAME &&
    (item?.call_id || item?.id));
  if (!call) return {
    state: "unsupported",
    toolChoice: first.toolChoice,
    failure: contractFailure(first.response.status, "Responses 未返回 namespace 工具调用"),
  };
  const input = appendToolOutput(output, {
    type: "function_call_output",
    call_id: String(call.call_id ?? call.id),
    output: "NAMESPACE-PROBE-RESULT",
  }, historyMode);
  const continuation = await request("responses", {
    model: modelId,
    input,
    tools: [tool],
    ...first.toolChoiceRequestFields,
    max_output_tokens: CONTINUATION_OUTPUT_TOKENS,
    store: false,
  });
  if (continuation.ok) {
    const completed = hasResponseContinuation(continuation.payload);
    return {
      state: completed ? "native" : "unsupported",
      toolChoice: first.toolChoice,
      ...(completed ? {} : {
        failure: continuationFailure(
          continuation,
          "responses",
          "Responses namespace 工具结果续接后未返回有效后续输出",
        ),
      }),
    };
  }
  return { ...unavailableProbe(continuation, first.toolChoice), failure: continuation };
}

async function probeHostedWebSearch(request, modelId) {
  const first = await requestWithToolChoiceFallback(request, "responses", {
    model: modelId,
    input: "Use web search to find the title of the OpenAI Responses API reference page.",
    tools: [{ type: "web_search" }],
    tool_choice: { type: "web_search" },
    max_output_tokens: 512,
    store: false,
  });
  if (!first.response.ok) return unavailableProbe(first.response, first.toolChoice);
  const state = responseOutput(first.response.payload).some((item) =>
    item?.type === "web_search_call" && item?.status !== "failed")
    ? "native"
    : "unsupported";
  return { state, toolChoice: first.toolChoice };
}

async function probeChat(request, modelId) {
  const tools = [{
    type: "function",
    function: {
      name: PROBE_TOOL_NAME,
      description: TOOL_DEFINITION.description,
      parameters: TOOL_DEFINITION.parameters,
    },
  }];
  const firstRequest = {
    model: modelId,
    messages: [{
      role: "user",
      content: "Call codex_quota_capability_probe once with value probe. Do not answer directly.",
    }],
    tools,
    tool_choice: { type: "function", function: { name: PROBE_TOOL_NAME } },
    max_tokens: 512,
    stream: false,
  };
  let toolChoice = "native";
  let toolChoiceRequestFields = {};
  let first = await request("chat/completions", firstRequest);
  if (isToolChoiceRejection(first)) {
    const withoutReasoning = { reasoning_effort: "none" };
    const disabled = await request("chat/completions", { ...firstRequest, ...withoutReasoning });
    if (disabled.ok) {
      first = disabled;
      toolChoiceRequestFields = withoutReasoning;
    } else {
      toolChoice = "unsupported";
      const { tool_choice: _unsupported, ...withoutToolChoice } = firstRequest;
      first = await request("chat/completions", withoutToolChoice);
    }
  }
  if (!first.ok) return { ok: false, failure: first };
  const assistant = first.payload?.choices?.[0]?.message;
  const call = Array.isArray(assistant?.tool_calls)
    ? assistant.tool_calls.find((item) => item?.function?.name === PROBE_TOOL_NAME && item?.id)
    : null;
  if (!call) {
    return { ok: false, failure: contractFailure(first.status, "Chat 未返回要求的工具调用") };
  }
  const second = await request("chat/completions", {
    model: modelId,
    messages: [
      { role: "user", content: "Call codex_quota_capability_probe once with value probe. Do not answer directly." },
      assistant,
      { role: "tool", tool_call_id: call.id, content: "probe-result" },
    ],
    tools,
    ...toolChoiceRequestFields,
    max_tokens: CONTINUATION_OUTPUT_TOKENS,
    stream: false,
  });
  if (second.ok && hasChatContinuation(second.payload)) {
    return { ok: true, toolChoice, toolChoiceRequestFields };
  }
  if (second.ok) {
    return {
      ok: false,
      failure: continuationFailure(
        second,
        "chat/completions",
        "Chat 工具结果续接后未返回有效后续输出",
      ),
    };
  }
  return { ok: false, failure: second };
}

async function probeReasoning(request, modelId, protocol, { onEffort = null } = {}) {
  const efforts = [];
  let inconclusive = false;
  for (const effort of PROBE_REASONING_EFFORTS) {
    onEffort?.(effort);
    const response = protocol === "responses"
      ? await request("responses", {
          model: modelId,
          input: "Think briefly, then reply with exactly OK.",
          reasoning: { effort },
          max_output_tokens: 256,
          store: false,
        })
      : await request("chat/completions", {
          model: modelId,
          messages: [{ role: "user", content: "Think briefly, then reply with exactly OK." }],
          reasoning_effort: effort,
          max_tokens: 256,
          stream: false,
        });
    if (!response.ok) {
      if (response.retryExhausted) { inconclusive = true; continue; }
      if (capabilityFromFailure(response) === "inconclusive") {
        throw probeError(`${effort} 推理强度检测失败`, response);
      }
      continue;
    }
    if (hasReasoningEvidence(response.payload, protocol)) efforts.push(effort);
  }
  return {
    state: efforts.length > 0 ? "native" : inconclusive ? "inconclusive" : "unsupported",
    efforts,
  };
}

async function probeReasoningToolChoice(request, modelId, protocol, effort) {
  const prompt = `Call ${PROBE_TOOL_NAME} once with value reasoning-tool-choice. Do not answer directly.`;
  const common = protocol === "responses"
    ? {
        model: modelId,
        input: prompt,
        tools: [TOOL_DEFINITION],
        reasoning: { effort },
        max_output_tokens: 512,
        store: false,
      }
    : {
        model: modelId,
        messages: [{ role: "user", content: prompt }],
        tools: [chatFunctionTool(PROBE_TOOL_NAME)],
        reasoning_effort: effort,
        max_tokens: 512,
        stream: false,
      };
  const namedChoice = protocol === "responses"
    ? { type: "function", name: PROBE_TOOL_NAME }
    : { type: "function", function: { name: PROBE_TOOL_NAME } };
  const named = await request(protocol === "responses" ? "responses" : "chat/completions", {
    ...common,
    tool_choice: namedChoice,
  });
  if (named.ok && hasProtocolToolCall(named.payload, protocol, PROBE_TOOL_NAME)) return "native";
  if (named.retryExhausted) return "inconclusive";
  if (!named.ok && !isToolChoiceRejection(named) &&
    capabilityFromFailure(named) === "inconclusive") {
    throw probeError("推理模式工具选择检测失败", named);
  }
  const automatic = await request(protocol === "responses" ? "responses" : "chat/completions", {
    ...common,
    tool_choice: "auto",
  });
  if (!automatic.ok) {
    if (automatic.retryExhausted) return "inconclusive";
    if (capabilityFromFailure(automatic) === "inconclusive") {
      throw probeError("推理模式自动工具选择检测失败", automatic);
    }
    return "unsupported";
  }
  return hasProtocolToolCall(automatic.payload, protocol, PROBE_TOOL_NAME)
    ? "auto-only"
    : "unsupported";
}

async function probeResponsesReasoningHistory(
  request,
  modelId,
  effort,
  reasoningToolChoice,
) {
  const toolChoice = reasoningToolChoice === "native"
    ? { type: "function", name: PROBE_TOOL_NAME }
    : reasoningToolChoice === "auto-only"
      ? "auto"
      : null;
  const requestBody = {
    model: modelId,
    input: `Think briefly, then call ${PROBE_TOOL_NAME} once with value reasoning-history. Do not answer directly.`,
    tools: [TOOL_DEFINITION],
    reasoning: { effort },
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    max_output_tokens: 512,
    store: false,
  };
  const first = await request("responses", requestBody);
  if (!first.ok) {
    if (capabilityFromFailure(first) === "inconclusive") {
      throw probeError("Responses 推理历史检测失败", first);
    }
    return { state: "inconclusive", historyMode: "reasoning-text-only" };
  }
  const output = responseOutput(first.payload);
  const call = findResponseToolCall(first.payload);
  if (!call || !output.some((item) => item?.type === "reasoning")) {
    return { state: "inconclusive", historyMode: "reasoning-text-only" };
  }
  const fullInput = [
    ...output,
    { type: "function_call_output", call_id: call.callId, output: "reasoning-history-result" },
  ];
  const continuationBody = {
    model: modelId,
    input: fullInput,
    tools: [TOOL_DEFINITION],
    reasoning: { effort },
    max_output_tokens: CONTINUATION_OUTPUT_TOKENS,
    store: false,
  };
  const full = await request("responses", continuationBody);
  if (full.ok && hasResponseContinuation(full.payload)) {
    return { state: "native", historyMode: "responses-full" };
  }
  if (full.ok) {
    throw probeError(
      "Responses 完整推理历史续接检测失败",
      continuationFailure(full, "responses", "Responses 完整推理历史续接后未返回有效后续输出"),
    );
  }
  if (!full.ok && capabilityFromFailure(full) === "inconclusive") {
    throw probeError("Responses 完整推理历史续接检测失败", full);
  }
  if (!isReasoningEnvelopeRejection(full)) {
    throw probeError("Responses 完整推理历史续接检测失败", full);
  }

  const textOnlyInput = stripReasoningEnvelope(fullInput);
  if (JSON.stringify(textOnlyInput) === JSON.stringify(fullInput)) {
    return { state: "inconclusive", historyMode: "reasoning-text-only" };
  }
  const textOnly = await request("responses", {
    ...continuationBody,
    input: textOnlyInput,
  });
  if (textOnly.ok && hasResponseContinuation(textOnly.payload)) {
    return { state: "bridged", historyMode: "reasoning-text-only" };
  }
  if (!textOnly.ok && capabilityFromFailure(textOnly) === "inconclusive") {
    throw probeError("Responses 纯文本推理历史续接检测失败", textOnly);
  }
  throw probeError(
    "Responses 推理历史无法完成工具续接",
    textOnly.ok
      ? continuationFailure(
          textOnly,
          "responses",
          "Responses 纯文本推理历史续接后未返回有效后续输出",
        )
      : textOnly,
    full,
  );
}

async function probeStreaming(requestStream, modelId, protocol) {
  const response = protocol === "responses"
    ? await requestStream("responses", {
        model: modelId,
        input: "Reply with OK.",
        max_output_tokens: 32,
        stream: true,
        store: false,
      })
    : await requestStream("chat/completions", {
        model: modelId,
        messages: [{ role: "user", content: "Reply with OK." }],
        max_tokens: 32,
        stream: true,
      });
  if (!response.ok) throw probeError("流式响应检测失败", response);
  if (!/text\/event-stream/i.test(response.contentType ?? "")) {
    throw new Error("流式响应检测失败：响应不是 text/event-stream");
  }
  if (protocol === "responses") {
    if (!/response\.(completed|incomplete)/.test(response.raw)) {
      throw new Error("流式响应检测失败：缺少 Responses 终态事件");
    }
    return "native";
  }
  if (!/data:\s*\[DONE\]/.test(response.raw) || !/data:\s*\{/.test(response.raw)) {
    throw new Error("流式响应检测失败：缺少 Chat 数据事件或结束标记");
  }
  return "native";
}

async function probeParallelTools(
  request,
  modelId,
  protocol,
  toolChoice,
  toolChoiceRequestFields = {},
) {
  const prompt = `Call both ${PROBE_PARALLEL_TOOL_NAMES.join(" and ")} once, with value parallel-probe.`;
  const response = protocol === "responses"
    ? await request("responses", {
        model: modelId,
        input: prompt,
        tools: PROBE_PARALLEL_TOOL_NAMES.map(responseFunctionTool),
        ...toolChoiceRequestFields,
        ...(toolChoice === "native" ? { tool_choice: "required" } : {}),
        parallel_tool_calls: true,
        max_output_tokens: 512,
        store: false,
      })
    : await request("chat/completions", {
        model: modelId,
        messages: [{ role: "user", content: prompt }],
        tools: PROBE_PARALLEL_TOOL_NAMES.map(chatFunctionTool),
        ...toolChoiceRequestFields,
        ...(toolChoice === "native" ? { tool_choice: "required" } : {}),
        parallel_tool_calls: true,
        max_tokens: 512,
        stream: false,
      });
  if (!response.ok) return capabilityFromFailure(response);
  const names = protocol === "responses"
    ? responseOutput(response.payload).filter((item) => item?.type === "function_call").map((item) => item.name)
    : (response.payload?.choices?.[0]?.message?.tool_calls ?? []).map((item) => item?.function?.name);
  return PROBE_PARALLEL_TOOL_NAMES.every((name) => names.includes(name))
    ? "native"
    : "unsupported";
}

async function probeCodexConformance(
  request,
  modelId,
  protocol,
  toolChoice,
  hostedWebSearch,
  parallelTools,
  toolChoiceRequestFields = {},
  responsesTools = {},
) {
  const input = "Call codex_quota_capability_probe once with value codex-conformance.";
  const responsesRequest = createResponsesBridgeRequest(request, {
    nativeCustomTools: responsesTools.customTools === "native"
      ? ["*"]
      : responsesTools.nativeCustomTools,
    nativeNamespaceTools: responsesTools.namespaceTools === "native",
  });
  const response = protocol === "responses"
    ? await responsesRequest("responses", {
        model: modelId,
        instructions: "Follow the user request and use the supplied Codex tool.",
        input: [
          { type: "message", role: "developer", content: [{ type: "input_text", text: "Use tools when requested." }] },
          { type: "message", role: "user", content: [{ type: "input_text", text: input }] },
        ],
        tools: [
          CODEX_CONFORMANCE_TOOL_DEFINITION,
          { type: "custom", name: PROBE_CUSTOM_TOOL_NAME, description: "Raw Codex tool." },
          { type: "namespace", name: PROBE_NAMESPACE_NAME, tools: [responseFunctionTool(PROBE_NAMESPACE_TOOL_NAME)] },
          ...(hostedWebSearch === "native" ? [{ type: "web_search" }] : []),
        ],
        ...toolChoiceRequestFields,
        ...(toolChoice === "native" ? { tool_choice: { type: "function", name: PROBE_TOOL_NAME } } : {}),
        ...(parallelTools === "native" ? { parallel_tool_calls: false } : {}),
        client_metadata: { originator: "codex_cli_rs" },
        include: ["reasoning.encrypted_content"],
        prompt_cache_key: "codex-capability-probe",
        text: { verbosity: "low" },
        max_output_tokens: 512,
        store: false,
      })
    : await request("chat/completions", {
        model: modelId,
        messages: [
          { role: "system", content: "Follow the user request and use the supplied Codex tool." },
          { role: "user", content: input },
        ],
        tools: [
          chatFunctionTool(PROBE_TOOL_NAME, CODEX_CONFORMANCE_TOOL_DEFINITION.parameters),
          chatFunctionTool(PROBE_CUSTOM_TOOL_NAME),
          chatFunctionTool(`${PROBE_NAMESPACE_NAME}_${PROBE_NAMESPACE_TOOL_NAME}`),
        ],
        ...toolChoiceRequestFields,
        ...(toolChoice === "native" ? {
          tool_choice: { type: "function", function: { name: PROBE_TOOL_NAME } },
        } : {}),
        ...(parallelTools === "native" ? { parallel_tool_calls: false } : {}),
        max_tokens: 512,
        stream: false,
      });
  if (!response.ok) throw probeError("组合后的 Codex 请求兼容检测失败", response);
  const called = protocol === "responses"
    ? responseOutput(response.payload).some((item) =>
        item?.type === "function_call" && item?.name === PROBE_TOOL_NAME &&
        (item?.call_id || item?.id))
    : (response.payload?.choices?.[0]?.message?.tool_calls ?? []).some((item) =>
        item?.function?.name === PROBE_TOOL_NAME && item?.id);
  if (!called) throw new Error("组合后的 Codex 请求未返回指定工具调用");
  return "passed";
}

function responseFunctionTool(name) {
  return { ...TOOL_DEFINITION, name };
}

function chatFunctionTool(name, parameters = TOOL_DEFINITION.parameters) {
  const tool = responseFunctionTool(name);
  return { type: "function", function: {
    name: tool.name,
    description: tool.description,
    parameters: normalizeToolParametersSchema(parameters),
  } };
}

async function probeAlternateChatImageRoute({
  request,
  requestStream,
  modelId,
  responsesTools,
  onRetry,
}) {
  const chat = await runProtocolProbeWithRetry(
    () => probeChat(request, modelId),
    { onRetry },
  );
  if (!chat.ok) {
    if (chat.failure?.retryExhausted) return { ok: false, failure: chat.failure };
    if (capabilityFromFailure(chat.failure) === "inconclusive") {
      throw probeError("Chat 图片备用链路检测失败", chat.failure);
    }
    return { ok: false, failure: chat.failure };
  }
  try {
    await probeStreaming(requestStream, modelId, "chat");
    const parallelTools = await probeParallelTools(
      request,
      modelId,
      "chat",
      chat.toolChoice,
      chat.toolChoiceRequestFields,
    );
    await probeCodexConformance(
      request,
      modelId,
      "chat",
      chat.toolChoice,
      "unsupported",
      parallelTools,
      chat.toolChoiceRequestFields,
      responsesTools,
    );
  } catch (error) {
    if (error.probeFailures?.some(failure => failure.retryExhausted)) {
      return { ok: false, failure: { retryExhausted: true, message: error.message } };
    }
    if (!canTryAlternateAfterProbeError(error)) throw error;
    return { ok: false, failure: contractFailure(422, error.message) };
  }
  return { ok: true, chat };
}

function createResponsesBridgeRequest(request, options) {
  return async (path, body) => {
    if (path !== "responses") return request(path, body);
    let prepared;
    try {
      prepared = prepareResponsesToolRequest(body, options);
    } catch (error) {
      return contractFailure(422, `Responses 工具请求转换失败：${error.message}`);
    }
    const response = await request(path, prepared.body);
    if (!response.ok) return response;
    try {
      return {
        ...response,
        payload: translateResponsesPayload(response.payload, prepared.plan),
      };
    } catch (error) {
      return contractFailure(response.status, `Responses 工具响应转换失败：${error.message}`);
    }
  };
}

async function requestWithToolChoiceFallback(request, path, body) {
  let response = await request(path, body);
  if (!isToolChoiceRejection(response)) {
    return { response, toolChoice: "native", toolChoiceRequestFields: {} };
  }
  if (path === "responses") {
    const toolChoiceRequestFields = { reasoning: { effort: "none" } };
    const disabled = await request(path, { ...body, ...toolChoiceRequestFields });
    if (disabled.ok) {
      return { response: disabled, toolChoice: "native", toolChoiceRequestFields };
    }
  }
  const { tool_choice: _unsupported, ...withoutToolChoice } = body;
  response = await request(path, withoutToolChoice);
  return { response, toolChoice: "unsupported", toolChoiceRequestFields: {} };
}

function appendToolOutput(output, item, historyMode) {
  const history = historyMode === "reasoning-text-only"
    ? stripReasoningEnvelope(output)
    : structuredClone(output);
  return [...history, item];
}

function unavailableProbe(failure, toolChoice = "inconclusive") {
  return { state: capabilityFromFailure(failure), toolChoice };
}

async function runProtocolProbeWithRetry(probe, { onRetry = null } = {}) {
  const first = await probe();
  if (first.ok || !isRetryableProbeFailure(first.failure)) return first;
  onRetry?.(first.failure);
  return probe();
}

function createProbeProgressReporter(onProgress) {
  const notify = typeof onProgress === "function" ? onProgress : null;
  let last = { current: 1, stage: "starting" };
  const report = (current, stage, message, extra = {}) => {
    last = { current, stage };
    if (!notify) return;
    try {
      notify({
        current,
        total: 8,
        stage,
        message,
        retry: extra.retry === true,
      });
    } catch {
      // 展示进度不能中断真实能力检测。
    }
  };
  report.retry = message => report(last.current, last.stage, message, { retry: true });
  report.stage = () => last.stage;
  return report;
}

function isRetryableProbeFailure(failure) {
  if (failure?.retryExhausted) return false;
  if (failure?.kind === "contract") return true;
  const status = Number(failure?.status) || 0;
  return status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
}

function isOutputTokenLimitIncomplete(response, path) {
  if (!response?.ok) return false;
  if (path === "responses") {
    return response.payload?.status === "incomplete" &&
      response.payload?.incomplete_details?.reason === "max_output_tokens";
  }
  return response.payload?.choices?.some((choice) => choice?.finish_reason === "length") ?? false;
}

function continuationFailure(response, path, message) {
  const detail = isOutputTokenLimitIncomplete(response, path)
    ? `${message}（扩大输出预算后仍达到 Token 上限）`
    : message;
  return contractFailure(response?.status, detail);
}

function hasResponseContinuation(payload) {
  if (payload?.status === "incomplete") return false;
  return responseOutput(payload).some((item) => {
    if (item?.status === "incomplete") return false;
    if (item?.type === "message" && item?.role === "assistant") {
      return Array.isArray(item.content) && item.content.some((part) =>
        part?.type === "output_text" && String(part?.text ?? "").trim());
    }
    if (item?.type === "function_call") {
      return Boolean(item?.name && (item?.call_id || item?.id) &&
        isJsonObjectString(item?.arguments));
    }
    return item?.type === "custom_tool_call" &&
      Boolean(item?.name && (item?.call_id || item?.id) && typeof item?.input === "string");
  });
}

function hasChatContinuation(payload) {
  const choice = payload?.choices?.[0];
  const message = choice?.message;
  if (message?.role !== "assistant" || choice?.finish_reason === "length") return false;
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return message.tool_calls.every((item) => item?.id && item?.function?.name &&
      isJsonObjectString(item?.function?.arguments));
  }
  if (typeof message.content === "string") return Boolean(message.content.trim());
  return Array.isArray(message.content) && message.content.some((part) =>
    typeof part?.text === "string" && part.text.trim());
}

function isJsonObjectString(value) {
  if (typeof value !== "string") return false;
  try {
    const parsed = JSON.parse(value);
    return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  } catch {
    return false;
  }
}

function hasReasoningEvidence(payload, protocol) {
  if (protocol === "responses") {
    if (responseOutput(payload).some((item) => item?.type === "reasoning")) return true;
    return Number(payload?.usage?.output_tokens_details?.reasoning_tokens) > 0;
  }
  const message = payload?.choices?.[0]?.message;
  if (typeof message?.reasoning_content === "string" && message.reasoning_content.trim()) return true;
  return Number(payload?.usage?.completion_tokens_details?.reasoning_tokens) > 0;
}

function hasProtocolToolCall(payload, protocol, name) {
  if (protocol === "responses") {
    return responseOutput(payload).some((item) =>
      item?.type === "function_call" && item?.name === name && (item?.call_id || item?.id));
  }
  return (payload?.choices?.[0]?.message?.tool_calls ?? []).some((item) =>
    item?.function?.name === name && item?.id);
}

async function probeImage(request, modelId, protocol, challengeFactory, onResult) {
  const attempts = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const challenge = challengeFactory();
    const result = await probeImageOnce(request, modelId, protocol, challenge);
    onResult?.({ event: "image-result", protocol, imageAttempt: attempt + 1,
      expectedAnswer: challenge.expected, status: result.status, detail: result.detail });
    if (result.status === "inconclusive") {
      return { supportsImage: null, status: "inconclusive", detail: result.detail };
    }
    if (result.status === "supported" || result.status === "rejected") {
      return {
        supportsImage: result.status === "supported",
        status: result.status === "supported" ? "supported" : "unsupported",
        detail: result.detail,
      };
    }
    attempts.push(result);
  }
  if (attempts.every((result) => result.status === "denied")) {
    return {
      supportsImage: false,
      status: "unsupported",
      detail: "模型连续两次明确回复无法识别图片",
    };
  }
  return {
    supportsImage: false,
    status: "unsupported",
    detail: "连续两次图片请求成功，但模型均未正确识别图片内容",
  };
}

async function probeImageOnce(request, modelId, protocol, challenge) {
  const response = protocol === "chat"
    ? await request("chat/completions", {
        model: modelId,
        messages: [{ role: "user", content: [
          { type: "text", text: challenge.prompt },
          { type: "image_url", image_url: { url: challenge.dataUrl } },
        ] }],
        max_tokens: IMAGE_OUTPUT_TOKENS,
        stream: false,
      })
    : await request("responses", {
        model: modelId,
        input: [{ role: "user", content: [
          { type: "input_text", text: challenge.prompt },
          { type: "input_image", image_url: challenge.dataUrl, detail: "high" },
        ] }],
        max_output_tokens: IMAGE_OUTPUT_TOKENS,
        store: false,
      });
  if (!response.ok) {
    if (isExplicitImageRejection(response)) {
      return { status: "rejected", detail: response.message };
    }
    if (response.retryExhausted) {
      return { status: "inconclusive", detail: `图片暂不可用：连续 3 次请求失败（${response.message}），未确认模型不支持图片` };
    }
    throw new Error(`图片能力检测失败：${response.message}`);
  }
  const payload = response.payload;
  const answer = (protocol === "chat" ? chatOutputText(payload) : responsesOutputText(payload)).trim();
  const budgetExhausted = protocol === "chat"
    ? payload?.choices?.[0]?.finish_reason === "length"
    : payload?.incomplete_details?.reason === "max_output_tokens";
  const incomplete = budgetExhausted ||
    (protocol === "responses" && ["incomplete", "failed", "cancelled", "in_progress"].includes(payload?.status));
  if (!incomplete && matchesImageChallenge(answer, challenge.expected)) {
    return { status: "supported", detail: null };
  }
  // Reasoning is never a successful answer. Only use an explicit inability
  // statement when there is no final answer; probeImage requires two denials.
  const denialText = answer || imageReasoningText(payload, protocol);
  if (explicitImageDenial(denialText)) {
    return { status: "denied", detail: "模型明确表示无法识别图片" };
  }
  if (incomplete || !answer) {
    return {
      status: "inconclusive",
      detail: budgetExhausted
        ? "图片检测未完成：输出预算耗尽（256 Token）"
        : "图片检测未完成：未返回完整的最终答案",
    };
  }
  return { status: "mismatch", detail: "图片请求已成功，但回答内容未通过校验" };
}

function imageReasoningText(payload, protocol) {
  if (protocol === "chat") {
    const text = payload?.choices?.[0]?.message?.reasoning_content;
    return typeof text === "string" ? text : "";
  }
  return responseOutput(payload).filter(item => item?.type === "reasoning")
    .flatMap(item => Array.isArray(item.content) ? item.content : [])
    .filter(part => part?.type === "reasoning_text" && typeof part.text === "string")
    .map(part => part.text).join("\n");
}

function explicitImageDenial(text) {
  return String(text).split(/[.!?。！？\n]+/).some(sentence => {
    // Hypotheses about a possible failure are not evidence of this failure.
    if (/\b(?:if|whether|maybe|perhaps|might)\b|如果|假如|是否|可能/i.test(sentence)) return false;
    return /\b(?:cannot|can't|unable to)\s+(?:see|view|read|access|process|recognize)\s+(?:(?:the|this|provided|attached|input)\s+)?(?:image|picture)\b|\b(?:image|picture)(?:\s+is)?\s+unsupported\b|\[unsupported image\]|(?:无法|不能|不支持)(?:读取|查看|识别|处理|访问|看见|看到)?(?:这张|该|输入的|提供的|所附的)?(?:图片|图像)/i.test(sentence);
  });
}

function matchesImageChallenge(answer, expected) {
  const expectedColors = String(expected ?? "").toLowerCase().split("-").filter(Boolean);
  const allowedColors = new Set(["red", "green", "blue", "yellow", "magenta", "cyan"]);
  if (expectedColors.length < 2 ||
    expectedColors.some((color) => !allowedColors.has(color))) return false;
  const answerColors = (String(answer ?? "").toLowerCase().match(/[a-z]+/g) ?? [])
    .filter((word) => allowedColors.has(word));
  if (answerColors.length < expectedColors.length) return false;
  return answerColors.some((_, index) => expectedColors.every(
    (color, offset) => answerColors[index + offset] === color,
  ));
}

function normalizeTarget({ baseUrl, apiKey, modelId }) {
  const key = String(apiKey ?? "").trim();
  const model = String(modelId ?? "").trim();
  if (!key) throw new Error("自动检测需要 API Key");
  if (!model) throw new Error("自动检测需要模型 ID");
  let url;
  try {
    url = new URL(String(baseUrl ?? ""));
  } catch {
    throw new Error("自动检测的 API Base URL 无效");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  url.search = "";
  url.hash = "";
  return { baseUrl: url, apiKey: key, modelId: model };
}

async function postJson({ url, apiKey, body, fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("模型能力检测超时")), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    const providerRejected = hasProviderError(payload);
    return {
      ok: response.ok && !providerRejected,
      status: response.status,
      payload,
      message: response.ok && !providerRejected
        ? null
        : upstreamMessage(payload, text, response.status, apiKey),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      payload: null,
      message: error?.name === "AbortError" ? "模型能力检测超时" : `网络请求失败：${error.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function postStream({ url, apiKey, body, fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("模型能力检测超时")), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await response.text();
    let payload = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      payload = null;
    }
    const providerRejected = hasProviderError(payload);
    return {
      ok: response.ok && !providerRejected,
      status: response.status,
      raw,
      payload,
      contentType: response.headers.get("content-type"),
      message: response.ok && !providerRejected
        ? null
        : upstreamMessage(payload, raw, response.status, apiKey),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      raw: "",
      contentType: null,
      message: error?.name === "AbortError" ? "模型能力检测超时" : `网络请求失败：${error.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function summarizeProbeResponse(response, protocol) {
  let payload = response.payload;
  const events = [];
  let deltaText = "";
  if (!payload && typeof response.raw === "string") {
    for (const line of response.raw.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      try {
        const event = JSON.parse(line.slice(5).trim());
        if (typeof event.type === "string" && events.length < 12 && !events.includes(event.type)) events.push(event.type);
        const delta = event.type === "response.output_text.delta" ? event.delta : event.choices?.[0]?.delta?.content;
        if (typeof delta === "string") deltaText += delta;
        if (event.response) payload = event.response;
        else if (event.choices || event.usage) payload = { ...payload, ...event,
          choices: event.choices?.length ? event.choices : payload?.choices };
      } catch { /* [DONE] and malformed frames are not JSON payloads. */ }
    }
  }
  const output = Array.isArray(payload?.output) ? payload.output : [];
  const choice = payload?.choices?.[0];
  const text = parts => typeof parts === "string" ? parts : Array.isArray(parts)
    ? parts.map(part => typeof part?.text === "string" ? part.text : "").join("\n") : "";
  const answer = protocol === "chat" ? text(choice?.message?.content) || deltaText
    : typeof payload?.output_text === "string" ? payload.output_text
      : output.filter(item => item?.type === "message").map(item => text(item.content)).join("\n") || deltaText;
  const reasoning = imageReasoningText(payload, protocol);
  const usage = payload?.usage;
  const number = value => typeof value === "number" && Number.isFinite(value) ? value : null;
  return {
    responseStatus: payload?.status ?? null,
    finishReason: choice?.finish_reason ?? null,
    incompleteReason: payload?.incomplete_details?.reason ?? null,
    usage: {
      inputTokens: number(usage?.input_tokens ?? usage?.prompt_tokens),
      outputTokens: number(usage?.output_tokens ?? usage?.completion_tokens),
      reasoningTokens: number(usage?.output_tokens_details?.reasoning_tokens ?? usage?.completion_tokens_details?.reasoning_tokens),
      totalTokens: number(usage?.total_tokens),
    },
    answerChars: answer.length, answerSummary: answer,
    reasoningChars: reasoning.length, reasoningSummary: reasoning,
    recognizedAnswerChars: (protocol === "chat" ? chatOutputText(payload) : responsesOutputText(payload)).length,
    outputShape: output.slice(0, 16).map(item => ({ type: item?.type ?? null, role: item?.role ?? null,
      status: item?.status ?? null, contentTypes: Array.isArray(item?.content) ? item.content.slice(0, 16).map(part => part?.type ?? null) : typeof item?.content })),
    chatMessageKeys: choice?.message ? Object.keys(choice.message) : [],
    streamEvents: events,
    bodyParsed: payload != null,
  };
}

function responseOutput(payload) {
  return Array.isArray(payload?.output) ? structuredClone(payload.output) : [];
}

function findResponseToolCall(payload) {
  const call = responseOutput(payload).find((item) =>
    item?.type === "function_call"
      && item?.name === PROBE_TOOL_NAME
      && (item?.call_id || item?.id)
  );
  return call ? { callId: String(call.call_id ?? call.id) } : null;
}

function stripReasoningEnvelope(input) {
  return structuredClone(input).map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || item.type !== "reasoning") {
      return item;
    }
    delete item.summary;
    delete item.encrypted_content;
    return item;
  });
}

function canTryAlternateProtocol(failure) {
  return capabilityFromFailure(failure) === "unsupported";
}

function canTryAlternateAfterProbeError(error) {
  const failures = Array.isArray(error?.probeFailures) ? error.probeFailures : [];
  return failures.length === 0 || failures.every(canTryAlternateProtocol);
}

function capabilityFromFailure(failure) {
  if (!failure) return "inconclusive";
  if ([400, 404, 405, 415, 422, 501, 505].includes(failure.status)) return "unsupported";
  return "inconclusive";
}

function hasProviderError(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  if (typeof payload.error === "string") return payload.error.trim().length > 0;
  return Boolean(payload.error && typeof payload.error === "object");
}

function isExplicitImageRejection(response) {
  return response?.ok === false
    && capabilityFromFailure(response) === "unsupported"
    && /image|vision|multimodal|input_image|image_url|modality/i.test(String(response.message ?? ""));
}

function isReasoningEnvelopeRejection(response) {
  return response?.ok === false
    && /summary|encrypted_content|encrypted content|reasoning/i.test(String(response?.message ?? ""));
}

function isToolChoiceRejection(response) {
  return response?.ok === false
    && /tool[_ ]choice|thinking mode[^.]*tool/i.test(String(response?.message ?? ""));
}

function contractFailure(status, message) {
  return {
    ok: false,
    kind: "contract",
    status: 422,
    upstreamStatus: Number(status) || null,
    payload: null,
    message,
  };
}

function probeError(message, ...failures) {
  const relevantFailures = failures.filter(Boolean);
  const details = relevantFailures.map((failure) => failure?.message).filter(Boolean);
  const error = new Error(`${message}${details.length ? `：${details.join("；")}` : ""}`);
  error.probeFailures = relevantFailures;
  return error;
}

function upstreamMessage(payload, raw, status, apiKey) {
  const message = payload?.error?.message ?? payload?.message ?? raw ?? `HTTP ${status}`;
  const secret = String(apiKey ?? "");
  const sanitized = secret
    ? String(message).replaceAll(secret, "[凭据已隐藏]")
    : String(message);
  return sanitized.replace(/\s+/g, " ").trim().slice(0, 500) || `HTTP ${status}`;
}

function responsesOutputText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  return responseOutput(payload).filter(item => item?.type === "message")
    .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .filter(part => part?.type === "output_text")
    .map((part) => part?.text)
    .filter((text) => typeof text === "string")
    .join("\n");
}

function chatOutputText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part?.text).filter((text) => typeof text === "string").join("\n");
}

function createImageChallenge() {
  const colors = [
    { name: "red", rgb: [255, 0, 0] },
    { name: "green", rgb: [0, 180, 0] },
    { name: "blue", rgb: [0, 0, 255] },
    { name: "yellow", rgb: [255, 255, 0] },
  ];
  const ordered = [...colors];
  const seed = randomBytes(ordered.length - 1);
  for (let index = ordered.length - 1; index > 0; index -= 1) {
    const swapIndex = seed[index - 1] % (index + 1);
    [ordered[index], ordered[swapIndex]] = [ordered[swapIndex], ordered[index]];
  }
  return {
    dataUrl: `data:image/png;base64,${colorStripPng(ordered.map((item) => item.rgb), 320, 128).toString("base64")}`,
    prompt: "The image contains four vertical color panels. Read them from left to right and reply only with four lowercase basic English color names joined by hyphens.",
    expected: ordered.map((item) => item.name).join("-"),
  };
}

function colorStripPng(colors, width = 64, height = 32) {
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const color = colors[Math.min(
        colors.length - 1,
        Math.floor(x * colors.length / width),
      )];
      const offset = row + 1 + x * 3;
      raw[offset] = color[0];
      raw[offset + 1] = color[1];
      raw[offset + 2] = color[2];
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])) >>> 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
