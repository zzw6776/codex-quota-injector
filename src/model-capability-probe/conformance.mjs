import { PROBE_PARALLEL_TOOL_NAMES, PROBE_TOOL_NAME, PROBE_CUSTOM_TOOL_NAME, PROBE_NAMESPACE_NAME, PROBE_NAMESPACE_TOOL_NAME, CODEX_CONFORMANCE_TOOL_DEFINITION } from "./contract.mjs";
import { probeChat } from "./protocol.mjs";
import { responseFunctionTool, chatFunctionTool, createResponsesBridgeRequest } from "./tools.mjs";
import { probeError, capabilityFromFailure, canTryAlternateAfterProbeError, contractFailure } from "./failures.mjs";
import { runProtocolProbeWithRetry } from "./progress.mjs";
import { responseOutput } from "./payloads.mjs";

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

export { probeStreaming, probeParallelTools, probeCodexConformance, probeAlternateChatImageRoute };
