import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { nonEmptyString, httpError, MAX_REQUEST_BYTES } from "./contract.mjs";
import { apiTargetUrl, upstreamWebSocketHeaders } from "./http-transport.mjs";
import { diagnosticWebSocketHandshake } from "./transport-diagnostics.mjs";

function sendWebSocketPrewarm(client, body, streamId) {
  const id = `resp_${randomUUID().replace(/-/g, "")}`;
  const base = webSocketResponse(body, id, "in_progress", null);
  sendWebSocketJson(
    client,
    withWebSocketTransport({ type: "response.created", response: base }, streamId, 0),
  );
  sendWebSocketJson(
    client,
    withWebSocketTransport({ type: "response.in_progress", response: base }, streamId, 1),
  );
  const completed = webSocketResponse(body, id, "completed", emptyResponseUsage());
  sendWebSocketJson(
    client,
    withWebSocketTransport({ type: "response.completed", response: completed }, streamId, 2),
  );
  return completed;
}

function sendWebSocketFailure(client, body, streamId, message, sequenceNumber = 0) {
  if (client.readyState !== WebSocket.OPEN) return;
  const id = `resp_${randomUUID().replace(/-/g, "")}`;
  const response = webSocketResponse(body, id, "failed", null);
  response.error = {
    code: "model_router_error",
    message: nonEmptyString(message) ?? "模型路由失败",
    type: "model_router_error",
  };
  sendWebSocketJson(
    client,
    withWebSocketTransport({ type: "response.failed", response }, streamId, sequenceNumber),
  );
}

function webSocketResponse(body, id, status, usage) {
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1_000),
    status,
    error: null,
    incomplete_details: null,
    model: nonEmptyString(body?.model) ?? "",
    output: [],
    parallel_tool_calls: body?.parallel_tool_calls !== false,
    tool_choice: body?.tool_choice ?? "auto",
    tools: Array.isArray(body?.tools) ? body.tools : [],
    usage,
  };
}

function emptyResponseUsage() {
  return {
    input_tokens: 0,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 0,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 0,
  };
}

function withWebSocketTransport(payload, streamId, sequenceNumber) {
  return {
    ...payload,
    sequence_number: Number.isInteger(payload.sequence_number)
      ? payload.sequence_number
      : sequenceNumber,
    ...(streamId ? { stream_id: streamId } : {}),
  };
}

function sendWebSocketJson(client, payload) {
  return sendWebSocketData(client, JSON.stringify(payload), false);
}

function sendWebSocketData(client, data, binary) {
  if (client.readyState !== WebSocket.OPEN) return false;
  try {
    client.send(data, { binary });
    return true;
  } catch {
    return false;
  }
}

function webSocketDataLength(data) {
  if (typeof data === "string") return Buffer.byteLength(data);
  return Number(data?.byteLength ?? data?.length) || 0;
}

function webSocketProtocols(headers) {
  const value = headers?.["sec-websocket-protocol"];
  const text = Array.isArray(value) ? value.join(",") : String(value ?? "");
  return [...new Set(text.split(",").map((item) => item.trim()).filter(Boolean))];
}

function parseWebSocketJson(data) {
  try {
    return JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
  } catch {
    return null;
  }
}

function normalizedStreamId(value) {
  return nonEmptyString(value);
}

function webSocketLane(streamId) {
  return streamId ? `stream:${streamId}` : "default";
}

function isTerminalResponseEvent(type) {
  return ["response.completed", "response.failed", "response.incomplete"].includes(type);
}

function webSocketTargetUrl(target, search) {
  return webSocketApiTargetUrl(target, "/v1/responses", search);
}

function webSocketApiTargetUrl(target, pathname, search) {
  const url = apiTargetUrl(target, pathname, search);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  else throw httpError(502, `不支持的模型上游协议：${url.protocol}`);
  return url;
}

function validWebSocketCloseCode(code) {
  return Number.isInteger(code) && code >= 1000 && code <= 4999 &&
    ![1004, 1005, 1006, 1015].includes(code);
}

function proxyAuxiliaryWebSocket(client, request, route, resolveTarget, createDiagnostic) {
    let upstream;
    let diagnostic;
    try {
      const target = resolveTarget(null, request.headers);
      const targetUrl = webSocketApiTargetUrl(
        target,
        route.pathname,
        route.incoming.search,
      );
      const headers = upstreamWebSocketHeaders(request.headers, target);
      diagnostic = createDiagnostic?.({ context: { target }, transport: "websocket-auxiliary",
        method: "GET", endpoint: route.pathname, url: targetUrl, headers });
      upstream = new WebSocket(targetUrl, webSocketProtocols(request.headers), {
        headers,
        ...(diagnostic ? { finishRequest: diagnosticWebSocketHandshake(diagnostic) } : {}),
        maxPayload: MAX_REQUEST_BYTES,
        perMessageDeflate: true,
        handshakeTimeout: 15_000,
      });
    } catch {
      client.close(1011, "模型路由失败");
      return;
    }

    const pending = [];
    let pendingBytes = 0;
    let upstreamOpen = false;
    let clientClosed = false;
    let upstreamClosed = false;

    const closeUpstream = (code, reason) => {
      if (upstreamClosed) return;
      upstreamClosed = true;
      if (upstream.readyState === WebSocket.CONNECTING) {
        upstream.terminate();
      } else if (upstream.readyState === WebSocket.OPEN) {
        upstream.close(validWebSocketCloseCode(code) ? code : 1000, reason);
      }
    };
    const closeClient = (code, reason) => {
      if (clientClosed) return;
      clientClosed = true;
      if (client.readyState === WebSocket.OPEN) {
        client.close(validWebSocketCloseCode(code) ? code : 1011, reason);
      }
    };

    client.on("message", (data, isBinary) => {
      diagnostic?.raw(data, { direction: "request", binary: isBinary });
      if (upstreamOpen) {
        sendWebSocketData(upstream, data, isBinary);
        return;
      }
      pendingBytes += webSocketDataLength(data);
      if (pendingBytes > MAX_REQUEST_BYTES) {
        closeClient(1009, "WebSocket 待转发数据过大");
        closeUpstream(1009, "WebSocket 待转发数据过大");
        return;
      }
      pending.push({ data, isBinary });
    });
    client.once("close", (code, reason) => {
      clientClosed = true;
      closeUpstream(code, reason);
    });
    client.once("error", () => closeUpstream(1011, "本地 WebSocket 连接异常"));

    upstream.once("open", () => {
      upstreamOpen = true;
      for (const message of pending.splice(0)) {
        if (!sendWebSocketData(upstream, message.data, message.isBinary)) break;
      }
      pendingBytes = 0;
    });
    upstream.on("message", (data, isBinary) => {
      diagnostic?.raw(data, { binary: isBinary });
      sendWebSocketData(client, data, isBinary);
    });
    upstream.once("close", (code, reason) => {
      diagnostic?.finish(`websocket-close:${code}`);
      upstreamClosed = true;
      closeClient(code, reason);
    });
    upstream.once("error", (error) => {
      diagnostic?.error(error);
      closeClient(1011, "官方 WebSocket 连接失败");
    });
  }

export { sendWebSocketPrewarm, sendWebSocketFailure, sendWebSocketData, webSocketProtocols, parseWebSocketJson, normalizedStreamId, webSocketLane, webSocketTargetUrl, validWebSocketCloseCode, proxyAuxiliaryWebSocket, isTerminalResponseEvent, withWebSocketTransport, sendWebSocketJson };
