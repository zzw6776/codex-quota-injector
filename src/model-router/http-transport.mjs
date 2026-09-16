import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { MODEL_ROUTER_TOKEN_HEADER, HOP_BY_HOP_HEADERS, safeTokenEqual, httpError, MAX_REQUEST_BYTES, REQUEST_DECODERS, nonEmptyString } from "./contract.mjs";
import { observeResponse } from "./response-observation.mjs";

function requestHeaders(source, target, contentLength) {
  const headers = upstreamHeaders(source, target);
  // The rewritten body is plain JSON, not the caller's compressed bytes.
  delete headers["content-encoding"];
  headers["content-type"] = "application/json";
  headers["content-length"] = String(contentLength);
  return headers;
}

function rawRequestHeaders(source, target, contentLength) {
  const headers = upstreamHeaders(source, target);
  if (contentLength > 0 || source?.["content-length"] != null) {
    headers["content-length"] = String(contentLength);
  }
  return headers;
}

function upstreamHeaders(source, target) {
  const headers = normalizedHeaders(source);
  delete headers[MODEL_ROUTER_TOKEN_HEADER];
  if (target.kind === "custom") {
    for (const name of Object.keys(headers)) {
      const normalized = name.toLowerCase();
      if (
        normalized === "authorization" ||
        normalized === "chatgpt-account-id" ||
        normalized === "originator" ||
        normalized === "session-id" ||
        normalized === "thread-id" ||
        normalized.startsWith("x-codex-") ||
        normalized.startsWith("x-oai-") ||
        normalized.startsWith("x-openai-")
      ) {
        delete headers[name];
      }
    }
    headers.authorization = `Bearer ${target.apiKey}`;
  }
  return headers;
}

function upstreamWebSocketHeaders(source, target) {
  const headers = upstreamHeaders(source, target);
  delete headers.origin;
  delete headers["content-type"];
  return headers;
}

function responseHeaders(source) {
  return normalizedHeaders(source);
}

function normalizedHeaders(source) {
  const result = {};
  for (const [name, value] of Object.entries(source ?? {})) {
    const normalized = name.toLowerCase();
    if (value == null || HOP_BY_HOP_HEADERS.has(normalized)) continue;
    if (normalized === "content-length" || normalized.startsWith("sec-websocket-")) continue;
    result[normalized] = value;
  }
  return result;
}

function authenticatedRoute(request, token) {
  const incoming = new URL(request.url ?? "/", "http://127.0.0.1");
  const tokenPrefix = `/${token}`;
  const pathAuthenticated = incoming.pathname === tokenPrefix ||
    incoming.pathname.startsWith(`${tokenPrefix}/`);
  const headerAuthenticated = safeTokenEqual(request.headers[MODEL_ROUTER_TOKEN_HEADER], token);
  if (!pathAuthenticated && !headerAuthenticated) {
    throw httpError(403, "本机模型路由认证失败");
  }
  return {
    incoming,
    pathname: pathAuthenticated
      ? incoming.pathname.slice(tokenPrefix.length) || "/"
      : incoming.pathname,
  };
}

function isApiPath(pathname) {
  return pathname === "/v1" || pathname === "/v1/" || pathname.startsWith("/v1/");
}

function isResponsesPath(pathname) {
  return pathname === "/v1/responses" || pathname === "/v1/responses/";
}

function isModelsPath(pathname) {
  return pathname === "/v1/models" || pathname === "/v1/models/";
}

function apiTargetUrl(target, pathname, search = "") {
  if (!isApiPath(pathname)) throw httpError(404, "模型路由仅代理 OpenAI API 请求");
  const targetUrl = new URL(target.baseUrl);
  const basePath = targetUrl.pathname.endsWith("/")
    ? targetUrl.pathname
    : `${targetUrl.pathname}/`;
  const relativePath = pathname.startsWith("/v1/") ? pathname.slice(4) : "";
  targetUrl.pathname = `${basePath}${relativePath}`;
  targetUrl.search = search;
  targetUrl.hash = "";
  return targetUrl;
}

