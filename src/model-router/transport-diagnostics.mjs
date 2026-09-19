import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { createBrotliDecompress, createGunzip, createInflate, createZstdDecompress } from "node:zlib";
import { RELAY_PROTOCOL_VERSION } from "../relay-contract.mjs";
import { turnStateSummaries, uniqueTurnStateSummaries } from "./turn-state.mjs";

export const TRANSPORT_DIAGNOSTICS_VERSION = 2;
const MAX_FRAME_CHARS = 256 * 1024;
const terminalTypes = new Set(["response.completed", "response.incomplete", "response.failed", "error"]);
const statuses = new Set(["queued", "in_progress", "completed", "incomplete", "failed", "cancelled"]);

// Inspect only protocol envelopes, never input/output, tool arguments or text.
function envelopeFacts(body) {
  const stateFields = [];
  const codes = [];
  for (const [path, value] of [
    ["", body], ["metadata.", body?.metadata], ["client_metadata.", body?.client_metadata],
    ["response.", body?.response], ["response.metadata.", body?.response?.metadata],
    ["error.", body?.error], ["response.error.", body?.response?.error],
  ]) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    if (Object.hasOwn(value, "current_turn_state")) stateFields.push(`${path}current_turn_state`);
    if (Object.hasOwn(value, "x-codex-turn-state")) stateFields.push(`${path}x-codex-turn-state`);
    for (const field of ["status", "status_code", "http_status", "code"]) {
      const code = value[field];
      if ((Number.isInteger(code) || (typeof code === "string" && /^\d{3}$/.test(code))) &&
          Number(code) >= 100 && Number(code) <= 599) codes.push({ field: `${path}${field}`, value: Number(code) });
    }
  }
  return { stateFields, codes };
}

function identifier(value) {
  return typeof value === "string" && /^[\w.:-]{1,200}$/.test(value) ? value : null;
}

export function createTransportDiagnostic(write, {
  context = {}, transport, method, endpoint, body, headers = {}, wireBody,
  url = null, connectionId = null,
}) {
  const startedAt = Date.now();
  const common = {
    type: "model-request-diagnostic", version: TRANSPORT_DIAGNOSTICS_VERSION,
    relayProtocolVersion: RELAY_PROTOCOL_VERSION,
    requestId: context.requestId ?? randomUUID(), connectionId,
    threadId: identifier(context.threadId), turnId: identifier(context.turnId),
    model: identifier(context.model ?? body?.model), providerKind: context.target?.kind ?? null,
    transport, method,
    // endpoint excludes local Router authentication; url is the full upstream URL.
    endpoint, url: url == null ? null : String(url), streamId: body?.stream_id ?? null, startedAt,
  };
  let finished = false;
  let payloadCount = 0;
  let partial = false;
  let httpStatusCode = null;
  let responseId = null;
  let responseModel = null;
  let responseStatus = null;
  const stateFields = new Set();
  const responseStates = new Map();
  const codes = new Map();
  const rememberStates = (summaries) => {
    let changed = false;
    for (const summary of summaries) {
      const key = `${summary.field}:${summary.sha256}`;
      if (!responseStates.has(key)) changed = true;
      responseStates.set(key, summary);
      stateFields.add(summary.field);
    }
    return changed;
  };
  const emit = (phase, data) => write({ ...common, phase, ...data });
  const initialRequestStates = uniqueTurnStateSummaries([
    ...turnStateSummaries(headers, "headers"),
    ...turnStateSummaries(body, "body"),
  ]);
  emit("request", {
    headers, body: body ?? null,
    bodyBase64: wireBody == null ? null : Buffer.from(wireBody).toString("base64"),
    requestStateFields: initialRequestStates.map(state => state.field),
    requestStates: initialRequestStates,
  });
  return {
    requestHeaders(headers) {
      const requestStates = turnStateSummaries(headers, "headers");
      emit("request-headers", { headers, requestStateFields: requestStates.map(state => state.field), requestStates });
    },
    raw(data, { direction = "response", binary = false } = {}) {
      emit("body-chunk", { direction, binary, dataBase64: Buffer.from(data).toString("base64") });
    },
    error(error) { emit("error", { code: error?.code ?? null, message: error?.message ?? String(error) }); },
    headers(response) {
      httpStatusCode = response.statusCode ?? null;
      const headers = response.headers ?? {};
      const headerStates = turnStateSummaries(headers, "headers");
      rememberStates(headerStates);
      emit("response-headers", {
        httpStatusCode, headers, rawHeaders: response.rawHeaders ?? null,
        upstreamRequestId: identifier(headers["x-request-id"]),
        stateHeaderPresent: Object.hasOwn(headers, "current_turn_state") ||
          Object.hasOwn(headers, "current-turn-state") || Object.hasOwn(headers, "x-codex-turn-state"),
        responseStateFields: headerStates.map(state => state.field),
        responseStates: headerStates,
      });
    },
    recordPayload(payload) {
      if (finished || !payload || typeof payload !== "object") return;
      payloadCount++;
      const facts = envelopeFacts(payload);
      let changed = rememberStates(turnStateSummaries(payload));
      for (const field of facts.stateFields) {
        if (!stateFields.has(field)) changed = true;
        stateFields.add(field);
      }
      for (const code of facts.codes) {
        const key = `${code.field}:${code.value}`;
        if (!codes.has(key)) changed = true;
        codes.set(key, code);
      }
      responseId = identifier(payload.response?.id ?? payload.id) ?? responseId;
      responseModel = identifier(payload.response?.model ?? payload.model) ?? responseModel;
      const status = payload.response?.status ?? payload.status;
      if (statuses.has(status)) responseStatus = status;
      if (changed || terminalTypes.has(payload.type)) emit("response-envelope", {
        responseId, responseModel, responseStatus,
        eventType: terminalTypes.has(payload.type) ? payload.type : null,
        responseStateFields: [...stateFields], envelopeCodes: [...codes.values()],
        responseStates: [...responseStates.values()],
      });
    },
    markPartial() { partial = true; },
    finish(outcome = "end") {
      if (finished) return;
      finished = true;
      emit("finished", {
        outcome, httpStatusCode, responseId, responseModel, responseStatus,
        payloadCount, bodyInspection: partial ? "partial" : payloadCount ? "parsed" : "not-observed",
        responseStateFields: [...stateFields], envelopeCodes: [...codes.values()],
        responseStates: [...responseStates.values()],
        durationMs: Date.now() - startedAt,
      });
    },
  };
}

