import { MIN_GENERATION_METRICS_VERSION } from "../relay-contract.mjs";
import { ROLLOUT_PARSER_VERSION, TERMINAL_TURN_STATUSES, positiveNumber, positiveInteger, nonEmptyString } from "./contract.mjs";
import { emptyTurn, markUsageResponse, addUsage, fillUnknownSegmentModels, setTurnModel, normalizeProtocolUsage } from "./turns.mjs";
import { recordGenerationSample, resetGenerationMetrics, recordGenerationToolTiming, normalizeNetworkLatency, recordGenerationUsage } from "./generation.mjs";

function processTurnUsageEvent(event, { turns, rolloutFallbackThreads, threadId, model, updatedAt }) {
    const turnId = nonEmptyString(event.turnId);
    if (!turnId) return;
    if (event.type === "turn-started") {
      const turn = turns.get(turnId) ?? emptyTurn(turnId, threadId, "event");
      turn.source = "event";
      turn.rolloutUsageFallback ||= Boolean(event.rolloutUsageFallback);
      if (Object.hasOwn(event, "networkLatencySupported")) {
        const previousConnectionId = turn.networkConnectionId;
        turn.networkLatencySupported = Boolean(event.networkLatencySupported);
        turn.networkConnectionId = nonEmptyString(event.networkConnectionId);
        if (!turn.networkLatencySupported ||
          (previousConnectionId && previousConnectionId !== turn.networkConnectionId)) {
          turn.networkLatency = null;
        }
        const networkLatency = normalizeNetworkLatency(event.networkLatency);
        if (networkLatency) turn.networkLatency = networkLatency;
      }
      const generationMetricsVersion = positiveInteger(event.generationMetricsVersion);
      if (generationMetricsVersion > turn.generationMetricsVersion) {
        if (turn.generationMetricsVersion < MIN_GENERATION_METRICS_VERSION) resetGenerationMetrics(turn);
        turn.generationMetricsVersion = generationMetricsVersion;
      }
      turn.generationMetricsEnabled ||=
        generationMetricsVersion >= MIN_GENERATION_METRICS_VERSION;
      if (!turn.startedAt) turn.startedAt = updatedAt;
      if (model) {
        fillUnknownSegmentModels(turn, model, event.modelSource ?? "turn-started");
        setTurnModel(turn, model, event.modelSource ?? "turn-started");
      }
      turn.updatedAt = updatedAt;
      turns.set(turnId, turn);
      if (turn.rolloutUsageFallback) {
        rolloutFallbackThreads.delete(threadId);
        rolloutFallbackThreads.set(threadId, updatedAt);
      }
      return;
    }
    if (event.type === "usage") {
      const last = normalizeProtocolUsage(event.tokenUsage?.last);
      if (!last) return;
      let turn = turns.get(turnId);
      if (!turn) turn = emptyTurn(turnId, threadId, "event");
      // Relay events are authoritative for live turns, but a rollout record
      // may have been loaded first. Preserve its counters and append only a
      // genuinely newer event delta instead of replacing the whole turn.
      turn.source = "event";
      if (!turn.startedAt) turn.startedAt = updatedAt;
      const modelSource = event.modelSource ?? "thread";
      const incomingTotal = positiveNumber(event.tokenUsage?.total?.totalTokens);
      const previousResponseTotal = positiveNumber(turn.responseCumulativeTotalTokens);
      if (model) {
        // A reroute starts a new model segment. Unknown tokens before that
        // boundary must stay unresolved instead of being relabeled with the
        // new model.
        if (modelSource !== "rerouted") {
          fillUnknownSegmentModels(turn, model, modelSource);
        }
        setTurnModel(turn, model, modelSource);
      }
      const waitForRollout = event.rolloutUsageFallback == null
        ? turn.rolloutUsageFallback
        : Boolean(event.rolloutUsageFallback);
      if (waitForRollout) {
        // Legacy official usage events and rollout records describe the same
        // upstream response. Keep rollout authoritative for these events; an
        // auxiliary event explicitly opts out when Codex may not persist it.
        const modelContextWindow = positiveNumber(event.tokenUsage?.modelContextWindow);
        if (modelContextWindow > 0) turn.modelContextWindow = modelContextWindow;
        turn.updatedAt = updatedAt;
        turns.set(turnId, turn);
        return;
      }
      const responseId = nonEmptyString(event.responseId);
      const isNewResponse = responseId ? markUsageResponse(turn, responseId) : true;
      const shouldAdd = responseId
        ? isNewResponse
        : incomingTotal <= 0 || incomingTotal > previousResponseTotal;
      if (shouldAdd) {
        // The event can carry a stale lower-priority model after a reroute.
        // Price the delta with the model that won the source-priority check,
        // rather than relabeling a post-reroute segment with that stale value.
        addUsage(
          turn,
          last,
          turn.model || model,
          turn.modelSource || modelSource,
        );
        recordGenerationUsage(turn, last, responseId);
      }
      turn.responseCumulativeTotalTokens = Math.max(previousResponseTotal, incomingTotal);
      turn.cumulativeTotalTokens = Math.max(
        positiveNumber(turn.cumulativeTotalTokens),
        incomingTotal,
      );
      if (responseId) turn.rolloutParserVersion = ROLLOUT_PARSER_VERSION;
      const modelContextWindow = positiveNumber(event.tokenUsage?.modelContextWindow);
      if (modelContextWindow > 0) turn.modelContextWindow = modelContextWindow;
      turn.updatedAt = updatedAt;
      turns.set(turnId, turn);
      return;
    }

    if (event.type === "generation") {
      const generationMetricsVersion = positiveInteger(event.generationMetricsVersion);
      if (generationMetricsVersion < MIN_GENERATION_METRICS_VERSION) return;
      const turn = turns.get(turnId) ?? emptyTurn(turnId, threadId, "event");
      if (generationMetricsVersion > turn.generationMetricsVersion) {
        if (turn.generationMetricsVersion < MIN_GENERATION_METRICS_VERSION) resetGenerationMetrics(turn);
        turn.generationMetricsVersion = generationMetricsVersion;
      }
      turn.source = "event";
      turn.generationMetricsEnabled = true;
      if (!turn.startedAt) turn.startedAt = updatedAt;
      if (model) {
        fillUnknownSegmentModels(turn, model, event.modelSource ?? "generation");
        setTurnModel(turn, model, event.modelSource ?? "generation");
      }
      recordGenerationSample(turn, event.generation);
      turn.updatedAt = Math.max(positiveNumber(turn.updatedAt), updatedAt);
      turns.set(turnId, turn);
      return;
    }

    if (event.type === "generation-tool-timing") {
      const generationMetricsVersion = positiveInteger(event.generationMetricsVersion);
      if (generationMetricsVersion < MIN_GENERATION_METRICS_VERSION) return;
      const turn = turns.get(turnId) ?? emptyTurn(turnId, threadId, "event");
      if (generationMetricsVersion > turn.generationMetricsVersion) {
        if (turn.generationMetricsVersion < MIN_GENERATION_METRICS_VERSION) resetGenerationMetrics(turn);
        turn.generationMetricsVersion = generationMetricsVersion;
      }
      turn.source = "event";
      turn.generationMetricsEnabled = true;
      recordGenerationToolTiming(turn, event);
      turn.updatedAt = Math.max(positiveNumber(turn.updatedAt), updatedAt);
      turns.set(turnId, turn);
      return;
    }

    if (event.type === "turn-completed") {
      const turn = turns.get(turnId) ?? emptyTurn(turnId, threadId, "event");
      turn.source = "event";
      if (!turn.startedAt) turn.startedAt = updatedAt;
      if (model && event.modelSource !== "rerouted") {
        fillUnknownSegmentModels(turn, model, event.modelSource ?? "completed");
      }
      setTurnModel(turn, model, event.modelSource ?? "thread");
      turn.status = nonEmptyString(event.status);
      turn.completed = TERMINAL_TURN_STATUSES.has(turn.status);
      turn.updatedAt = updatedAt;
      turns.set(turnId, turn);
      rolloutFallbackThreads.delete(threadId);
    }
  }

export { processTurnUsageEvent };
