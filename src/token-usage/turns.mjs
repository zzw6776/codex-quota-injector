import { createToolExecutionLedger } from "../tool-executions.mjs";
import { resolveContextTier, accumulateTokenCost } from "../token-pricing.mjs";
import { ROLLOUT_PARSER_VERSION, TOKEN_FIELDS, toCamelCase, positiveInteger, MAX_SEEN_USAGE_RESPONSE_IDS, nonEmptyString, MAX_PENDING_USAGE_RECORDS, positiveNumber, MODEL_SOURCE_PRIORITY, MAX_HISTORICAL_SEGMENTS } from "./contract.mjs";
import { resetGenerationUsageAttribution } from "./generation.mjs";

function emptyTurn(turnId, threadId, source, rolloutPath = "") {
  return {
    turnId,
    threadId,
    taskKey: threadId,
    source,
    rolloutPath,
    rolloutUsageFallback: false,
    isSubagent: false,
    isSubagentSummary: false,
    rootThreadId: threadId,
    parentThreadId: "",
    parentTurnId: "",
    agentPath: "",
    agentNickname: "",
    agentDepth: 0,
    completed: false,
    status: null,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    cumulativeTotalTokens: 0,
    rolloutTokenCountTotalTokens: 0,
    responseCumulativeTotalTokens: 0,
    rolloutParserVersion: 0,
    usageResponseIds: [],
    modelContextWindow: 0,
    model: "",
    modelSource: "",
    generationMetricsVersion: 0,
    generationMetricsEnabled: false,
    firstTokenLatencyMs: null,
    firstTokenLatencyTotalMs: 0,
    firstTokenLatencySamples: 0,
    outputSpeed: null,
    outputGenerationDurationMs: 0,
    outputGenerationTokens: 0,
    networkLatencySupported: false,
    networkConnectionId: null,
    networkLatency: null,
    generationDetails: [],
    toolExecutionLedger: createToolExecutionLedger(),
    pendingGenerationSamples: [],
    pendingGenerationUsages: [],
    pendingToolTimings: [],
    costRevision: 0,
    segments: [],
    startedAt: 0,
    updatedAt: 0,
  };
}

function prepareRolloutUsageTurn(turn) {
  if (positiveInteger(turn.rolloutParserVersion) === ROLLOUT_PARSER_VERSION) return;
  for (const field of TOKEN_FIELDS) turn[toCamelCase(field)] = 0;
  turn.cumulativeTotalTokens = 0;
  turn.rolloutTokenCountTotalTokens = 0;
  turn.responseCumulativeTotalTokens = 0;
  turn.usageResponseIds = [];
  turn.segments = [];
  turn.costRevision = positiveInteger(turn.costRevision) + 1;
  turn.rolloutParserVersion = ROLLOUT_PARSER_VERSION;
  resetGenerationUsageAttribution(turn);
}

function markUsageResponse(turn, responseId) {
  const normalized = nonEmptyString(responseId);
  if (!normalized) return false;
  if (!Array.isArray(turn.usageResponseIds)) turn.usageResponseIds = [];
  if (turn.usageResponseIds.includes(normalized)) return false;
  turn.usageResponseIds.push(normalized);
  if (turn.usageResponseIds.length > MAX_SEEN_USAGE_RESPONSE_IDS) {
    turn.usageResponseIds.splice(
      0,
      turn.usageResponseIds.length - MAX_SEEN_USAGE_RESPONSE_IDS,
    );
  }
  return true;
}

function enqueuePendingUsageRecord(state, turnId, responseId, usage) {
  if (!Array.isArray(state.pendingUsageRecords)) state.pendingUsageRecords = [];
  state.pendingUsageRecords.push({
    turnId,
    responseId,
    usage: normalizeRolloutUsage(usage),
  });
  if (state.pendingUsageRecords.length > MAX_PENDING_USAGE_RECORDS) {
    state.pendingUsageRecords.splice(
      0,
      state.pendingUsageRecords.length - MAX_PENDING_USAGE_RECORDS,
    );
  }
}

function consumePendingUsageRecord(state, turnId, summaryUsage) {
  if (!Array.isArray(state.pendingUsageRecords)) return null;
  const normalizedSummary = normalizeRolloutUsage(summaryUsage);
  let index = state.pendingUsageRecords.findIndex((record) =>
    record.turnId === turnId && usagesEqual(record.usage, normalizedSummary));
  if (index < 0 && !hasItemizedUsage(normalizedSummary)) {
    // Compaction summaries in some Codex versions expose only a thread-level
    // total. They cannot be priced independently, but a preceding exact
    // response record already contains the complete breakdown.
    index = state.pendingUsageRecords.findIndex((record) => record.turnId === turnId);
  }
  if (index < 0) return null;
  return state.pendingUsageRecords.splice(index, 1)[0] ?? null;
}

function usagesEqual(left, right) {
  if (!left || !right) return false;
  return TOKEN_FIELDS.every((field) =>
    positiveNumber(left[field]) === positiveNumber(right[field]));
}

function hasItemizedUsage(usage) {
  if (!usage) return false;
  return TOKEN_FIELDS
    .filter((field) => field !== "total_tokens")
    .some((field) => positiveNumber(usage[field]) > 0);
}

