import { createServer, request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { randomUUID } from "node:crypto";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const MAX_CACHED_RESPONSES = 512;

/**
 * Bridges the Codex-required Responses wire protocol to Chat Completions for
 * platforms whose native Responses implementation cannot continue tool calls.
 */
export async function startChatCompatibilityProxy(platforms) {
  const targets = new Map(
    [...platforms.values()]
      .filter((platform) =>
        platform.enabled && platform.models.some((model) => model.chatCompatibility),
      )
      .map((platform) => [platform.id, platform]),
  );
  if (targets.size === 0) return null;

  const history = createToolCallHistory();
  const server = createServer((request, response) => {
    void proxyRequest(request, response, targets, history);
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Chat 兼容代理未获取到本地监听端口");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    baseUrlFor(platform) {
      return targets.has(platform.id)
        ? `${origin}/${encodeURIComponent(platform.id)}/`
        : platform.baseUrl;
    },
    close: () => closeServer(server),
  };
}

async function proxyRequest(request, response, targets, history) {
  let route;
  try {
    route = resolveTarget(request.url, targets);
    if (!isResponsesRequest(request, route.path)) {
      forwardPassthrough(request, response, route.url);
      return;
    }
    const body = await readJsonBody(request);
    if (!route.target.models.some((model) => model.id === text(body?.model) && model.chatCompatibility)) {
      forwardJson(request.headers, response, route.url, body);
      return;
    }
    const prepared = prepareChatRequest(body, history);
    const targetUrl = new URL(`chat/completions${route.search}`, route.target.baseUrl);
    forwardChatRequest(request.headers, response, targetUrl, prepared, history);
  } catch (error) {
    writeError(response, 502, `Chat 兼容代理请求失败：${error.message}`);
  }
}

function resolveTarget(requestUrl, targets) {
  const incoming = new URL(requestUrl ?? "/", "http://127.0.0.1");
  const [, rawPlatformId, ...pathParts] = incoming.pathname.split("/");
  const platformId = decodeURIComponent(rawPlatformId ?? "");
  const target = targets.get(platformId);
  if (!target) throw new Error("未知的 Chat 兼容平台路由");
  return {
    target,
    path: `/${pathParts.join("/")}`,
    search: incoming.search,
    url: new URL(`${pathParts.join("/")}${incoming.search}`, target.baseUrl),
  };
}

function isResponsesRequest(request, path) {
  const contentType = String(request.headers["content-type"] ?? "").toLowerCase();
  return request.method === "POST" && /\/responses\/?$/.test(path) &&
    contentType.includes("application/json") && !request.headers["content-encoding"];
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("无法解析 Responses JSON 请求");
  }
}

function prepareChatRequest(request, history) {
  if (!request || typeof request !== "object") throw new Error("Responses 请求体无效");
  const model = text(request.model);
  if (!model) throw new Error("Responses 请求缺少模型 ID");
  const input = restoreToolCalls(request, history);
  const messages = [];
  const instructions = contentText(request.instructions);
  if (instructions) messages.push({ role: "system", content: instructions });
  appendResponsesInput(messages, input);

  // Responses and Chat use opposite defaults for streaming. Preserve the caller's
  // explicit choice instead of changing a non-streaming request into SSE.
  const chat = { model, messages, stream: Boolean(request.stream) };
  const maxTokens = request.max_output_tokens ?? request.max_tokens ?? request.max_completion_tokens;
  if (Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0) {
    chat.max_tokens = Number(maxTokens);
  }
  for (const key of ["temperature", "top_p", "tool_choice", "parallel_tool_calls"]) {
    if (request[key] != null) chat[key] = request[key];
  }
  const tools = Array.isArray(request.tools)
    ? request.tools.map(responseToolToChatTool).filter(Boolean)
    : [];
  if (tools.length) chat.tools = tools;
  if (!tools.length) {
    delete chat.tool_choice;
    delete chat.parallel_tool_calls;
  }
  return { source: request, chat };
}