// A bounded side observer: forwarding never waits for inspection, and parse
// failures/large frames are explicitly incomplete evidence, not absent state.
export function observeDiagnosticResponse(response, diagnostic) {
  diagnostic.headers(response);
  response.on("data", chunk => diagnostic.raw(chunk, { binary: true }));
  response.once("error", error => { diagnostic.error(error); diagnostic.finish("stream-error"); });
  const encoding = String(response.headers["content-encoding"] ?? "identity").toLowerCase();
  const decoders = { gzip: createGunzip, "x-gzip": createGunzip, deflate: createInflate,
    br: createBrotliDecompress, zstd: createZstdDecompress };
  const contentType = String(response.headers["content-type"] ?? "").toLowerCase();
  const sse = contentType.includes("text/event-stream");
  const json = contentType.includes("application/json") || contentType.includes("+json");
  const decoder = decoders[encoding]?.();
  if ((!json && !sse) || (encoding !== "identity" && !decoder)) {
    diagnostic.markPartial();
    response.once("end", () => diagnostic.finish());
    response.once("close", () => diagnostic.finish("closed"));
    return;
  }
  const stream = decoder ?? response;
  const textDecoder = new StringDecoder("utf8");
  let pending = "";
  let skipping = false;
  const inspect = (text) => {
    const data = sse ? text.split(/\r?\n/).filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trim()).join("\n") : text;
    if (!data.trim() || data.trim() === "[DONE]") return;
    try { diagnostic.recordPayload(JSON.parse(data)); } catch { diagnostic.markPartial(); }
  };
  const accept = (text) => {
    pending += text;
    if (sse) {
      let match;
      while ((match = /\r?\n\r?\n/.exec(pending))) {
        const block = pending.slice(0, match.index);
        if (!skipping && block.length <= MAX_FRAME_CHARS) inspect(block);
        else diagnostic.markPartial();
        skipping = false;
        pending = pending.slice(match.index + match[0].length);
      }
    }
    if (pending.length > MAX_FRAME_CHARS) {
      diagnostic.markPartial();
      skipping = true;
      pending = sse ? pending.slice(-3) : "";
    }
  };
  stream.on("data", chunk => accept(textDecoder.write(chunk)));
  stream.once("end", () => {
    accept(textDecoder.end());
    if (!skipping && pending.trim()) inspect(pending);
    diagnostic.finish();
  });
  stream.once("error", () => { diagnostic.markPartial(); diagnostic.finish("stream-error"); });
  response.once("close", () => {
    if (!response.complete) {
      diagnostic.markPartial();
      diagnostic.finish("aborted");
      if (decoder) { response.unpipe(decoder); decoder.destroy(); }
    }
  });
  if (decoder) response.pipe(decoder);
}

// ws's public finishRequest hook lets us observe a rejected handshake without
// suppressing its default unexpected-response error/fallback behavior.
export function diagnosticWebSocketHandshake(diagnostic) {
  return (request) => {
    diagnostic.requestHeaders(request.getHeaders());
    request.prependOnceListener("response", response => observeDiagnosticResponse(response, diagnostic));
    request.once("upgrade", response => diagnostic.headers(response));
    request.end();
  };
}

export function withDiagnosticObservation(observation, diagnostic) {
  return {
    recordPayload(payload) { diagnostic.recordPayload(payload); observation.recordPayload(payload); },
    finish() { diagnostic.finish(); observation.finish(); },
    abort() { diagnostic.finish("aborted"); observation.abort(); },
  };
}