async function readRequestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw httpError(413, "API 请求体过大");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function parseRequestJson(payload, headers, { required = false } = {}) {
  if (!required && payload.length === 0) return null;
  const contentType = String(headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  const encodings = String(headers["content-encoding"] ?? "")
    .toLowerCase().split(",").map((value) => value.trim()).filter(Boolean);
  // Future binary endpoints must remain opaque. JSON auxiliary requests still
  // need decoding so an explicit custom model cannot fall through to OpenAI.
  if (!required && encodings.length && contentType &&
      contentType !== "application/json" && !contentType.endsWith("+json")) return null;
  let decoded = payload;
  for (const encoding of encodings.reverse()) {
    if (encoding === "identity") continue;
    const decode = REQUEST_DECODERS.get(encoding);
    if (!decode) throw httpError(415, `不支持的请求 Content-Encoding：${encoding}`);
    try {
      decoded = await decode(decoded, { maxOutputLength: MAX_REQUEST_BYTES });
    } catch (error) {
      if (error?.code === "ERR_BUFFER_TOO_LARGE") {
        throw httpError(413, "API 请求体解压后过大");
      }
      throw httpError(400, `无法解压 ${encoding} 请求体`);
    }
  }
  try {
    return JSON.parse(decoded.toString("utf8"));
  } catch {
    if (required) throw httpError(400, "无法解析 Responses JSON 请求");
    return null;
  }
}

function writeError(response, statusCode, message) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: { message, type: "model_router_error" } }));
}

function rejectUpgrade(socket, statusCode, message) {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const body = JSON.stringify({
    error: {
      message: nonEmptyString(message) ?? "模型路由失败",
      type: "model_router_error",
    },
  });
  socket.end([
    `HTTP/1.1 ${statusCode} Model Router Error`,
    "Connection: close",
    "Content-Type: application/json; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "",
    body,
  ].join("\r\n"));
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
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
    server.listen(port, "127.0.0.1");
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function closeWebSocketServer(server) {
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

async function forwardModelResponse(request, response, targetUrl, payload, target, context, { onUsage, onToolCall, onGeneration }) {
    const headers = target.kind === "official"
      ? rawRequestHeaders(request.headers, target, payload.length)
      : requestHeaders(request.headers, target, payload.length);
    const transport = targetUrl.protocol === "https:" ? requestHttps : requestHttp;
    return new Promise((resolve) => {
      let accepted = false;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve(accepted);
      };
      const upstream = transport(targetUrl, {
        method: "POST",
        headers,
      }, (upstreamResponse) => {
        const statusCode = upstreamResponse.statusCode ?? 502;
        accepted = statusCode >= 200 && statusCode < 300;
        if (statusCode >= 400 && target.kind === "custom") {
          console.error(
            `[model-router] ${target.displayName} 上游返回 ${statusCode}；` +
            `脱敏请求结构=${JSON.stringify(context.requestShape ?? null)}`,
          );
        }
        response.writeHead(
          statusCode,
          responseHeaders(upstreamResponse.headers),
        );
        if (accepted) {
          observeResponse(upstreamResponse, {
            requestStartedAt: context.requestStartedAt,
            onUsage: onUsage,
            onToolCall: onToolCall,
            onGeneration: onGeneration,
            onFailure: target.kind === "custom" ? () => {
              console.error(
                `[model-router] ${target.displayName} 上游响应失败；` +
                `脱敏请求结构=${JSON.stringify(context.requestShape ?? null)}`,
              );
            } : undefined,
          });
        }
        upstreamResponse.once("error", (error) => {
          if (!response.destroyed) response.destroy(error);
          finish();
        });
        upstreamResponse.once("end", finish);
        upstreamResponse.once("close", finish);
        upstreamResponse.pipe(response);
      });
      upstream.once("error", (error) => {
        writeError(response, 502, `模型上游请求失败：${error.message}`);
        finish();
      });
      response.once("close", () => {
        if (!response.writableFinished) {
          upstream.destroy();
          finish();
        }
      });
      upstream.end(payload);
    });
  }

export { rawRequestHeaders, upstreamWebSocketHeaders, responseHeaders, authenticatedRoute, isApiPath, isResponsesPath, isModelsPath, apiTargetUrl, readRequestBody, parseRequestJson, writeError, rejectUpgrade, listen, delay, closeServer, closeWebSocketServer, forwardModelResponse, requestHeaders };
