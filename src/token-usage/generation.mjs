import { assignOutputPhaseSpeed, generationSpeedWindow, normalizeOutputPhases } from "../generation-speed.mjs";
import { MIN_GENERATION_METRICS_VERSION } from "../relay-contract.mjs";
import { positiveNumber, positiveInteger, nonEmptyString, nonNegativeNumberOrNull, MAX_PENDING_GENERATION_RECORDS } from "./contract.mjs";

function resetGenerationUsageAttribution(turn) {
  turn.outputSpeed = null;
  turn.outputGenerationDurationMs = 0;
  turn.outputGenerationTokens = 0;
  turn.pendingGenerationUsages = [];
  turn.pendingGenerationSamples = [];
  for (const detail of Array.isArray(turn.generationDetails) ? turn.generationDetails : []) {
    const hasNonTextOutput = detail.outputSpeedUnavailableReason === "unattributed-output";
    detail.outputSpeed = null;
    detail.outputGenerationTokens = 0;
    assignOutputPhaseSpeed(detail, null);
    const sample = {
      responseId: nonEmptyString(detail.responseId),
      hasVisibleText: Boolean(detail.hasVisibleText),
      hasNonTextOutput,
      generationDurationMs: positiveNumber(detail.generationDurationMs),
      ...outputPhaseFields(detail),
      detailSequence: positiveInteger(detail.sequence),
    };
    detail.outputSpeedUnavailableReason = generationSpeedWindow(sample).reason;
    turn.pendingGenerationSamples.push(sample);
  }
  trimGenerationQueue(turn.pendingGenerationSamples);
}

function recordGenerationSample(turn, value) {
  if (!value || typeof value !== "object") return;
  const textPhases = normalizeTextPhases(value.textPhases);
  const networkLatency = normalizeNetworkLatency(value.networkLatency);
  const hasVisibleText = Boolean(value.hasVisibleText) || textPhases.length > 0;
  const hasNonTextOutput = Boolean(value.hasNonTextOutput);
  const derivedFirstTokenLatencyMs = textPhases.reduce(
    (minimum, phase) => Math.min(minimum, positiveNumber(phase.startLatencyMs) || Infinity),
    Infinity,
  );
  const firstTokenLatencyMs = positiveNumber(value.firstTokenLatencyMs) ||
    (Number.isFinite(derivedFirstTokenLatencyMs) ? derivedFirstTokenLatencyMs : 0);
  const derivedGenerationDurationMs = textPhases.reduce(
    (total, phase) => total + positiveNumber(phase.durationMs),
    0,
  );
  const generationDurationMs = positiveNumber(value.generationDurationMs) ||
    derivedGenerationDurationMs;
  const detailSequence = nextGenerationSequence(turn);
  if (hasVisibleText && firstTokenLatencyMs > 0) {
    turn.firstTokenLatencyTotalMs += firstTokenLatencyMs;
    turn.firstTokenLatencySamples += 1;
    turn.firstTokenLatencyMs = turn.firstTokenLatencyTotalMs / turn.firstTokenLatencySamples;
  }
  const detail = {
    requestId: nonEmptyString(value.requestId),
    responseId: nonEmptyString(value.responseId),
    sequence: detailSequence,
    hasVisibleText,
    followsToolResult: Boolean(value.followsToolResult),
    toolNames: Array.isArray(value.toolNames)
      ? [...new Set(value.toolNames.map(nonEmptyString).filter(Boolean))]
      : [],
    responseLatencyMs: nonNegativeNumberOrNull(value.responseLatencyMs),
    reasoningDurationMs: nonNegativeNumberOrNull(value.reasoningDurationMs),
    firstTokenLatencyMs: firstTokenLatencyMs || null,
    outputSpeed: null,
    outputGenerationTokens: 0,
    generationDurationMs: generationDurationMs || null,
    textPhases,
    ...outputPhaseFields(value),
    networkLatency,
    toolTiming: normalizeToolTiming(value.toolTiming),
    outputSpeedUnavailableReason: Array.isArray(value.outputPhases)
      ? generationSpeedWindow(value).reason
      : !hasVisibleText ? "no-visible-text" : hasNonTextOutput ? "unattributed-output" : null,
  };
  turn.generationDetails.push(detail);
  if (networkLatency) {
    turn.networkLatencySupported = true;
    turn.networkConnectionId = networkLatency.connectionId;
    turn.networkLatency = networkLatency;
  }
  applyPendingToolTimings(turn, detail);
  turn.pendingGenerationSamples.push({
    responseId: nonEmptyString(value.responseId),
    hasVisibleText,
    hasNonTextOutput,
    generationDurationMs,
    ...outputPhaseFields(value),
    detailSequence,
  });
  trimGenerationQueue(turn.pendingGenerationSamples);
  reconcileGenerationMetrics(turn);
}

