import { resolveContextTier } from "../token-pricing.mjs";
import { MIN_GENERATION_METRICS_VERSION } from "../relay-contract.mjs";
import { normalizeToolExecutionLedger } from "../tool-executions.mjs";
import { readFile, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { MAX_SEEN_USAGE_RESPONSE_IDS, MAX_PENDING_GENERATION_RECORDS, TOKEN_FIELDS, toCamelCase, positiveNumber, nonNegativeNumberOrNull, positiveInteger, nonEmptyString, MAX_PENDING_USAGE_RECORDS } from "./contract.mjs";
import { emptyTurn, normalizeRolloutUsage } from "./turns.mjs";
import { normalizeToolTiming, normalizeTextPhases, outputPhaseFields, normalizeNetworkLatency } from "./generation.mjs";

function normalizeCachedTurn(value, { generationMetricsCompatible = false } = {}) {
  const turnId = nonEmptyString(value?.turnId);
  const threadId = nonEmptyString(value?.threadId ?? value?.taskKey);
  if (!turnId || !threadId) return null;
  const turn = emptyTurn(
    turnId,
    threadId,
    value.source === "event" ? "event" : "rollout",
    String(value.rolloutPath ?? ""),
  );
  turn.completed = Boolean(value.completed);
  turn.status = nonEmptyString(value.status);
  turn.model = String(value.model ?? "");
  turn.modelSource = String(value.modelSource ?? (turn.model ? "thread" : ""));
  turn.rolloutUsageFallback = Boolean(value.rolloutUsageFallback);
  turn.toolExecutionLedger = normalizeToolExecutionLedger(value.toolExecutionLedger);
  const cachedGenerationMetricsVersion = positiveInteger(value.generationMetricsVersion);
  const keepGenerationMetrics = generationMetricsCompatible &&
    cachedGenerationMetricsVersion >= MIN_GENERATION_METRICS_VERSION;
  turn.generationMetricsVersion = keepGenerationMetrics ? cachedGenerationMetricsVersion : 0;
  turn.generationMetricsEnabled = keepGenerationMetrics && Boolean(value.generationMetricsEnabled);
  turn.firstTokenLatencyMs = keepGenerationMetrics
    ? positiveNumber(value.firstTokenLatencyMs) || null
    : null;
  turn.firstTokenLatencyTotalMs = keepGenerationMetrics
    ? positiveNumber(value.firstTokenLatencyTotalMs)
    : 0;
  turn.firstTokenLatencySamples = keepGenerationMetrics
    ? positiveInteger(value.firstTokenLatencySamples)
    : 0;
  turn.outputSpeed = keepGenerationMetrics ? positiveNumber(value.outputSpeed) || null : null;
  turn.outputGenerationDurationMs = keepGenerationMetrics
    ? positiveNumber(value.outputGenerationDurationMs)
    : 0;
  turn.outputGenerationTokens = keepGenerationMetrics
    ? positiveNumber(value.outputGenerationTokens)
    : 0;
  turn.networkLatencySupported = Boolean(value.networkLatencySupported);
  turn.networkConnectionId = nonEmptyString(value.networkConnectionId);
  turn.networkLatency = normalizeNetworkLatency(value.networkLatency);
  turn.generationDetails = keepGenerationMetrics && Array.isArray(value.generationDetails)
    ? value.generationDetails.map((detail, index) => ({
        requestId: nonEmptyString(detail?.requestId),
        responseId: nonEmptyString(detail?.responseId),
        sequence: positiveInteger(detail?.sequence) || index + 1,
        hasVisibleText: Boolean(detail?.hasVisibleText ?? detail?.firstTokenLatencyMs),
        followsToolResult: Boolean(detail?.followsToolResult),
        toolNames: Array.isArray(detail?.toolNames)
          ? [...new Set(detail.toolNames.map(nonEmptyString).filter(Boolean))]
          : [],
        responseLatencyMs: nonNegativeNumberOrNull(detail?.responseLatencyMs),
        reasoningDurationMs: nonNegativeNumberOrNull(detail?.reasoningDurationMs),
        firstTokenLatencyMs: positiveNumber(detail?.firstTokenLatencyMs) || null,
        outputSpeed: positiveNumber(detail?.outputSpeed) || null,
        outputGenerationTokens: positiveNumber(detail?.outputGenerationTokens),
        generationDurationMs: nonNegativeNumberOrNull(detail?.generationDurationMs),
        textPhases: normalizeTextPhases(detail?.textPhases),
        ...outputPhaseFields(detail),
        networkLatency: normalizeNetworkLatency(detail?.networkLatency),
        toolTiming: normalizeToolTiming(detail?.toolTiming),
        outputSpeedUnavailableReason: [
          "unattributed-output",
          "insufficient-data",
          "no-visible-text",
        ]
          .includes(detail?.outputSpeedUnavailableReason)
          ? detail.outputSpeedUnavailableReason
          : null,
      }))
    : [];
  turn.pendingGenerationSamples = keepGenerationMetrics && Array.isArray(value.pendingGenerationSamples)
    ? value.pendingGenerationSamples.slice(-MAX_PENDING_GENERATION_RECORDS).map((sample) => ({
        responseId: nonEmptyString(sample?.responseId),
        hasVisibleText: Boolean(sample?.hasVisibleText),
        hasNonTextOutput: Boolean(sample?.hasNonTextOutput),
        generationDurationMs: positiveNumber(sample?.generationDurationMs),
        ...outputPhaseFields(sample),
        detailSequence: positiveInteger(sample?.detailSequence),
      }))
    : [];
  turn.pendingGenerationUsages = keepGenerationMetrics && Array.isArray(value.pendingGenerationUsages)
    ? value.pendingGenerationUsages
        .slice(-MAX_PENDING_GENERATION_RECORDS)
        .map((usage) => typeof usage === "number"
          ? { responseId: null, visibleOutputTokens: positiveNumber(usage) }
          : {
              responseId: nonEmptyString(usage?.responseId),
              visibleOutputTokens: positiveNumber(usage?.visibleOutputTokens),
            })
    : [];
  turn.pendingToolTimings = keepGenerationMetrics && Array.isArray(value.pendingToolTimings)
    ? value.pendingToolTimings.slice(-MAX_PENDING_GENERATION_RECORDS)
        .map((pending) => ({
          requestId: nonEmptyString(pending?.requestId),
          toolTiming: normalizeToolTiming(pending?.toolTiming),
        }))
        .filter((pending) => pending.requestId && pending.toolTiming)
    : [];
  turn.costRevision = positiveInteger(value.costRevision);
  turn.isSubagent = Boolean(value.isSubagent);
  turn.isSubagentSummary = false;
  turn.rootThreadId = String(value.rootThreadId ?? threadId);
  turn.parentThreadId = String(value.parentThreadId ?? "");
  turn.parentTurnId = String(value.parentTurnId ?? "");
  turn.agentPath = String(value.agentPath ?? "");
  turn.agentNickname = String(value.agentNickname ?? "");
  turn.agentDepth = positiveInteger(value.agentDepth);
  turn.taskKey = nonEmptyString(value.taskKey) ?? threadId;
  turn.startedAt = positiveNumber(value.startedAt);
  turn.cumulativeTotalTokens = positiveNumber(value.cumulativeTotalTokens);
  turn.rolloutTokenCountTotalTokens = positiveNumber(value.rolloutTokenCountTotalTokens);
  turn.responseCumulativeTotalTokens = positiveNumber(value.responseCumulativeTotalTokens) ||
    (turn.source === "event" && !turn.rolloutUsageFallback
      ? turn.cumulativeTotalTokens
      : 0);
  turn.rolloutParserVersion = positiveInteger(value.rolloutParserVersion);
  turn.usageResponseIds = Array.isArray(value.usageResponseIds)
    ? [...new Set(value.usageResponseIds.map(nonEmptyString).filter(Boolean))]
        .slice(-MAX_SEEN_USAGE_RESPONSE_IDS)
    : [];
  turn.modelContextWindow = positiveNumber(value.modelContextWindow);
  turn.updatedAt = positiveNumber(value.updatedAt);
  turn.segments = Array.isArray(value.segments)
    ? value.segments.map((segment) => {
        const model = String(segment?.model ?? "");
        const modelSource = String(segment?.modelSource ?? (model ? "thread" : ""));
        const usage = normalizeRolloutUsage(segment?.usage) ?? normalizeRolloutUsage({});
        const modelContextWindow = positiveNumber(value?.modelContextWindow);
        const contextTier = segment?.contextTier ||
          (modelContextWindow > 0 && modelContextWindow <= 272_000
            ? "short"
            : resolveContextTier(model, usage.input_tokens));
        return {
          model,
          modelSource,
          contextTier,
          usage,
        };
      })
    : [];
  if (turn.costRevision === 0 && (turn.model || turn.segments.length > 0)) turn.costRevision = 1;
  for (const field of TOKEN_FIELDS) {
    turn[toCamelCase(field)] = positiveNumber(value[toCamelCase(field)]);
  }
  return turn;
}

function normalizeCachedFileState(value) {
  const threadId = nonEmptyString(value?.threadId);
  const path = nonEmptyString(value?.path);
  if (!threadId || !path) return null;
  return {
    threadId,
    path,
    offset: positiveInteger(value.offset),
    pending: String(value.pending ?? ""),
    currentTurnId: nonEmptyString(value.currentTurnId),
    threadModel: nonEmptyString(value.threadModel),
    pendingUsageRecords: Array.isArray(value.pendingUsageRecords)
      ? value.pendingUsageRecords
          .map((record) => ({
            turnId: nonEmptyString(record?.turnId),
            responseId: nonEmptyString(record?.responseId),
            usage: normalizeRolloutUsage(record?.usage),
          }))
          .filter((record) => record.turnId && record.responseId && record.usage)
          .slice(-MAX_PENDING_USAGE_RECORDS)
      : [],
    modelReconciled: Boolean(value.modelReconciled),
    parserVersion: positiveInteger(value.parserVersion),
    unknownModelChecked: Boolean(value.unknownModelChecked),
    unknownModelCheckOffset: positiveInteger(value.unknownModelCheckOffset),
    lastUsedAt: positiveNumber(value.lastUsedAt),
  };
}

function normalizeCachedHistory(value) {
  const threadId = nonEmptyString(value?.threadId);
  if (!threadId || !Array.isArray(value?.segments)) return null;
  const pendingTurns = positiveInteger(value.pendingTurns);
  const segments = value.segments.map((segment) => {
    const model = String(segment?.model ?? "");
    const modelSource = String(segment?.modelSource ?? (model ? "thread" : ""));
    const usage = normalizeRolloutUsage(segment?.usage) ?? normalizeRolloutUsage({});
    const contextTier = segment?.contextTier || resolveContextTier(model, usage.input_tokens);
    return {
      model,
      modelSource,
      contextTier,
      usage,
    };
  });
  if (segments.length === 0 && pendingTurns === 0) return null;
  return {
    threadId,
    segments,
    pendingTurns,
    pendingTokens: positiveNumber(value.pendingTokens),
    costRevision: positiveInteger(value.costRevision),
    updatedAt: positiveNumber(value.updatedAt),
  };
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writeJsonAtomic(path, value) {
  const content = `${JSON.stringify(value)}\n`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, content, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export { normalizeCachedTurn, normalizeCachedFileState, normalizeCachedHistory, readJson, writeJsonAtomic };
