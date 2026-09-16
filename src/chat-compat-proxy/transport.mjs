import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { HOP_BY_HOP_HEADERS, text } from "./contract.mjs";

function resolveTarget(requestUrl, targets) {
  const incoming = new URL(requestUrl ?? "/", "http://127.0.0.1");
  const [, rawPlatformId, ...pathParts] = incoming.pathname.split("/");
  const platformId = decodeURIComponent(rawPlatformId ?? "");
  const target = targets.get(platformId);
  if (!target) throw new Error("未知的模型兼容平台路由");
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

async function forwardUpstreamError(upstream, response, protocol) {
  try {
    const body = await readBodyText(upstream);
    writeError(response, upstream.statusCode ?? 502, `${protocol} 上游返回错误：${extractErrorMessage(body)}`);
  } catch (error) {
    writeError(response, 502, `${protocol} 上游错误响应中断：${error.message}`);
  }
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
    upstreamResponse.once("error", () => response.destroy());
    upstreamResponse.pipe(response);
  });
  upstream.once("error", (error) => writeError(response, 502, `上游请求失败：${error.message}`));
  forwardClientCancellation(response, upstream);
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
    upstreamResponse.once("error", () => response.destroy());
    upstreamResponse.pipe(response);
  });
  upstream.once("error", (error) => writeError(response, 502, `上游请求失败：${error.message}`));
  forwardClientCancellation(response, upstream);
  upstream.end(body);
}

function forwardClientCancellation(response, upstream) {
  response.once("close", () => {
    if (!response.writableFinished) upstream.destroy();
  });
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
  if (response.destroyed || response.headersSent || response.writableEnded) {
    response.destroy();
    return;
  }
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: { message } }));
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

export { listen, closeServer, resolveTarget, isResponsesRequest, readJsonBody, forwardPassthrough, forwardJson, writeError, forwardUpstreamError, normalizedHeaders, forwardClientCancellation, readBodyText, extractErrorMessage, writeSse };
