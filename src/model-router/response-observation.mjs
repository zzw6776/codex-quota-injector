import { StringDecoder } from "node:string_decoder";
import { MAX_REQUEST_BYTES, nonEmptyString } from "./contract.mjs";
import { decodeObservedStream, parseSseBlock } from "./response-stream.mjs";
import { normalizeUsage } from "./usage.mjs";

function observeResponse(stream, { requestStartedAt, onUsage, onToolCall, onGeneration, onFailure }) {
  const contentType = String(stream.headers["content-type"] ?? "").toLowerCase();
  const observedStream = decodeObservedStream(stream);
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let jsonBody = "";
  const observation = createResponseObservation({
    requestStartedAt,
    responseStartedAt: Date.now(),
    requireCompleted: contentType.includes("text/event-stream"),
    onUsage,
    onToolCall,
    onGeneration,
    onFailure,
  });
  observedStream.on("data", (chunk) => {
    const text = decoder.write(chunk);
    if (contentType.includes("text/event-stream")) {
      pending += text;
      const blocks = pending.split(/\r?\n\r?\n/);
      pending = blocks.pop() ?? "";
      for (const block of blocks) inspectSseBlock(block, observation);
    } else if (jsonBody.length < MAX_REQUEST_BYTES) {
      jsonBody += text;
    }
  });
  observedStream.once("end", () => {
    const tail = decoder.end();
    if (contentType.includes("text/event-stream")) {
      pending += tail;
      if (pending.trim()) inspectSseBlock(pending, observation);
      observation.finish();
      return;
    }
    jsonBody += tail;
    try {
      observation.recordPayload(JSON.parse(jsonBody));
    } catch {}
    observation.finish();
  });
  observedStream.once("error", () => observation.abort());
}