function resetGenerationMetrics(turn) {
  turn.generationMetricsEnabled = false;
  turn.firstTokenLatencyMs = null;
  turn.firstTokenLatencyTotalMs = 0;
  turn.firstTokenLatencySamples = 0;
  turn.outputSpeed = null;
  turn.outputGenerationDurationMs = 0;
  turn.outputGenerationTokens = 0;
  turn.generationDetails = [];
  turn.pendingGenerationSamples = [];
  turn.pendingGenerationUsages = [];
  turn.pendingToolTimings = [];
}

function recordGenerationToolTiming(turn, event) {
  const requestId = nonEmptyString(event.requestId);
  const toolTiming = normalizeToolTiming(event.toolTiming);
  if (!requestId || !toolTiming) return;
  const detail = turn.generationDetails.find((value) => value.requestId === requestId);
  if (detail) {
    mergeToolTiming(detail, toolTiming);
    return;
  }
  turn.pendingToolTimings.push({ requestId, toolTiming });
  trimGenerationQueue(turn.pendingToolTimings);
}

function applyPendingToolTimings(turn, detail) {
  if (!detail.requestId || turn.pendingToolTimings.length === 0) return;
  const remaining = [];
  for (const pending of turn.pendingToolTimings) {
    if (pending.requestId === detail.requestId) mergeToolTiming(detail, pending.toolTiming);
    else remaining.push(pending);
  }
  turn.pendingToolTimings = remaining;
}

function mergeToolTiming(detail, toolTiming) {
  detail.toolTiming = toolTiming;
  detail.toolNames = [...new Set([
    ...(Array.isArray(detail.toolNames) ? detail.toolNames : []),
    ...toolTiming.toolNames,
  ])];
}

function normalizeToolTiming(value) {
  const durationMs = nonNegativeNumberOrNull(value?.durationMs);
  if (durationMs == null) return null;
  const calls = Array.isArray(value?.calls)
    ? value.calls.map((call) => {
      const callDurationMs = nonNegativeNumberOrNull(call?.durationMs);
      if (callDurationMs == null) return null;
      return {
        toolName: nonEmptyString(call?.toolName),
        preparationDurationMs: nonNegativeNumberOrNull(call?.preparationDurationMs),
        durationMs: callDurationMs,
      };
    }).filter(Boolean)
    : [];
  return {
    toolNames: Array.isArray(value?.toolNames)
      ? [...new Set(value.toolNames.map(nonEmptyString).filter(Boolean))]
      : [],
    toolCount: positiveInteger(value?.toolCount) || calls.length,
    readyLatencyMs: nonNegativeNumberOrNull(value?.readyLatencyMs),
    preparationStartLatencyMs: nonNegativeNumberOrNull(value?.preparationStartLatencyMs),
    preparationDurationMs: nonNegativeNumberOrNull(value?.preparationDurationMs),
    durationMs,
    calls,
  };
}

function normalizeTextPhases(value) {
  if (!Array.isArray(value)) return [];
  return value.map((phase) => {
    const startLatencyMs = nonNegativeNumberOrNull(phase?.startLatencyMs);
    if (startLatencyMs == null) return null;
    const type = ["commentary", "final_answer"].includes(phase?.phase)
      ? phase.phase
      : "unknown";
    return {
      phase: type,
      startLatencyMs,
      durationMs: nonNegativeNumberOrNull(phase?.durationMs),
    };
  }).filter(Boolean).sort((left, right) => left.startLatencyMs - right.startLatencyMs);
}

function outputPhaseFields(value) {
  const outputPhases = normalizeOutputPhases(value?.outputPhases);
  return outputPhases === null ? {} : {
    outputPhases,
    outputPhasesComplete: Boolean(value.outputPhasesComplete),
  };
}

function normalizeNetworkLatency(value) {
  if (!value || typeof value !== "object") return null;
  const status = ["stable", "fluctuating", "reconnecting", "reconnected"]
    .includes(value.status)
    ? value.status
    : null;
  const latencyMs = nonNegativeNumberOrNull(value.latencyMs);
  const sampledAt = positiveNumber(value.sampledAt) || null;
  const connectionId = nonEmptyString(value.connectionId);
  if (!status || !sampledAt || !connectionId) return null;
  return { status, latencyMs, sampledAt, connectionId };
}

