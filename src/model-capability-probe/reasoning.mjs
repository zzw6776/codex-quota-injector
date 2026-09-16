import { PROBE_REASONING_EFFORTS, PROBE_TOOL_NAME, TOOL_DEFINITION, CONTINUATION_OUTPUT_TOKENS } from "./contract.mjs";
import { chatFunctionTool } from "./tools.mjs";
import { capabilityFromFailure, probeError, isToolChoiceRejection, continuationFailure, isReasoningEnvelopeRejection } from "./failures.mjs";
import { hasReasoningEvidence, hasProtocolToolCall, hasResponseContinuation, responseOutput, findResponseToolCall, stripReasoningEnvelope } from "./payloads.mjs";

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

export { probeReasoning, probeReasoningToolChoice, probeResponsesReasoningHistory };