function createResponseObservation({
  requestStartedAt,
  responseStartedAt = 0,
  requireCompleted,
  onUsage,
  onToolCall = () => {},
  onGeneration,
  onFailure = () => {},
  clock = Date.now,
}) {
  let firstResponseAt = Number(responseStartedAt) || 0;
  let firstReasoningAt = 0;
  let lastReasoningAt = 0;
  let hasNonTextOutput = false;
  let hasUnmeasuredOutput = false;
  let responseId = null;
  let latestUsage = null;
  const messageItems = new Map();
  const messageItemStates = new Set();
  const toolItems = new Map();
  const toolItemStates = new Set();
  const completedOutputItems = new Set();
  let activeMessage = null;
  let responseFinished = false;
  let responseFailureObserved = false;
  let finished = false;
  const markResponseStarted = () => {
    if (!firstResponseAt) firstResponseAt = clock();
  };
  const markReasoning = (timestamp) => {
    if (!firstReasoningAt) firstReasoningAt = timestamp;
    lastReasoningAt = timestamp;
  };
  const ensureMessageItem = (itemId, phase = null) => {
    const normalizedId = nonEmptyString(itemId);
    let state = normalizedId ? messageItems.get(normalizedId) : null;
    if (!state && activeMessage &&
      (!normalizedId || !activeMessage.itemId || activeMessage.itemId === normalizedId)) {
      state = activeMessage;
      if (normalizedId && !state.itemId) {
        state.itemId = normalizedId;
        messageItems.set(normalizedId, state);
      }
    }
    if (!state) {
      state = {
        itemId: normalizedId,
        phase: null,
        firstAt: 0,
        lastDeltaAt: 0,
        deltaCount: 0,
        visibleTextChars: 0,
      };
      messageItemStates.add(state);
      if (normalizedId) messageItems.set(normalizedId, state);
    }
    const normalizedPhase = messagePhase(phase);
    if (normalizedPhase) state.phase = normalizedPhase;
    activeMessage = state;
    return state;
  };
  const recordText = (state, text, timestamp, { streamed = false } = {}) => {
    if (!state) return;
    if (typeof text === "string" && text.length > 0) {
      if (!state.firstAt) state.firstAt = timestamp;
      state.visibleTextChars += [...text].length;
      if (streamed) {
        state.lastDeltaAt = timestamp;
        state.deltaCount += 1;
      }
    }
  };
  const rememberToolItem = (item, timestamp, completed) => {
    const references = outputItemReferences(item);
    let state = references.map((reference) => toolItems.get(reference)).find(Boolean);
    if (!state) {
      state = { preparationStartedAt: completed ? 0 : timestamp, firstInputAt: 0, lastInputAt: 0, deltaCount: 0 };
      toolItemStates.add(state);
    }
    if (!completed && !state.preparationStartedAt) state.preparationStartedAt = timestamp;
    for (const reference of references) toolItems.set(reference, state);
    if (!completed) return;
    const referenceId = outputItemReference(item);
    if (!referenceId || completedOutputItems.has(referenceId)) return;
    completedOutputItems.add(referenceId);
    onToolCall({
      referenceId,
      toolName: outputItemLabel(item),
      preparationStartedAt: state.preparationStartedAt || null,
      readyAt: timestamp,
    });
  };
  const recordOutputItem = (item, timestamp, { completed = false, countText = false } = {}) => {
    if (!item || typeof item !== "object") return;
    const type = nonEmptyString(item.type);
    if (!type) return;
    if (type === "reasoning") return;
    if (type === "message") {
      const state = ensureMessageItem(item.id, item.phase);
      for (const content of Array.isArray(item.content) ? item.content : []) {
        if (content?.type !== "output_text") {
          if (nonEmptyString(content?.type)) {
            hasNonTextOutput = true;
            hasUnmeasuredOutput = true;
          }
          continue;
        }
        if (!countText || state.visibleTextChars > 0) continue;
        recordText(state, content.text, timestamp);
      }
      if (completed) {
        if (activeMessage === state) activeMessage = null;
      }
      return;
    }
    hasNonTextOutput = true;
    rememberToolItem(item, timestamp, completed);
  };
  return {
    markResponseStarted,
    recordPayload(payload) {
      markResponseStarted();
      const now = clock();
      if (!responseFailureObserved && (payload?.type === "response.failed" ||
        payload?.status === "failed" || payload?.response?.status === "failed")) {
        responseFailureObserved = true;
        onFailure();
      }
      responseId = nonEmptyString(payload?.response?.id) ??
        nonEmptyString(payload?.id) ??
        responseId;
      if (payload?.type === "response.output_text.delta" &&
        typeof payload.delta === "string" && payload.delta.length > 0) {
        recordText(
          ensureMessageItem(payload.item_id, payload.phase),
          payload.delta,
          now,
          { streamed: true },
        );
      }
      if (payload?.type === "response.output_text.done") {
        const state = ensureMessageItem(payload.item_id, payload.phase);
        if (state.visibleTextChars === 0) recordText(state, payload.text, now);
      }
      if (isReasoningPayload(payload)) markReasoning(now);
      if (["response.content_part.added", "response.content_part.done"].includes(payload?.type) &&
        nonEmptyString(payload?.part?.type) && payload.part.type !== "output_text") {
        hasNonTextOutput = true;
        hasUnmeasuredOutput = true;
      }
      if (["response.output_item.added", "response.output_item.done"].includes(payload?.type) &&
        payload.item) {
        recordOutputItem(payload.item, now, {
          completed: payload.type === "response.output_item.done",
        });
      }
      if (isToolInputDeltaPayload(payload)) {
        hasNonTextOutput = true;
        const references = [payload.item_id, payload.call_id]
          .map(nonEmptyString)
          .filter(Boolean);
        let state = references.map((reference) => toolItems.get(reference)).find(Boolean);
        if (!state) {
          state = { preparationStartedAt: now, firstInputAt: 0, lastInputAt: 0, deltaCount: 0 };
          toolItemStates.add(state);
        }
        for (const reference of references) toolItems.set(reference, state);
        if (!state.preparationStartedAt) state.preparationStartedAt = now;
        if (typeof payload.delta === "string" && payload.delta.length > 0) {
          if (!state.firstInputAt) state.firstInputAt = now;
          state.lastInputAt = now;
          state.deltaCount += 1;
        }
      }
      if (payload?.type === "response") {
        for (const item of Array.isArray(payload.output) ? payload.output : []) {
          if (item?.type === "reasoning") markReasoning(now);
          recordOutputItem(item, now, { completed: true, countText: true });
        }
      } else if (Array.isArray(payload?.output)) {
        for (const item of payload.output) {
          if (item?.type === "reasoning") markReasoning(now);
          recordOutputItem(item, now, { completed: true, countText: true });
        }
      } else if (payload?.response && typeof payload.response === "object") {
        for (const item of Array.isArray(payload.response.output) ? payload.response.output : []) {
          recordOutputItem(item, now, { completed: true, countText: true });
        }
      }
      if (["response.completed", "response.incomplete"].includes(payload?.type)) {
        responseFinished = true;
      }
      const usage = normalizeUsage(payload?.response?.usage ?? payload?.usage);
      if (usage) latestUsage = usage;
    },
    finish() {
      if (finished) return;
      finished = true;
      if (latestUsage) onUsage(latestUsage, responseId);
      if (!responseFinished && requireCompleted) return;
      const visibleMessages = [...messageItemStates]
        .filter((state) => state.firstAt > 0 && state.visibleTextChars > 0)
        .sort((left, right) => left.firstAt - right.firstAt);
      const textPhases = visibleMessages.map((state) => ({
          phase: state.phase ?? "unknown",
          startLatencyMs: Math.max(0, state.firstAt - requestStartedAt),
          durationMs: state.deltaCount > 1 && state.lastDeltaAt > state.firstAt
            ? state.lastDeltaAt - state.firstAt
            : null,
        }));
      const outputPhases = [
        ...textPhases.map((phase, textPhaseIndex) => ({
          kind: "text", textPhaseIndex,
          startLatencyMs: phase.startLatencyMs, durationMs: phase.durationMs,
        })),
        ...[...toolItemStates].map((state) => ({
          kind: "tool",
          startLatencyMs: state.firstInputAt > 0 ? Math.max(0, state.firstInputAt - requestStartedAt) : null,
          durationMs: state.deltaCount > 1 && state.lastInputAt > state.firstInputAt
            ? state.lastInputAt - state.firstInputAt : null,
        })),
      ].sort((left, right) => (left.startLatencyMs ?? Infinity) - (right.startLatencyMs ?? Infinity));
      const firstOutputAt = textPhases.length > 0
        ? requestStartedAt + textPhases[0].startLatencyMs
        : 0;
      const generationDurationMs = textPhases.reduce(
        (total, phase) => total + (Number(phase.durationMs) || 0),
        0,
      );
      onGeneration({
        responseId,
        hasVisibleText: textPhases.length > 0,
        responseLatencyMs: firstResponseAt > 0
          ? Math.max(0, firstResponseAt - requestStartedAt)
          : null,
        reasoningDurationMs: firstReasoningAt > 0 && lastReasoningAt > firstReasoningAt
          ? lastReasoningAt - firstReasoningAt
          : null,
        firstTokenLatencyMs: firstOutputAt > 0
          ? Math.max(0, firstOutputAt - requestStartedAt)
          : null,
        generationDurationMs: generationDurationMs > 0 ? generationDurationMs : null,
        textPhases,
        outputPhases,
        outputPhasesComplete: !hasUnmeasuredOutput && outputPhases.length > 0 &&
          outputPhases.every((phase) => phase.durationMs > 0),
        hasNonTextOutput,
        // Names become public only after a matching call result confirms that
        // the non-text output really was an executable tool invocation.
        toolNames: [],
      });
    },
    abort() {
      finished = true;
    },
  };
}