function restoreToolCalls(request, history) {
  const source = Array.isArray(request.input) ? [...request.input] : request.input;
  const previousResponseId = text(request.previous_response_id);
  if (!previousResponseId || !Array.isArray(source)) return source;
  const outputCallIds = new Set(source
    .filter((item) => item?.type === "function_call_output")
    .map((item) => text(item.call_id))
    .filter(Boolean));
  // Only tool-result continuations require us to restore the assistant tool call.
  // A normal next user turn has no such dependency.
  if (!outputCallIds.size) return source;
  const cachedCalls = history.get(previousResponseId);
  if (!cachedCalls?.length) {
    throw new Error(
      `未找到 previous_response_id=${previousResponseId} 对应的工具调用；` +
      "请新建任务后再使用 Chat 兼容模式",
    );
  }
  const existingCallIds = new Set(source
    .filter((item) => item?.type === "function_call")
    .map((item) => text(item.call_id))
    .filter(Boolean));
  const restored = cachedCalls.filter((item) =>
    outputCallIds.has(text(item.call_id)) && !existingCallIds.has(text(item.call_id)),
  );
  if (!restored.length) return source;
  const firstOutputIndex = source.findIndex((item) => item?.type === "function_call_output");
  return [
    ...source.slice(0, firstOutputIndex),
    ...restored,
    ...source.slice(firstOutputIndex),
  ];
}

