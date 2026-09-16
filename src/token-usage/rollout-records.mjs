import { recordToolExecution, simplifyToolExecutionRecord } from "../tool-executions.mjs";
import { positiveNumber, nonEmptyString, parseTimestamp } from "./contract.mjs";
import { emptyTurn, prepareRolloutUsageTurn, markUsageResponse, enqueuePendingUsageRecord, consumePendingUsageRecord, addUsage, fillUnknownSegmentModels, setTurnModel, normalizeRolloutUsage } from "./turns.mjs";
import { recordGenerationUsage } from "./generation.mjs";

function processRolloutRecord(record, state, { turns, markDirty }) {
    const execution = record.toolExecution ?? (record.type === "tool_execution_record"
      ? record.payload
      : simplifyToolExecutionRecord(record, state.currentTurnId));
    if (execution && (!execution.threadId || execution.threadId === state.threadId)) {
      const turn = turns.get(execution.turnId) ??
        emptyTurn(execution.turnId, state.threadId, "rollout", state.path);
      if (turn.threadId === state.threadId) {
        recordToolExecution(turn.toolExecutionLedger, execution);
        if (!turn.rolloutPath) turn.rolloutPath = state.path;
        turns.set(turn.turnId, turn);
        markDirty();
      }
    }
    if (record.type === "turn_context" && record.payload?.turn_id) {
      state.currentTurnId = String(record.payload.turn_id);
      const existing = turns.get(state.currentTurnId);
      const turn = existing ?? emptyTurn(state.currentTurnId, state.threadId, "rollout", state.path);
      const model = nonEmptyString(record.payload.model);
      if (!turn.startedAt) turn.startedAt = parseTimestamp(record.timestamp);
      if (model) state.threadModel = model;
      setTurnModel(turn, model, "turn-context");
      fillUnknownSegmentModels(turn, model, "turn-context");
      if (turn.source === "rollout") turn.updatedAt = parseTimestamp(record.timestamp);
      turns.set(turn.turnId, turn);
      markDirty();
    }
    if (record.type === "response_item") {
      const turnId = record.payload?.internal_chat_message_metadata_passthrough?.turn_id;
      if (turnId) state.currentTurnId = String(turnId);
    }
    if (record.type === "token_usage_record") {
      const turnId = nonEmptyString(record.payload?.turn_id);
      const responseId = nonEmptyString(record.payload?.response_id);
      const usage = normalizeRolloutUsage(record.payload?.usage);
      if (!turnId || !responseId || !usage) return;
      state.currentTurnId = turnId;
      enqueuePendingUsageRecord(state, turnId, responseId, usage);
      const existing = turns.get(turnId);
      const turn = existing ?? emptyTurn(turnId, state.threadId, "rollout", state.path);
      // Unkeyed app-server notifications are a provisional live view. Once an
      // exact response ledger exists, rebuild from that ledger regardless of
      // provider or model so historical notifications cannot hide compaction.
      prepareRolloutUsageTurn(turn);
      if (!turn.rolloutPath) turn.rolloutPath = state.path;
      const model = turn.model || state.threadModel;
      if (model) {
        setTurnModel(turn, model, turn.modelSource || "thread-settings");
        fillUnknownSegmentModels(turn, model, turn.modelSource || "thread-settings");
      }
      const cumulativeTotal = positiveNumber(record.payload?.turn_token_usage?.total_tokens);
      const previousResponseTotal = positiveNumber(turn.responseCumulativeTotalTokens);
      // Response identity is authoritative. The cumulative figure is only a
      // display watermark: auxiliary and rollout ledgers can use independent
      // baselines, so comparing them would discard a valid newer response.
      if (markUsageResponse(turn, responseId)) {
        addUsage(turn, usage, turn.model || model, turn.modelSource);
        recordGenerationUsage(turn, usage, responseId);
      }
      turn.responseCumulativeTotalTokens = Math.max(
        previousResponseTotal,
        cumulativeTotal,
      );
      turn.cumulativeTotalTokens = Math.max(
        positiveNumber(turn.cumulativeTotalTokens),
        cumulativeTotal,
      );
      if (!turn.startedAt) turn.startedAt = parseTimestamp(record.timestamp);
      turn.updatedAt = Math.max(
        positiveNumber(turn.updatedAt),
        parseTimestamp(record.timestamp),
      );
      turns.set(turnId, turn);
      markDirty();
      return;
    }
    if (record.type !== "event_msg") return;

    if (record.payload?.type === "thread_settings_applied") {
      const model = nonEmptyString(record.payload.model) ??
        nonEmptyString(record.payload.thread_settings?.model);
      if (!model) return;
      state.threadModel = model;
      const currentTurn = state.currentTurnId ? turns.get(state.currentTurnId) : null;
      if (currentTurn && !currentTurn.completed) {
        setTurnModel(currentTurn, model, "thread-settings");
        fillUnknownSegmentModels(currentTurn, model, "thread-settings");
        markDirty();
      }
      return;
    }

    if (record.payload?.type === "task_started") {
      const turnId = nonEmptyString(record.payload.turn_id);
      if (!turnId) return;
      state.currentTurnId = turnId;
      const turn = turns.get(turnId) ?? emptyTurn(
        turnId,
        state.threadId,
        "rollout",
        state.path,
      );
      if (!turn.startedAt) turn.startedAt = parseTimestamp(record.timestamp);
      const model = nonEmptyString(record.payload.model) ?? state.threadModel;
      setTurnModel(turn, model, "thread-settings");
      fillUnknownSegmentModels(turn, model, "thread-settings");
      turns.set(turnId, turn);
      markDirty();
      return;
    }

    if (record.payload?.type === "turn_aborted") {
      const turnId = nonEmptyString(record.payload.turn_id) ?? state.currentTurnId;
      if (!turnId) return;
      state.currentTurnId = turnId;
      const turn = turns.get(turnId);
      if (!turn) return;
      if (turn.source === "event") {
        turn.status = record.payload.reason === "interrupted" ? "interrupted" : "failed";
        turn.completed = true;
        turn.updatedAt = parseTimestamp(record.timestamp);
        markDirty();
        return;
      }
      turn.completed = true;
      turn.status = record.payload.reason === "interrupted" ? "interrupted" : "failed";
      turn.updatedAt = parseTimestamp(record.timestamp);
      markDirty();
      return;
    }

    if (!state.currentTurnId) return;

    if (record.payload?.type === "token_count") {
      const last = normalizeRolloutUsage(record.payload.info?.last_token_usage);
      if (!last) return;
      const existing = turns.get(state.currentTurnId);
      const incomingTotal = positiveNumber(
        record.payload.info?.total_token_usage?.total_tokens,
      );
      const pairedUsageRecord = consumePendingUsageRecord(
        state,
        state.currentTurnId,
        last,
      );
      if (pairedUsageRecord) {
        const turn = existing ?? emptyTurn(
          state.currentTurnId,
          state.threadId,
          "rollout",
          state.path,
        );
        prepareRolloutUsageTurn(turn);
        turn.rolloutTokenCountTotalTokens = Math.max(
          positiveNumber(turn.rolloutTokenCountTotalTokens),
          incomingTotal,
        );
        turn.cumulativeTotalTokens = Math.max(
          positiveNumber(turn.cumulativeTotalTokens),
          incomingTotal,
        );
        const modelContextWindow = positiveNumber(record.payload.info?.model_context_window);
        if (modelContextWindow > 0) turn.modelContextWindow = modelContextWindow;
        turn.updatedAt = Math.max(
          positiveNumber(turn.updatedAt),
          parseTimestamp(record.timestamp),
        );
        turns.set(turn.turnId, turn);
        markDirty();
        return;
      }
      if (existing?.source === "event" && !existing.rolloutUsageFallback) {
        // Relay events are buffered and can arrive after this rollout record.
        // Do not advance their deduplication watermark without adding usage:
        // the matching relay event would otherwise be discarded as a duplicate.
        const modelContextWindow = positiveNumber(record.payload.info?.model_context_window);
        if (modelContextWindow > 0) existing.modelContextWindow = modelContextWindow;
        markDirty();
        return;
      }
      const turn = existing ?? emptyTurn(
        state.currentTurnId,
        state.threadId,
        "rollout",
        state.path,
      );
      prepareRolloutUsageTurn(turn);
      const previousRolloutTotal = positiveNumber(turn.rolloutTokenCountTotalTokens);
      if (incomingTotal > 0 && incomingTotal <= previousRolloutTotal) {
        // Rollout can repeat the same cumulative token_count record, and a
        // continued task can expose an overlapping record in another file.
        // Treat the cumulative total as the common deduplication watermark.
        const modelContextWindow = positiveNumber(record.payload.info?.model_context_window);
        if (modelContextWindow > 0) turn.modelContextWindow = modelContextWindow;
        turns.set(turn.turnId, turn);
        markDirty();
        return;
      }
      addUsage(turn, last, turn.model, turn.modelSource);
      recordGenerationUsage(turn, last);
      turn.rolloutTokenCountTotalTokens = Math.max(previousRolloutTotal, incomingTotal);
      turn.cumulativeTotalTokens = Math.max(
        positiveNumber(turn.cumulativeTotalTokens),
        incomingTotal,
      );
      turn.modelContextWindow = positiveNumber(record.payload.info?.model_context_window);
      turn.updatedAt = parseTimestamp(record.timestamp);
      turns.set(turn.turnId, turn);
      markDirty();
      return;
    }

    if (record.payload?.type === "task_complete") {
      const turn = turns.get(state.currentTurnId);
      if (!turn) return;
      turn.completed = true;
      turn.status = "completed";
      turn.updatedAt = parseTimestamp(record.timestamp);
      markDirty();
    }
  }

export { processRolloutRecord };