function addUsage(turn, usage, model, modelSource = turn.modelSource) {
  const normalizedUsage = Object.fromEntries(
    TOKEN_FIELDS.map((field) => [field, positiveNumber(usage?.[field])]),
  );
  for (const field of TOKEN_FIELDS) turn[toCamelCase(field)] += normalizedUsage[field];
  const segmentModel = model || "";
  const segmentSource = modelSource || "";
  const rawInput = positiveNumber(normalizedUsage.input_tokens);
  const contextTier = resolveContextTier(segmentModel || turn.model, rawInput);
  const lastSegment = turn.segments.at(-1);
  if (
    lastSegment &&
    lastSegment.model === segmentModel &&
    lastSegment.modelSource === segmentSource &&
    (lastSegment.contextTier ?? "short") === contextTier
  ) {
    for (const field of TOKEN_FIELDS) {
      lastSegment.usage[field] = positiveNumber(lastSegment.usage[field]) + normalizedUsage[field];
    }
  } else {
    turn.segments.push({
      model: segmentModel,
      modelSource: segmentSource,
      contextTier,
      usage: normalizedUsage,
    });
  }
  turn.costRevision = positiveInteger(turn.costRevision) + 1;
}

function turnHasUnknownModel(turn) {
  return !nonEmptyString(turn?.model) ||
    (Array.isArray(turn?.segments) && turn.segments.some((segment) => !nonEmptyString(segment?.model)));
}

function fillUnknownSegmentModels(turn, model, modelSource) {
  const nextModel = nonEmptyString(model);
  if (!nextModel) return;
  if (turn.segments.some((segment) => segment.modelSource === "rerouted")) return;
  let changed = false;
  for (const segment of turn.segments) {
    if (segment.model) continue;
    segment.model = nextModel;
    segment.modelSource = modelSource || segment.modelSource || "thread";
    changed = true;
  }
  if (changed) turn.costRevision = positiveInteger(turn.costRevision) + 1;
}

function setTurnModel(turn, model, source = "thread") {
  const nextModel = nonEmptyString(model);
  if (!nextModel) return false;
  const currentSource = turn.modelSource || (turn.model ? "thread" : "");
  const currentPriority = MODEL_SOURCE_PRIORITY[currentSource] ?? 0;
  const nextPriority = MODEL_SOURCE_PRIORITY[source] ?? 0;
  if (turn.model && nextPriority < currentPriority) return false;
  if (turn.model === nextModel && currentSource === source) return false;
  turn.model = nextModel;
  turn.modelSource = source;
  turn.costRevision = positiveInteger(turn.costRevision) + 1;
  return true;
}

function calculateTurnCost(turn, pricingManager) {
  let cost = null;
  const tiers = new Map();
  const hasReroute = turn.segments.some((segment) => segment.modelSource === "rerouted");
  for (const segment of turn.segments) {
    const segmentModel = segment.model || (hasReroute ? "" : turn.model);
    const segmentCost = pricingManager.calculate(segmentModel, segment.usage, {
      contextTier: segment.contextTier,
    });
    cost = accumulateTokenCost(cost, segmentCost);
    if (!segmentCost.available) continue;
    const tierKey = JSON.stringify([
      segmentCost.normalizedModel,
      segmentCost.provider,
      segmentCost.currency,
      segmentCost.contextTier,
      segmentCost.rates,
    ]);
    tiers.set(tierKey, accumulateTokenCost(tiers.get(tierKey), segmentCost));
  }
  if (cost?.available) cost.tiers = [...tiers.values()];
  return cost;
}

function normalizeProtocolUsage(value) {
  if (!value || typeof value !== "object") return null;
  return {
    input_tokens: positiveNumber(value.inputTokens),
    cached_input_tokens: positiveNumber(value.cachedInputTokens),
    cache_write_input_tokens: positiveNumber(value.cacheWriteInputTokens),
    output_tokens: positiveNumber(value.outputTokens),
    reasoning_output_tokens: positiveNumber(value.reasoningOutputTokens),
    total_tokens: positiveNumber(value.totalTokens),
  };
}

function normalizeRolloutUsage(value) {
  if (!value || typeof value !== "object") return null;
  return Object.fromEntries(TOKEN_FIELDS.map((field) => [field, positiveNumber(value[field])]));
}

function mergeUsageSegment(segments, segment) {
  const model = String(segment?.model ?? "");
  const modelSource = String(segment?.modelSource ?? (model ? "thread" : ""));
  const usage = normalizeRolloutUsage(segment?.usage) ?? normalizeRolloutUsage({});
  const rawInput = positiveNumber(usage.input_tokens);
  const contextTier = segment?.contextTier || resolveContextTier(model, rawInput);
  const last = segments.at(-1);
  if (
    last &&
    last.model === model &&
    last.modelSource === modelSource &&
    (last.contextTier ?? "short") === contextTier
  ) {
    for (const field of TOKEN_FIELDS) {
      last.usage[field] = positiveNumber(last.usage[field]) + usage[field];
    }
    return;
  }
  segments.push({ model, modelSource, contextTier, usage });
}

function compactUsageSegments(segments) {
  if (segments.length <= MAX_HISTORICAL_SEGMENTS) return;
  const grouped = new Map();
  for (const segment of segments) {
    const model = String(segment?.model ?? "");
    const modelSource = String(segment?.modelSource ?? (model ? "thread" : ""));
    const usage = normalizeRolloutUsage(segment?.usage) ?? normalizeRolloutUsage({});
    const contextTier = segment?.contextTier || resolveContextTier(model, usage.input_tokens);
    const key = `${model}\u0000${modelSource}\u0000${contextTier}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        model,
        modelSource,
        contextTier,
        usage,
      });
      continue;
    }
    for (const field of TOKEN_FIELDS) existing.usage[field] += usage[field];
  }
  segments.splice(0, segments.length, ...grouped.values());
}

export { turnHasUnknownModel, calculateTurnCost, mergeUsageSegment, compactUsageSegments, emptyTurn, normalizeRolloutUsage, prepareRolloutUsageTurn, markUsageResponse, enqueuePendingUsageRecord, consumePendingUsageRecord, addUsage, fillUnknownSegmentModels, setTurnModel, normalizeProtocolUsage };
