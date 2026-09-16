import { MODEL_CAPABILITY_PROBE_VERSION, MODEL_CAPABILITY_PROBE_TIMEOUT_MS, PROBE_APPLY_PATCH_TOOL_NAME } from "./model-capability-probe/contract.mjs";
import { probeResponses, probeResponsesCustom, probeResponsesNamespace, probeHostedWebSearch, probeChat } from "./model-capability-probe/protocol.mjs";
import { probeReasoning, probeReasoningToolChoice, probeResponsesReasoningHistory } from "./model-capability-probe/reasoning.mjs";
import { probeStreaming, probeParallelTools, probeCodexConformance, probeAlternateChatImageRoute } from "./model-capability-probe/conformance.mjs";
import { createResponsesBridgeRequest } from "./model-capability-probe/tools.mjs";
import { unavailableProbe, normalizeTarget, canTryAlternateProtocol, canTryAlternateAfterProbeError, capabilityFromFailure, contractFailure, probeError } from "./model-capability-probe/failures.mjs";
import { runProtocolProbeWithRetry, createProbeProgressReporter, isRetryableProbeFailure } from "./model-capability-probe/progress.mjs";
import { probeImage, createImageChallenge } from "./model-capability-probe/image.mjs";
import { postJson, postStream, summarizeProbeResponse } from "./model-capability-probe/transport.mjs";

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

export { MODEL_CAPABILITY_PROBE_VERSION, MODEL_CAPABILITY_PROBE_TIMEOUT_MS } from "./model-capability-probe/contract.mjs";
