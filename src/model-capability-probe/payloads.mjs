import { PROBE_TOOL_NAME } from "./contract.mjs";

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

export { hasResponseContinuation, responseOutput, findResponseToolCall, stripReasoningEnvelope, hasChatContinuation, hasReasoningEvidence, hasProtocolToolCall, imageReasoningText, responsesOutputText, chatOutputText };