function appendResponsesInput(messages, input) {
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
    if (item.type === "function_call") {
      if (!pendingReasoning) pendingReasoning = text(item.reasoning_content);
      const call = responseFunctionCallToChat(item);
      if (call) pendingCalls.push(call);
      continue;
    }
    if (item.type === "function_call_output") {
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
    if (message) messages.push(message);
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

function responseFunctionCallToChat(item) {
  const id = text(item.call_id);
  const name = text(item.name);
  if (!id || !name) return null;
  const call = {
    id,
    type: "function",
    function: {
      name,
      arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
    },
  };
  return call;
}

function responseToolToChatTool(tool) {
  if (tool?.type !== "function" || !text(tool.name)) return null;
  const fn = { name: tool.name };
  if (text(tool.description)) fn.description = tool.description;
  if (tool.parameters && typeof tool.parameters === "object") fn.parameters = tool.parameters;
  if (tool.strict != null) fn.strict = Boolean(tool.strict);
  return { type: "function", function: fn };
}

function forwardChatRequest(requestHeaders, response, targetUrl, prepared, history) {
  const body = Buffer.from(JSON.stringify(prepared.chat));
  const headers = normalizedHeaders(requestHeaders, true);
  headers["content-type"] = "application/json";
  headers["content-length"] = String(body.length);
  const transport = targetUrl.protocol === "https:" ? requestHttps : requestHttp;
  const upstream = transport(targetUrl, { method: "POST", headers }, (upstreamResponse) => {
    if ((upstreamResponse.statusCode ?? 502) < 200 || (upstreamResponse.statusCode ?? 502) >= 300) {
      void forwardUpstreamError(upstreamResponse, response);
      return;
    }
    if (prepared.chat.stream) {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      pipeChatStream(upstreamResponse, response, prepared.source, history);
      return;
    }
    void forwardChatJson(upstreamResponse, response, prepared.source, history);
  });
  upstream.once("error", (error) => writeError(response, 502, `Chat 上游请求失败：${error.message}`));
  upstream.end(body);
}

async function forwardUpstreamError(upstream, response) {
  const body = await readBodyText(upstream);
  writeError(response, upstream.statusCode ?? 502, `Chat 上游返回错误：${extractErrorMessage(body)}`);
}

async function forwardChatJson(upstream, response, source, history) {
  try {
    const body = JSON.parse(await readBodyText(upstream));
    const converted = chatJsonToResponse(body, source);
    history.remember(converted);
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(converted));
  } catch (error) {
    writeError(response, 502, `Chat 响应转换失败：${error.message}`);
  }
}

function pipeChatStream(upstream, response, source, history) {
  let pending = "";
  const state = new ChatResponseState(source, (completed) => history.remember(completed));
  upstream.on("data", (chunk) => {
    pending += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    const blocks = pending.split(/\r?\n\r?\n/);
    pending = blocks.pop() ?? "";
    for (const block of blocks) {
      const data = block.split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data) continue;
      if (data === "[DONE]") {
        state.finish(response);
        continue;
      }
      try {
        const value = JSON.parse(data);
        if (value.error) {
          state.fail(response, extractErrorMessage(JSON.stringify(value)));
          continue;
        }
        state.accept(response, value);
      } catch {
        // Keep proxying valid frames even if a gateway sends a malformed keepalive frame.
      }
    }
  });
  upstream.once("end", () => {
    if (!state.finished) state.finish(response);
    response.end();
  });
  upstream.once("error", (error) => {
    state.fail(response, `Chat 流中断：${error.message}`);
    response.end();
  });
}

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
    this.nextOutputIndex = 0;
    this.usage = null;
    this.finishReason = null;
  }

  accept(response, chunk) {
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
    if (tool.sentArguments < tool.arguments.length) {
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
      writeSse(response, "response.function_call_arguments.done", {
        type: "response.function_call_arguments.done", item_id: tool.itemId,
        output_index: tool.index, arguments: tool.arguments,
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
    writeSse(response, "response.completed", { type: "response.completed", response: completed });
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
    const item = {
      id: tool.itemId,
      type: "function_call",
      status,
      call_id: tool.callId,
      name: tool.name,
      arguments: argumentText,
    };
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
    const item = {
      id: `fc_${callId}`,
      type: "function_call",
      status: "completed",
      call_id: callId,
      name,
      arguments: typeof tool.function?.arguments === "string"
        ? tool.function.arguments
        : JSON.stringify(tool.function?.arguments ?? {}),
    };
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

function createToolCallHistory() {
  const records = new Map();
  return {
    get(responseId) {
      return records.get(responseId) ?? null;
    },
    remember(response) {
      const calls = Array.isArray(response?.output)
        ? response.output.filter((item) => item?.type === "function_call" && text(item.call_id))
        : [];
      if (!text(response?.id) || !calls.length) return;
      records.set(response.id, calls);
      while (records.size > MAX_CACHED_RESPONSES) records.delete(records.keys().next().value);
    },
  };
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

function reasoningText(item) {
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

function responseId(value) {
  if (!value) return `resp_${randomUUID().replace(/-/g, "")}`;
  return value.startsWith("resp_") ? value : `resp_${value.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function normalizedHeaders(headers, replaceBody) {
  const result = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value == null || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    if (replaceBody && name.toLowerCase() === "content-length") continue;
    result[name] = value;
  }
  if (replaceBody) delete result["transfer-encoding"];
  return result;
}

function forwardPassthrough(request, response, targetUrl) {
  const transport = targetUrl.protocol === "https:" ? requestHttps : requestHttp;
  const upstream = transport(targetUrl, {
    method: request.method,
    headers: normalizedHeaders(request.headers, false),
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.once("error", (error) => writeError(response, 502, `上游请求失败：${error.message}`));
  request.pipe(upstream);
}

function forwardJson(requestHeaders, response, targetUrl, value) {
  const body = Buffer.from(JSON.stringify(value));
  const headers = normalizedHeaders(requestHeaders, true);
  headers["content-type"] = "application/json";
  headers["content-length"] = String(body.length);
  const transport = targetUrl.protocol === "https:" ? requestHttps : requestHttp;
  const upstream = transport(targetUrl, { method: "POST", headers }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.once("error", (error) => writeError(response, 502, `上游请求失败：${error.message}`));
  upstream.end(body);
}

async function readBodyText(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function extractErrorMessage(raw) {
  try {
    const parsed = JSON.parse(raw);
    const error = parsed?.error ?? parsed;
    return text(error?.message ?? error?.detail ?? error) || raw || "未知错误";
  } catch {
    return raw || "未知错误";
  }
}

function writeSse(response, event, data) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function writeError(response, statusCode, message) {
  if (response.headersSent || response.writableEnded) {
    response.destroy();
    return;
  }
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: { message } }));
}

function text(value) {
  return typeof value === "string" ? value : "";
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}
