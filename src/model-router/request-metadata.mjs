import { nonEmptyString, MAX_REQUEST_START_SKEW_MS } from "./contract.mjs";

function requestThreadId(body, headers) {
  const metadata = body?.client_metadata && typeof body.client_metadata === "object"
    ? body.client_metadata
    : null;
  return nonEmptyString(metadata?.thread_id) ??
    nonEmptyString(headers?.["thread-id"]) ??
    nonEmptyString(headers?.["session-id"]);
}

function turnIdFromHeaders(headers) {
  const direct = nonEmptyString(headers["turn-id"]);
  if (direct) return direct;
  const raw = nonEmptyString(headers["x-codex-turn-metadata"]);
  if (!raw) return null;
  for (const candidate of metadataCandidates(raw)) {
    const found = findTurnId(candidate);
    if (found) return found;
  }
  return null;
}

function metadataCandidates(raw) {
  const values = [raw];
  try { values.push(decodeURIComponent(raw)); } catch {}
  for (const encoding of ["base64url", "base64"]) {
    try { values.push(Buffer.from(raw, encoding).toString("utf8")); } catch {}
  }
  return values.map((value) => {
    try { return JSON.parse(value); } catch { return null; }
  }).filter(Boolean);
}

function findTurnId(value) {
  if (!value || typeof value !== "object") return null;
  for (const key of ["turnId", "turn_id"]) {
    const turnId = nonEmptyString(value[key]);
    if (turnId) return turnId;
  }
  for (const child of Object.values(value)) {
    const turnId = findTurnId(child);
    if (turnId) return turnId;
  }
  return null;
}

function turnIdFromMetadata(metadata) {
  const raw = nonEmptyString(metadata?.["x-codex-turn-metadata"]);
  if (!raw) return null;
  for (const candidate of metadataCandidates(raw)) {
    const found = findTurnId(candidate);
    if (found) return found;
  }
  return null;
}

function requestStartFromMetadata(metadata, fallback) {
  const timestamp = Number(metadata?.["x-codex-ws-stream-request-start-ms"]);
  const now = Date.now();
  if (Number.isFinite(timestamp) && timestamp > 0 &&
    Math.abs(now - timestamp) <= MAX_REQUEST_START_SKEW_MS) {
    return timestamp;
  }
  return fallback;
}

function containsCallReference(value) {
  if (!value || typeof value !== "object") return false;
  if (nonEmptyString(value.call_id)) return true;
  return Object.values(value).some(containsCallReference);
}

function collectCallReferenceIds(value, result = new Set()) {
  if (!value || typeof value !== "object") return result;
  const callId = nonEmptyString(value.call_id);
  const itemId = nonEmptyString(value.id);
  if (callId) result.add(callId);
  if (itemId) result.add(itemId);
  for (const child of Object.values(value)) collectCallReferenceIds(child, result);
  return result;
}

function pendingToolCallKey(threadId, referenceId) {
  return `${threadId}\u0000${referenceId}`;
}

function pendingToolBatchKey(threadId, requestId) {
  return `${threadId}\u0000${requestId}`;
}

export { requestThreadId, turnIdFromHeaders, turnIdFromMetadata, requestStartFromMetadata, containsCallReference, collectCallReferenceIds, pendingToolCallKey, pendingToolBatchKey };
