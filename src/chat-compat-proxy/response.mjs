import { randomUUID } from "node:crypto";
import { findResponseTool, responseCall } from "../chat-tool-adapter.mjs";
import { text } from "./contract.mjs";
import { writeSse, extractErrorMessage } from "./transport.mjs";

class ChatResponseState {
  constructor(source, onCompleted) {
    this.id = `resp_${randomUUID().replace(/-/g, "")}`;
    this.model = text(source.model);
    this.createdAt = Math.floor(Date.now() / 1000);
    this.onCompleted = onCompleted;
    this.started = false;
    this.finished = false;
    this.text = "";
    this.reasoning = "";
    this.textIndex = null;
    this.reasoningIndex = null;
    this.tools = new Map();
    this.declarations = source.tools ?? [];
    this.nextOutputIndex = 0;
    this.usage = null;
    this.finishReason = null;
  }

  accept(response, chunk) {
    if (this.finished) return;
    if (text(chunk.id)) this.id = responseId(text(chunk.id));
    if (text(chunk.model)) this.model = text(chunk.model);
    if (Number.isFinite(Number(chunk.created))) this.createdAt = Number(chunk.created);
    if (chunk.usage && typeof chunk.usage === "object") this.usage = chunk.usage;
    this.start(response);
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
    const delta = choice?.delta;
    if (delta && typeof delta === "object") {
      const reasoning = text(delta.reasoning_content ?? delta.reasoning);
      if (reasoning) this.pushReasoning(response, reasoning);
      const content = text(delta.content);
      if (content) this.pushText(response, content);
      if (Array.isArray(delta.tool_calls)) {
        for (const tool of delta.tool_calls) this.pushTool(response, tool);
      }
    }
    if (text(choice?.finish_reason)) this.finishReason = choice.finish_reason;
  }

  start(response) {
    if (this.started) return;
    this.started = true;
    const base = this.response("in_progress", []);
    writeSse(response, "response.created", { type: "response.created", response: base });
    writeSse(response, "response.in_progress", { type: "response.in_progress", response: base });
  }

  pushReasoning(response, delta) {
    if (this.reasoningIndex == null) {
      this.reasoningIndex = this.nextOutputIndex++;
      const itemId = `rs_${this.id}`;
      this.reasoningItemId = itemId;
      writeSse(response, "response.output_item.added", {
        type: "response.output_item.added", output_index: this.reasoningIndex,
        item: { id: itemId, type: "reasoning", status: "in_progress", summary: [] },
      });
      writeSse(response, "response.reasoning_summary_part.added", {
        type: "response.reasoning_summary_part.added", item_id: itemId,
        output_index: this.reasoningIndex, summary_index: 0,
        part: { type: "summary_text", text: "" },
      });
    }
    this.reasoning += delta;
    writeSse(response, "response.reasoning_summary_text.delta", {
      type: "response.reasoning_summary_text.delta", item_id: this.reasoningItemId,
      output_index: this.reasoningIndex, summary_index: 0, delta,
    });
  }