function inspectSseBlock(block, observation) {
  const payload = parseSseBlock(block);
  if (payload) observation.recordPayload(payload);
}

function outputItemReference(item) {
  return nonEmptyString(item?.call_id) ?? nonEmptyString(item?.id);
}

function outputItemReferences(item) {
  return [...new Set([
    nonEmptyString(item?.call_id),
    nonEmptyString(item?.id),
  ].filter(Boolean))];
}

function outputItemLabel(item) {
  const explicit = nonEmptyString(item?.name) ?? nonEmptyString(item?.server_label);
  if (explicit) return explicit;
  const type = nonEmptyString(item?.type);
  return type?.replaceAll("_", " ") ?? null;
}

function isReasoningPayload(payload) {
  const type = nonEmptyString(payload?.type) ?? "";
  return type.startsWith("response.reasoning") ||
    (["response.output_item.added", "response.output_item.done"].includes(type) &&
      payload?.item?.type === "reasoning");
}

function isToolInputDeltaPayload(payload) {
  const type = nonEmptyString(payload?.type) ?? "";
  if (!type.startsWith("response.") || !type.endsWith(".delta")) return false;
  if (!nonEmptyString(payload?.item_id) && !nonEmptyString(payload?.call_id)) return false;
  return type.includes("arguments") || type.includes("tool_call_input");
}

function messagePhase(value) {
  const phase = nonEmptyString(value);
  return ["commentary", "final_answer"].includes(phase) ? phase : null;
}

export { observeResponse, createResponseObservation };
