import { StringDecoder } from "node:string_decoder";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { MAX_REQUEST_BYTES, httpError, nonEmptyString, MAX_ERROR_BODY_BYTES } from "./contract.mjs";

function parseSseBlock(block) {
  const data = block.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  if (!data || data === "[DONE]") return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function consumeResponsePayloads(stream, { onPayload, onEnd, onError }) {
  const contentType = String(stream.headers["content-type"] ?? "").toLowerCase();
  const eventStream = contentType.includes("text/event-stream");
  const observedStream = decodeObservedStream(stream);
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let jsonBody = "";
  let settled = false;
  const fail = (error) => {
    if (settled) return;
    settled = true;
    onError(error);
  };
  observedStream.on("data", (chunk) => {
    if (settled) return;
    const text = decoder.write(chunk);
    if (eventStream) {
      pending += text;
      if (pending.length > MAX_REQUEST_BYTES) {
        observedStream.destroy(httpError(502, "自定义模型响应帧过大"));
        return;
      }
      const blocks = pending.split(/\r?\n\r?\n/);
      pending = blocks.pop() ?? "";
      for (const block of blocks) {
        const payload = parseSseBlock(block);
        if (payload) onPayload(payload);
      }
      return;
    }
    jsonBody += text;
    if (jsonBody.length > MAX_REQUEST_BYTES) {
      observedStream.destroy(httpError(502, "自定义模型响应体过大"));
    }
  });
  observedStream.once("end", () => {
    if (settled) return;
    const tail = decoder.end();
    if (eventStream) {
      pending += tail;
      if (pending.trim()) {
        const payload = parseSseBlock(pending);
        if (payload) onPayload(payload);
      }
    } else {
      jsonBody += tail;
      try {
        onPayload(JSON.parse(jsonBody));
      } catch {
        fail(httpError(502, "自定义模型返回了无法解析的 JSON"));
        return;
      }
    }
    settled = true;
    onEnd();
  });
  observedStream.once("error", fail);
}

function responseEvent(value) {
  if (!value || typeof value !== "object") return null;
  if (nonEmptyString(value.type)) return value;
  if (nonEmptyString(value.id) || Array.isArray(value.output)) {
    const type = value.status === "failed"
      ? "response.failed"
      : value.status === "incomplete"
        ? "response.incomplete"
        : "response.completed";
    return { type, response: value };
  }
  return null;
}

async function readLimitedResponseText(stream) {
  const observedStream = decodeObservedStream(stream);
  const chunks = [];
  let size = 0;
  for await (const chunk of observedStream) {
    size += chunk.length;
    if (size > MAX_ERROR_BODY_BYTES) break;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function upstreamErrorMessage(statusCode, body) {
  try {
    const payload = JSON.parse(body);
    const message = nonEmptyString(payload?.error?.message ?? payload?.message);
    if (message) return `自定义模型返回 ${statusCode}：${message}`;
  } catch {}
  return `自定义模型返回 HTTP ${statusCode}`;
}

function decodeObservedStream(stream) {
  const encoding = String(stream.headers["content-encoding"] ?? "")
    .toLowerCase()
    .split(",")[0]
    .trim();
  let decoder = null;
  if (encoding === "gzip" || encoding === "x-gzip") decoder = createGunzip();
  else if (encoding === "deflate") decoder = createInflate();
  else if (encoding === "br") decoder = createBrotliDecompress();
  if (!decoder) return stream;
  stream.pipe(decoder);
  return decoder;
}

export { decodeObservedStream, parseSseBlock, consumeResponsePayloads, responseEvent, readLimitedResponseText, upstreamErrorMessage };