  pushText(response, delta) {
    if (this.textIndex == null) {
      this.textIndex = this.nextOutputIndex++;
      this.textItemId = `${this.id}_msg`;
      writeSse(response, "response.output_item.added", {
        type: "response.output_item.added", output_index: this.textIndex,
        item: { id: this.textItemId, type: "message", status: "in_progress", role: "assistant", content: [] },
      });
      writeSse(response, "response.content_part.added", {
        type: "response.content_part.added", item_id: this.textItemId,
        output_index: this.textIndex, content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
    }
    this.text += delta;
    writeSse(response, "response.output_text.delta", {
      type: "response.output_text.delta", item_id: this.textItemId,
      output_index: this.textIndex, content_index: 0, delta,
    });
  }

  pushTool(response, delta) {
    const key = Number.isInteger(delta?.index) ? delta.index : this.findToolKey(delta);
    let tool = this.tools.get(key);
    if (!tool) {
      tool = { callId: "", name: "", arguments: "", sentArguments: 0, index: null, itemId: "" };
      this.tools.set(key, tool);
    }
    const functionValue = delta?.function && typeof delta.function === "object" ? delta.function : {};
    if (text(delta?.id)) tool.callId = text(delta.id);
    if (text(functionValue.name)) tool.name = text(functionValue.name);
    if (typeof functionValue.arguments === "string") tool.arguments += functionValue.arguments;
    this.ensureToolStarted(response, tool);
  }

  findToolKey(delta) {
    const id = text(delta?.id);
    if (id) {
      for (const [key, tool] of this.tools) if (tool.callId === id) return key;
    }
    return this.tools.size;
  }

  ensureToolStarted(response, tool) {
    if (!tool.callId || !tool.name) return;
    if (tool.index == null) {
      tool.index = this.nextOutputIndex++;
      tool.itemId = `fc_${tool.callId}`;
      writeSse(response, "response.output_item.added", {
        type: "response.output_item.added", output_index: tool.index,
        item: this.functionCallItem(tool, "in_progress", ""),
      });
    }
    if (findResponseTool(this.declarations, tool.name)?.type !== "custom" && tool.sentArguments < tool.arguments.length) {
      const delta = tool.arguments.slice(tool.sentArguments);
      tool.sentArguments = tool.arguments.length;
      writeSse(response, "response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta", item_id: tool.itemId,
        output_index: tool.index, delta,
      });
    }
  }

  finish(response) {
    if (this.finished) return;
    // Validate custom input before publishing any terminal items. A malformed
    // JSON wrapper must fail the turn rather than execute a changed raw command.
    try {
      for (const tool of this.tools.values()) {
        if (tool.callId && tool.name) this.functionCallItem(tool, "completed", tool.arguments);
      }
    } catch (error) { this.fail(response, error.message); return; }
    this.start(response);
    const output = [];
    if (this.reasoningIndex != null) {
      const item = { id: this.reasoningItemId, type: "reasoning", summary: [{ type: "summary_text", text: this.reasoning }] };
      writeSse(response, "response.reasoning_summary_text.done", {
        type: "response.reasoning_summary_text.done", item_id: this.reasoningItemId,
        output_index: this.reasoningIndex, summary_index: 0, text: this.reasoning,
      });
      writeSse(response, "response.reasoning_summary_part.done", {
        type: "response.reasoning_summary_part.done", item_id: this.reasoningItemId,
        output_index: this.reasoningIndex, summary_index: 0,
        part: { type: "summary_text", text: this.reasoning },
      });
      writeSse(response, "response.output_item.done", {
        type: "response.output_item.done", output_index: this.reasoningIndex, item,
      });
      output.push({ index: this.reasoningIndex, item });
    }
    if (this.textIndex != null) {
      const item = messageItem(this.textItemId, this.text);
      writeSse(response, "response.output_text.done", {
        type: "response.output_text.done", item_id: this.textItemId,
        output_index: this.textIndex, content_index: 0, text: this.text,
      });
      writeSse(response, "response.content_part.done", {
        type: "response.content_part.done", item_id: this.textItemId,
        output_index: this.textIndex, content_index: 0,
        part: { type: "output_text", text: this.text, annotations: [] },
      });
      writeSse(response, "response.output_item.done", {
        type: "response.output_item.done", output_index: this.textIndex, item,
      });
      output.push({ index: this.textIndex, item });
    }
    for (const tool of this.tools.values()) {
      this.ensureToolStarted(response, tool);
      if (tool.index == null) continue;
      const item = this.functionCallItem(tool, "completed", tool.arguments);
      if (item.type === "custom_tool_call") writeSse(response, "response.custom_tool_call_input.delta", {
        type: "response.custom_tool_call_input.delta", item_id: tool.itemId, output_index: tool.index, delta: item.input,
      });
      const done = item.type === "custom_tool_call" ? "response.custom_tool_call_input.done" : "response.function_call_arguments.done";
      writeSse(response, done, {
        type: done, item_id: tool.itemId, output_index: tool.index,
        ...(item.type === "custom_tool_call" ? { input: item.input } : { arguments: tool.arguments }),
      });
      writeSse(response, "response.output_item.done", {
        type: "response.output_item.done", output_index: tool.index, item,
      });
      output.push({ index: tool.index, item });
    }
    const status = this.finishReason === "length" ? "incomplete" : "completed";
    const completed = this.response(
      status,
      output.sort((left, right) => left.index - right.index).map((entry) => entry.item),
    );
    if (status === "incomplete") completed.incomplete_details = { reason: "max_output_tokens" };
    const terminalEvent = status === "incomplete"
      ? "response.incomplete"
      : "response.completed";
    writeSse(response, terminalEvent, { type: terminalEvent, response: completed });
    this.onCompleted(completed);
    this.finished = true;
  }

  fail(response, message) {
    if (this.finished) return;
    this.start(response);
    const failed = this.response("failed", []);
    failed.error = { message, type: "upstream_error" };
    writeSse(response, "response.failed", { type: "response.failed", response: failed });
    this.finished = true;
  }

  functionCallItem(tool, status, argumentText) {
    const item = responseCall(findResponseTool(this.declarations, tool.name), {
      id: tool.itemId, status, callId: tool.callId, name: tool.name, arguments: argumentText,
    });
    if (this.reasoning) item.reasoning_content = this.reasoning;
    return item;
  }

  response(status, output) {
    return {
      id: this.id,
      object: "response",
      created_at: this.createdAt,
      status,
      model: this.model,
      output,
      usage: chatUsage(this.usage),
    };
  }
}

function chatJsonToResponse(chat, source) {
  if (chat?.error) throw new Error(extractErrorMessage(JSON.stringify(chat)));
  if (!Array.isArray(chat?.choices) || !chat.choices[0]?.message ||
    typeof chat.choices[0].message !== "object") {
    throw new Error("Chat 响应缺少有效的 choices[0].message");
  }
  const message = Array.isArray(chat?.choices) ? chat.choices[0]?.message ?? {} : {};
  const id = responseId(text(chat?.id));
  const output = [];
  const reasoning = text(message.reasoning_content ?? message.reasoning);
  if (reasoning) output.push({
    id: `rs_${id}`,
    type: "reasoning",
    summary: [{ type: "summary_text", text: reasoning }],
  });
  const content = text(message.content);
  if (content) output.push(messageItem(`${id}_msg`, content));
  for (const [index, tool] of (Array.isArray(message.tool_calls) ? message.tool_calls : []).entries()) {
    const callId = text(tool?.id) || `call_${index}`;
    const name = text(tool?.function?.name);
    if (!name) continue;
    const item = responseCall(findResponseTool(source.tools ?? [], name), {
      id: `fc_${callId}`, status: "completed", callId, name,
      arguments: typeof tool.function?.arguments === "string"
        ? tool.function.arguments
        : JSON.stringify(tool.function?.arguments ?? {}),
    });
    if (reasoning) item.reasoning_content = reasoning;
    output.push(item);
  }
  const status = text(chat?.choices?.[0]?.finish_reason) === "length" ? "incomplete" : "completed";
  const response = {
    id,
    object: "response",
    created_at: Number(chat?.created) || Math.floor(Date.now() / 1000),
    status,
    model: text(chat?.model) || text(source?.model),
    output,
    usage: chatUsage(chat?.usage),
  };
  if (status === "incomplete") response.incomplete_details = { reason: "max_output_tokens" };
  return response;
}

function messageItem(id, textValue) {
  return {
    id,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: textValue, annotations: [] }],
  };
}

function chatUsage(value) {
  if (!value || typeof value !== "object") return null;
  const inputTokens = Number(value.prompt_tokens ?? value.input_tokens ?? 0);
  const outputTokens = Number(value.completion_tokens ?? value.output_tokens ?? 0);
  const cachedTokens = Number(value.prompt_tokens_details?.cached_tokens ?? value.input_tokens_details?.cached_tokens ?? 0);
  const reasoningTokens = Number(value.completion_tokens_details?.reasoning_tokens ?? value.output_tokens_details?.reasoning_tokens ?? 0);
  return {
    input_tokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    input_tokens_details: { cached_tokens: Number.isFinite(cachedTokens) ? cachedTokens : 0 },
    output_tokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    output_tokens_details: { reasoning_tokens: Number.isFinite(reasoningTokens) ? reasoningTokens : 0 },
    total_tokens: Math.max(0, inputTokens || 0) + Math.max(0, outputTokens || 0),
  };
}

function responseId(value) {
  if (!value) return `resp_${randomUUID().replace(/-/g, "")}`;
  return value.startsWith("resp_") ? value : `resp_${value.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

export { chatJsonToResponse, ChatResponseState };
