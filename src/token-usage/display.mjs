import { projectToolExecutions } from "../tool-executions.mjs";
import { TOKEN_FIELDS, toCamelCase, positiveNumber, positiveInteger, nonEmptyString } from "./contract.mjs";
import { emptyTurn, mergeUsageSegment, calculateTurnCost } from "./turns.mjs";
import { normalizeNetworkLatency, calculateOutputSpeed } from "./generation.mjs";

function buildDisplayTurns(turns) {
  const subagentGroups = new Map();
  for (const turn of turns) {
    if (!turn.isSubagent) continue;
    const key = `${turn.threadId}\u0000${turn.parentTurnId || ""}`;
    const group = subagentGroups.get(key) ?? [];
    group.push(turn);
    subagentGroups.set(key, group);
  }
  return [
    ...turns,
    ...[...subagentGroups.values()].map(summarizeSubagentTurns),
  ];
}

function publicGenerationDetails(details, ledger) {
  return (Array.isArray(details) ? details : []).map((detail) => {
    const {
      requestId: _requestId,
      responseId: _responseId,
      ...publicDetail
    } = detail;
    const executions = projectToolExecutions(ledger, detail.responseId);
    return executions ? { ...publicDetail, toolExecutions: executions } : publicDetail;
  });
}

function summarizeSubagentTurns(turns) {
  const ordered = [...turns].sort((left, right) =>
    positiveNumber(left.startedAt) - positiveNumber(right.startedAt) ||
    positiveNumber(left.updatedAt) - positiveNumber(right.updatedAt));
  const first = ordered[0];
  const summary = emptyTurn(
    `subagent:${first.threadId}:${first.parentTurnId || "unassigned"}`,
    first.threadId,
    "subagent",
  );
  summary.taskKey = summary.turnId;
  summary.isSubagent = true;
  summary.isSubagentSummary = true;
  summary.parentThreadId = first.parentThreadId;
  summary.parentTurnId = first.parentTurnId;
  summary.agentPath = first.agentPath;
  summary.agentNickname = first.agentNickname;
  summary.agentDepth = first.agentDepth;
  summary.startedAt = ordered
    .map((turn) => positiveNumber(turn.startedAt) || positiveNumber(turn.updatedAt))
    .filter(Boolean)
    .sort((left, right) => left - right)[0] ?? 0;
  summary.updatedAt = Math.max(...ordered.map((turn) => positiveNumber(turn.updatedAt)), 0);
  summary.completed = ordered.every((turn) => turn.completed);
  summary.status = summary.completed
    ? ordered.some((turn) => turn.status === "failed")
      ? "failed"
      : ordered.some((turn) => turn.status === "interrupted")
        ? "interrupted"
        : "completed"
    : null;
  for (const turn of ordered) {
    summary.toolExecutionLedger.calls.push(...(turn.toolExecutionLedger?.calls ?? []));
    summary.toolExecutionLedger.items.push(...(turn.toolExecutionLedger?.items ?? []));
    for (const field of TOKEN_FIELDS) {
      const publicField = toCamelCase(field);
      summary[publicField] += positiveNumber(turn[publicField]);
    }
    for (const segment of turn.segments) mergeUsageSegment(summary.segments, segment);
    summary.costRevision += positiveInteger(turn.costRevision);
    summary.modelContextWindow = Math.max(
      summary.modelContextWindow,
      positiveNumber(turn.modelContextWindow),
    );
  }
  summary.cumulativeTotalTokens = summary.totalTokens;
  const models = [...new Set(ordered.map((turn) => nonEmptyString(turn.model)).filter(Boolean))];
  summary.model = models.length === 1 ? models[0] : models.length > 1 ? "multiple" : "";
  summary.modelSource = "subagent";
  summary.firstTokenLatencyTotalMs = ordered.reduce(
    (total, turn) => total + positiveNumber(turn.firstTokenLatencyTotalMs),
    0,
  );
  summary.firstTokenLatencySamples = ordered.reduce(
    (total, turn) => total + positiveInteger(turn.firstTokenLatencySamples),
    0,
  );
  summary.firstTokenLatencyMs = summary.firstTokenLatencySamples > 0
    ? summary.firstTokenLatencyTotalMs / summary.firstTokenLatencySamples
    : null;
  summary.generationDetails = ordered.flatMap((turn) =>
    Array.isArray(turn.generationDetails) ? turn.generationDetails : [])
    .map((detail, index) => ({
      ...detail,
      sequence: index + 1,
    }));
  summary.outputGenerationDurationMs = ordered.reduce(
    (total, turn) => total + positiveNumber(turn.outputGenerationDurationMs),
    0,
  );
  summary.outputGenerationTokens = ordered.reduce(
    (total, turn) => total + positiveNumber(turn.outputGenerationTokens),
    0,
  );
  summary.outputSpeed = calculateOutputSpeed(summary);
  summary.networkLatencySupported = ordered.some((turn) => turn.networkLatencySupported);
  const latestNetworkLatency = ordered
    .map((turn) => normalizeNetworkLatency(turn.networkLatency))
    .filter(Boolean)
    .sort((left, right) => left.sampledAt - right.sampledAt)
    .at(-1) ?? null;
  summary.networkLatency = latestNetworkLatency;
  summary.networkConnectionId = latestNetworkLatency?.connectionId ?? null;
  return summary;
}

