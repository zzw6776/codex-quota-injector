import { CONTINUATION_OUTPUT_TOKENS, PROBE_TOOL_NAME, TOOL_DEFINITION, PROBE_CUSTOM_TOOL_NAME, PROBE_NAMESPACE_NAME, PROBE_NAMESPACE_TOOL_NAME } from "./contract.mjs";
import { requestWithToolChoiceFallback, appendToolOutput } from "./tools.mjs";
import { continuationFailure, isReasoningEnvelopeRejection, isToolChoiceRejection, contractFailure, unavailableProbe } from "./failures.mjs";
import { hasResponseContinuation, responseOutput, findResponseToolCall, stripReasoningEnvelope, hasChatContinuation } from "./payloads.mjs";

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

export { probeResponses, probeResponsesCustom, probeResponsesNamespace, probeHostedWebSearch, probeChat };
