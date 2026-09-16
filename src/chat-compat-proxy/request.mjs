import { chatToolName, collectResponseTools, findResponseTool, toChatTools, toChatCall } from "../chat-tool-adapter.mjs";
import { text } from "./contract.mjs";
import { unsupportedChatToolTypes, isForcedToolChoice, requiredUnavailableToolType } from "./policy.mjs";
import { restoreToolCalls } from "./history.mjs";

function prepareChatRequest(request, history, modelProfile = null) {
  if (!request || typeof request !== "object") throw new Error("Responses 请求体无效");
  const modelId = text(request.model);
  if (!modelId) throw new Error("Responses 请求缺少模型 ID");
  const unavailableHostedTools = unsupportedChatToolTypes(modelProfile, request);
  const selectedUnavailableType = requiredUnavailableToolType(
    request.tool_choice,
    unavailableHostedTools,
  );
  if (selectedUnavailableType) {
    throw new Error(`${modelProfile?.displayName || modelProfile?.id || "当前模型"} 不支持服务端工具 ${selectedUnavailableType}`);
  }
  const declarations = collectResponseTools(
    request,
    history.getTools(text(request.previous_response_id)),
    { ignoredTypes: unavailableHostedTools },
  );
  const input = restoreToolCalls(request, history);
  const messages = [];
  const instructions = contentText(request.instructions);
  if (instructions) messages.push({ role: "system", content: instructions });
  appendResponsesInput(messages, input, declarations);

  // Responses and Chat use opposite defaults for streaming. Preserve the caller's
  // explicit choice instead of changing a non-streaming request into SSE.
  const chat = { model: modelId, messages, stream: Boolean(request.stream) };
  if (chat.stream) chat.stream_options = { include_usage: true };
  const maxTokens = request.max_output_tokens ?? request.max_tokens ?? request.max_completion_tokens;
  if (Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0) {
    chat.max_tokens = Number(maxTokens);
  }
  for (const key of ["temperature", "top_p", "tool_choice", "parallel_tool_calls"]) {
    if (request[key] != null) chat[key] = request[key];
  }
  const reasoningEffort = text(request.reasoning?.effort) ||
    text(modelProfile?.defaultReasoningEffort);
  if (reasoningEffort) chat.reasoning_effort = reasoningEffort;
  const reasoningEnabled = Boolean(reasoningEffort && reasoningEffort !== "none");
  const toolChoiceCapability = reasoningEnabled
    ? modelProfile?.capabilities?.reasoningToolChoice
    : modelProfile?.capabilities?.toolChoice;
  if (modelProfile?.capabilities && toolChoiceCapability !== "native") {
    if (toolChoiceCapability === "auto-only" && isForcedToolChoice(chat.tool_choice)) {
      chat.tool_choice = "auto";
    } else if (toolChoiceCapability !== "auto-only") {
      delete chat.tool_choice;
    }
  }
  if (modelProfile?.capabilities && modelProfile.capabilities.parallelTools !== "native") delete chat.parallel_tool_calls;
  if ((!modelProfile?.capabilities || toolChoiceCapability === "native") &&
    ["function", "custom"].includes(request.tool_choice?.type) && text(request.tool_choice.name)) {
    const tool = findResponseTool(declarations, request.tool_choice.name, request.tool_choice.namespace);
    chat.tool_choice = { type: "function", function: { name: tool ? chatToolName(tool) : request.tool_choice.name } };
  }
  const tools = toChatTools(declarations);
  if (tools.length) chat.tools = tools;
  if (!tools.length) {
    delete chat.tool_choice;
    delete chat.parallel_tool_calls;
  }
  return { source: { ...request, tools: declarations }, chat };
}

function appendResponsesInput(messages, input, tools) {
  if (typeof input === "string") {
    if (input) messages.push({ role: "user", content: input });
    return;
  }
  const items = Array.isArray(input) ? input : input && typeof input === "object" ? [input] : [];
  let pendingCalls = [];
  let pendingReasoning = "";
  const flushCalls = () => {
    if (!pendingCalls.length) return;
    const assistant = { role: "assistant", content: null, tool_calls: pendingCalls };
    if (pendingReasoning) assistant.reasoning_content = pendingReasoning;
    messages.push(assistant);
    pendingCalls = [];
    pendingReasoning = "";
  };

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "reasoning") {
      pendingReasoning += reasoningText(item);
      continue;
    }
    if (["function_call", "custom_tool_call"].includes(item.type)) {
      if (!pendingReasoning) pendingReasoning = text(item.reasoning_content);
      const call = toChatCall(item, tools);
      if (call) pendingCalls.push(call);
      continue;
    }
    if (["function_call_output", "custom_tool_call_output"].includes(item.type)) {
      flushCalls();
      const callId = text(item.call_id);
      if (callId) messages.push({
        role: "tool",
        tool_call_id: callId,
        content: toolOutputText(item.output),
      });
      continue;
    }
    flushCalls();
    const message = responseItemToChatMessage(item);
    if (message) {
      if (message.role === "assistant" && pendingReasoning) {
        message.reasoning_content = pendingReasoning;
      }
      messages.push(message);
      pendingReasoning = "";
    }
  }
  flushCalls();
}

function responseItemToChatMessage(item) {
  const role = ["system", "developer", "user", "assistant"].includes(item.role)
    ? item.role
    : "user";
  if (item.type === "input_text") return { role, content: text(item.text) };
  const content = responseContentToChatContent(item.content ?? item);
  if (content == null || content === "") return null;
  return { role, content };
}

function responseContentToChatContent(value) {
  if (typeof value === "string") return value;
  const parts = Array.isArray(value) ? value : [value];
  const content = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const type = text(part.type);
    const valueText = text(part.text ?? part.content);
    if (["input_text", "output_text", "text"].includes(type) && valueText) {
      content.push({ type: "text", text: valueText });
      continue;
    }
    const imageUrl = text(part.image_url?.url ?? part.image_url ?? part.url);
    if (["input_image", "image_url"].includes(type) && imageUrl) {
      content.push({ type: "image_url", image_url: { url: imageUrl } });
    }
  }
  if (!content.length) return "";
  return content.length === 1 && content[0].type === "text" ? content[0].text : content;
}

function reasoningText(item) {
  if (typeof item?.reasoning_text === "string") return item.reasoning_text;
  const content = Array.isArray(item?.content) ? item.content : [];
  const reasoning = content.filter((part) => part?.type === "reasoning_text")
    .map((part) => text(part.text)).join("");
  if (reasoning) return reasoning;
  const summary = Array.isArray(item?.summary) ? item.summary : [];
  return summary.map((part) => text(part?.text)).join("");
}

function toolOutputText(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return JSON.stringify(value);
}

function contentText(value) {
  if (typeof value === "string") return value;
  const content = responseContentToChatContent(value);
  if (typeof content === "string") return content;
  return Array.isArray(content)
    ? content.filter((part) => part?.type === "text").map((part) => text(part.text)).join("\n")
    : "";
}

export { prepareChatRequest };