function buildUsageViewModel({ historicalSegmentsByThread, historicalCostCache, turns, pricingManager, rolloutMetadataByThread, maxViewTurns, initializing, error, getCachedTurnCost }) {
    const cumulativeCosts = new Map();
    for (const [threadId, history] of historicalSegmentsByThread) {
      const revision = positiveInteger(history.costRevision);
      const cached = historicalCostCache.get(threadId);
      const historyCost = cached?.revision === revision
        ? cached.cost
        : history.segments.length > 0
          ? calculateTurnCost({ segments: history.segments }, pricingManager)
          : null;
      historicalCostCache.set(threadId, { revision, cost: historyCost });
      const viewCost = pricingManager.toViewModel(historyCost);
      const historyPendingTurns = positiveInteger(history.pendingTurns) +
        (history.segments.length > 0 && !historyCost?.available ? 1 : 0);
      cumulativeCosts.set(threadId, {
        totalCny: historyCost?.available ? positiveNumber(viewCost.totalCny) : 0,
        pendingTurns: historyPendingTurns,
      });
    }
    const mappedTurns = buildDisplayTurns([...turns.values()])
      // `activeThreadId` identifies the rollout file currently being tailed;
      // it is not a single-session view of the app. Multiple threads can be
      // running at the same time, so every live turn, including a turn still
      // waiting for its first usage event, must remain
      // available to the widget regardless of which thread was started last.
      .filter((turn) => turn.totalTokens > 0 ||
        (["event", "subagent"].includes(turn.source) && turn.updatedAt > 0))
      .sort((left, right) => left.updatedAt - right.updatedAt)
      .map((turn) => {
        const hasUsage = turn.totalTokens > 0;
        const rawCost = hasUsage ? getCachedTurnCost(turn) : null;
        const cost = pricingManager.toViewModel(rawCost);
        const taskCost = cumulativeCosts.get(turn.taskKey) ?? {
          totalCny: 0,
          pendingTurns: 0,
        };
        if (hasUsage && cost.available) taskCost.totalCny += positiveNumber(cost.totalCny);
        else if ((hasUsage && !cost.available) || turn.completed) taskCost.pendingTurns += 1;
        cumulativeCosts.set(turn.taskKey, taskCost);
        const {
          taskKey: _taskKey,
          source: _source,
          modelSource: _modelSource,
          segments: _segments,
          rolloutPath: _rolloutPath,
          rolloutUsageFallback: _rolloutUsageFallback,
          rolloutParserVersion: _rolloutParserVersion,
          rolloutTokenCountTotalTokens: _rolloutTokenCountTotalTokens,
          responseCumulativeTotalTokens: _responseCumulativeTotalTokens,
          usageResponseIds: _usageResponseIds,
          generationMetricsVersion: _generationMetricsVersion,
          generationMetricsEnabled: _generationMetricsEnabled,
          firstTokenLatencyTotalMs: _firstTokenLatencyTotalMs,
          firstTokenLatencySamples: _firstTokenLatencySamples,
          outputGenerationDurationMs: _outputGenerationDurationMs,
          outputGenerationTokens: _outputGenerationTokens,
          pendingGenerationSamples: _pendingGenerationSamples,
          pendingGenerationUsages: _pendingGenerationUsages,
          pendingToolTimings: _pendingToolTimings,
          costRevision: _costRevision,
          ...publicTurn
        } = turn;
        return {
          ...publicTurn,
          generationDetails: publicGenerationDetails(publicTurn.generationDetails, publicTurn.toolExecutionLedger),
          cost: {
            ...cost,
            cumulativeAvailable: taskCost.pendingTurns === 0,
            cumulativeCny: taskCost.totalCny,
            cumulativePendingTurns: taskCost.pendingTurns,
          },
        };
      });
    const subagentRootByThread = new Map();
    for (const metadata of rolloutMetadataByThread.values()) {
      if (metadata.isSubagent && metadata.threadId && metadata.rootThreadId) {
        subagentRootByThread.set(metadata.threadId, metadata.rootThreadId);
      }
    }
    for (const turn of turns.values()) {
      if (turn.isSubagent && turn.threadId && turn.rootThreadId) {
        subagentRootByThread.set(turn.threadId, turn.rootThreadId);
      }
    }
    const subagentCumulativeByRoot = new Map();
    for (const [threadId, rootThreadId] of subagentRootByThread) {
      const subagentCost = cumulativeCosts.get(threadId);
      if (!subagentCost) continue;
      const rootCost = subagentCumulativeByRoot.get(rootThreadId) ?? {
        totalCny: 0,
        pendingTurns: 0,
      };
      rootCost.totalCny += positiveNumber(subagentCost.totalCny);
      rootCost.pendingTurns += positiveInteger(subagentCost.pendingTurns);
      subagentCumulativeByRoot.set(rootThreadId, rootCost);
    }
    for (const turn of mappedTurns) {
      let cumulativeCost = null;
      if (turn.isSubagentSummary) {
        cumulativeCost = cumulativeCosts.get(turn.threadId) ?? null;
      } else if (!turn.isSubagent) {
        const subagentCost = subagentCumulativeByRoot.get(turn.rootThreadId || turn.threadId);
        if (subagentCost) {
          cumulativeCost = {
            totalCny: positiveNumber(turn.cost.cumulativeCny) +
              positiveNumber(subagentCost.totalCny),
            pendingTurns: positiveInteger(turn.cost.cumulativePendingTurns) +
              positiveInteger(subagentCost.pendingTurns),
          };
        }
      }
      if (!cumulativeCost) continue;
      turn.cost.cumulativeAvailable = positiveInteger(cumulativeCost.pendingTurns) === 0;
      turn.cost.cumulativeCny = positiveNumber(cumulativeCost.totalCny);
      turn.cost.cumulativePendingTurns = positiveInteger(cumulativeCost.pendingTurns);
    }
    // Keep simultaneous in-progress turns, but cap both live and completed
    // views so a missed completion event cannot grow the UI forever.
    const liveTurns = mappedTurns
      .filter((turn) => !turn.completed)
      .slice(-maxViewTurns);
    const recentTurns = mappedTurns
      .filter((turn) => turn.completed)
      .slice(-maxViewTurns);
    return {
      status: initializing ? "loading" : error ? "error" : "ready",
      error: error,
      turns: [...recentTurns, ...liveTurns]
        .sort((left, right) => left.updatedAt - right.updatedAt),
    };
  }

export { buildUsageViewModel };