function recordGenerationUsage(turn, usage, responseId = null) {
  if (!turn.generationMetricsEnabled) return;
  const normalizedResponseId = nonEmptyString(responseId);
  if (!normalizedResponseId &&
    positiveInteger(turn.generationMetricsVersion) >= MIN_GENERATION_METRICS_VERSION) return;
  const outputTokens = positiveNumber(usage?.output_tokens);
  if (outputTokens <= 0) return;
  const reasoningTokens = positiveNumber(usage?.reasoning_output_tokens);
  turn.pendingGenerationUsages.push({
    responseId: normalizedResponseId,
    // Historical field name: this includes generated tool input as well as text.
    visibleOutputTokens: Math.max(0, outputTokens - reasoningTokens),
  });
  trimGenerationQueue(turn.pendingGenerationUsages);
  reconcileGenerationMetrics(turn);
}

function reconcileGenerationMetrics(turn) {
  for (;;) {
    const pair = takeNextGenerationPair(turn);
    if (!pair) break;
    const { sample, usage } = pair;
    const nonReasoningOutputTokens = positiveNumber(usage.visibleOutputTokens);
    const detail = turn.generationDetails.find((value) =>
      value.sequence === sample.detailSequence);
    const window = generationSpeedWindow(sample);
    if (window.reason) {
      if (detail) detail.outputSpeedUnavailableReason = window.reason;
      continue;
    }
    // TPOT excludes the first output token because its delay is represented by TTFT.
    const measuredOutputTokens = Math.max(0, nonReasoningOutputTokens - 1);
    if (measuredOutputTokens <= 0) {
      if (detail) detail.outputSpeedUnavailableReason = "insufficient-data";
      continue;
    }
    turn.outputGenerationTokens += measuredOutputTokens;
    turn.outputGenerationDurationMs += window.durationMs;
    if (detail) {
      detail.outputGenerationTokens = measuredOutputTokens;
      detail.outputSpeed = measuredOutputTokens / (window.durationMs / 1_000);
      detail.outputSpeedUnavailableReason = null;
      assignOutputPhaseSpeed(detail, detail.outputSpeed);
    }
  }
  turn.outputSpeed = calculateOutputSpeed(turn);
}

function takeNextGenerationPair(turn) {
  const samples = turn.pendingGenerationSamples;
  const usages = turn.pendingGenerationUsages;
  if (!Array.isArray(samples) || !Array.isArray(usages) ||
    samples.length === 0 || usages.length === 0) return null;
  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
    const responseId = nonEmptyString(samples[sampleIndex]?.responseId);
    if (!responseId) continue;
    const usageIndex = usages.findIndex((usage) => usage?.responseId === responseId);
    if (usageIndex < 0) continue;
    return {
      sample: samples.splice(sampleIndex, 1)[0],
      usage: usages.splice(usageIndex, 1)[0],
    };
  }
  // Older app-server and rollout formats do not carry response IDs. Pair only
  // when both sides are unkeyed; mixing a keyed and an unkeyed record could
  // silently attribute compaction or tool output to the next visible answer.
  const sampleIndex = samples.findIndex((sample) => !nonEmptyString(sample?.responseId));
  const usageIndex = usages.findIndex((usage) => !nonEmptyString(usage?.responseId));
  if (sampleIndex < 0 || usageIndex < 0) return null;
  const rawUsage = usages.splice(usageIndex, 1)[0];
  return {
    sample: samples.splice(sampleIndex, 1)[0],
    usage: typeof rawUsage === "number"
      ? { responseId: null, visibleOutputTokens: positiveNumber(rawUsage) }
      : rawUsage,
  };
}

function nextGenerationSequence(turn) {
  return turn.generationDetails.reduce(
    (maximum, detail) => Math.max(maximum, positiveInteger(detail?.sequence)),
    0,
  ) + 1;
}

function calculateOutputSpeed(turn) {
  const durationMs = positiveNumber(turn.outputGenerationDurationMs);
  const tokens = positiveNumber(turn.outputGenerationTokens);
  return durationMs > 0 && tokens > 0 ? tokens / (durationMs / 1_000) : null;
}

function trimGenerationQueue(queue) {
  if (queue.length > MAX_PENDING_GENERATION_RECORDS) {
    queue.splice(0, queue.length - MAX_PENDING_GENERATION_RECORDS);
  }
}

export { normalizeNetworkLatency, calculateOutputSpeed, resetGenerationUsageAttribution, normalizeToolTiming, normalizeTextPhases, outputPhaseFields, recordGenerationUsage, recordGenerationSample, resetGenerationMetrics, recordGenerationToolTiming };
