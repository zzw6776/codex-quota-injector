import { GENERATION_METRICS_VERSION } from "../relay-contract.mjs";
import { THREAD_ROUTE_TTL_MS, MAX_THREAD_ROUTES, MAX_TURN_USAGE, MAX_PENDING_TOOL_BATCHES, httpError, nonEmptyString } from "./contract.mjs";
import { collectCallReferenceIds, pendingToolCallKey, pendingToolBatchKey } from "./request-metadata.mjs";
import { emptyUsage, addUsage, createUsageEventWriter } from "./usage.mjs";

// Owns task-provider reservations and the usage/tool records produced by requests.
export class RouterRequestLedger {
  constructor(networkMonitor) {
    this.networkMonitor = networkMonitor;
    this.usageWriter = null;
    this.usageEventPath = null;
    this.threadRoutes = new Map();
    this.turnUsage = new Map();
    this.pendingToolBatches = new Map();
    this.toolCallBatchKeys = new Map();
  }

  rememberedRoute(threadId) { return this.threadRoutes.get(threadId); }
  clearRoutes() { this.threadRoutes.clear(); }

  reset() {
    this.threadRoutes.clear();
    this.turnUsage.clear();
    this.pendingToolBatches.clear();
    this.toolCallBatchKeys.clear();
  }

  close() {
    const writer = this.usageWriter;
    this.usageWriter = null;
    this.pendingToolBatches.clear();
    this.toolCallBatchKeys.clear();
    return writer ? writer.close() : Promise.resolve();
  }

  async ensureUsageWriter(path) {
    const normalizedPath = String(path ?? "").trim() || null;
    if (normalizedPath === this.usageEventPath && this.usageWriter) return;
    const previousWriter = this.usageWriter;
    this.usageEventPath = normalizedPath;
    this.usageWriter = createUsageEventWriter(normalizedPath);
    if (previousWriter) await previousWriter.close();
  }

  activateRequestContext(context) {
    if (!context.generates) return null;
    const routeClaim = this.#reserveThreadRoute(context);
    try {
      this.#recordCompletedToolCalls(
        context.input,
        context.threadId,
        context.requestStartedAt,
      );
      const {
        threadId,
        turnId,
        model,
        rolloutUsageFallback,
        networkLatencySupported,
        networkConnectionId,
        networkLatency,
      } = context;
      if (turnId) {
        this.usageWriter?.write({
          type: "request-tool-inventory",
          threadId,
          turnId,
          model,
          modelSource: "turn-request",
          tools: context.toolInventory,
        });
        this.usageWriter?.write({
          type: "thread-active",
          threadId,
          model,
          modelSource: "turn-request",
          rolloutUsageFallback,
        });
        this.usageWriter?.write({
          type: "turn-started",
          threadId,
          turnId,
          model,
          modelSource: "turn-request",
          rolloutUsageFallback,
          generationMetricsVersion: GENERATION_METRICS_VERSION,
          networkLatencySupported,
          networkConnectionId,
          networkLatency,
        });
      }
      return routeClaim;
    } catch (error) {
      this.settleThreadRoute(routeClaim, false);
      throw error;
    }
  }

  #reserveThreadRoute({ threadId, target, model, requestId }) {
    if (!threadId) return;
    const routeKey = target.routeKey;
    const previous = this.threadRoutes.get(threadId);
    if (previous && previous.routeKey !== routeKey) {
      throw httpError(
        409,
        `同一任务不能切换模型供应商（${previous.model} → ${model}）；请新建任务后再选择目标模型`,
      );
    }
    const claim = { threadId, routeKey, model, requestId };
    const route = previous ?? {
      routeKey,
      model,
      confirmed: false,
      pending: new Map(),
      updatedAt: Date.now(),
    };
    route.pending.set(requestId, { model, updatedAt: Date.now() });
    if (!route.confirmed) route.model = model;
    route.updatedAt = Date.now();
    this.threadRoutes.delete(threadId);
    this.threadRoutes.set(threadId, route);
    this.#pruneState();
    return claim;
  }

  settleThreadRoute(claim, accepted) {
    if (!claim?.threadId) return;
    const route = this.threadRoutes.get(claim.threadId);
    if (!route || route.routeKey !== claim.routeKey ||
      !route.pending.has(claim.requestId)) return;
    route.pending.delete(claim.requestId);
    if (accepted) {
      route.confirmed = true;
      route.model = claim.model;
      route.updatedAt = Date.now();
      this.threadRoutes.delete(claim.threadId);
      this.threadRoutes.set(claim.threadId, route);
      this.#pruneState();
      return;
    }
    if (route.confirmed) return;
    if (route.pending.size === 0) {
      this.threadRoutes.delete(claim.threadId);
      return;
    }
    route.model = [...route.pending.values()].at(-1).model;
  }

  #pruneState() {
    const cutoff = Date.now() - THREAD_ROUTE_TTL_MS;
    for (const [threadId, route] of this.threadRoutes) {
      if (route.updatedAt >= cutoff && this.threadRoutes.size <= MAX_THREAD_ROUTES) break;
      this.threadRoutes.delete(threadId);
    }
    while (this.turnUsage.size > MAX_TURN_USAGE) {
      this.turnUsage.delete(this.turnUsage.keys().next().value);
    }
    for (const [key, batch] of this.pendingToolBatches) {
      if (batch.readyAt >= cutoff &&
        this.pendingToolBatches.size <= MAX_PENDING_TOOL_BATCHES) break;
      this.#deletePendingToolBatch(key, batch);
    }
  }

  recordUsage(context, usage, responseId = null) {
    if (!context.threadId || !context.turnId) return;
    // Official Codex writes the same response usage to rollout. Keep that
    // response-level ledger authoritative; TokenUsageManager pairs and ignores
    // the legacy token_count summary that follows it.
    if (context.rolloutUsageFallback) return;
    const key = `${context.threadId}\u0000${context.turnId}`;
    const total = this.turnUsage.get(key) ?? emptyUsage();
    addUsage(total, usage);
    this.turnUsage.delete(key);
    this.turnUsage.set(key, total);
    const usageResponseId = nonEmptyString(responseId) ??
      `router-request:${context.requestId}`;
    this.usageWriter?.write({
      type: "usage",
      threadId: context.threadId,
      turnId: context.turnId,
      model: context.model,
      modelSource: "usage",
      rolloutUsageFallback: context.rolloutUsageFallback,
      responseId: usageResponseId,
      tokenUsage: { last: usage, total },
    });
    this.#pruneState();
  }

  recordGeneration(context, generation) {
    if (!context.threadId || !context.turnId) return;
    const networkLatency = context.networkLatencySupported
      ? this.networkMonitor.nearestNetworkSample(context.networkConnectionId, context.requestStartedAt) ??
        context.networkLatency
      : null;
    this.usageWriter?.write({
      type: "generation",
      threadId: context.threadId,
      turnId: context.turnId,
      model: context.model,
      modelSource: "generation",
      generationMetricsVersion: GENERATION_METRICS_VERSION,
      generation: {
        ...generation,
        responseId: nonEmptyString(generation?.responseId) ??
          `router-request:${context.requestId}`,
        followsToolResult: context.followsToolResult,
        networkLatency,
      },
    });
  }

  recordPendingToolCall(context, call) {
    if (!context.threadId || !context.turnId || !call?.referenceId) return;
    const batchKey = pendingToolBatchKey(context.threadId, context.requestId);
    const batch = this.pendingToolBatches.get(batchKey) ?? {
      threadId: context.threadId,
      turnId: context.turnId,
      requestId: context.requestId,
      requestStartedAt: context.requestStartedAt,
      toolNames: new Set(),
      calls: new Map(),
      preparationStartedAt: Number(call.preparationStartedAt) || null,
      readyAt: Number(call.readyAt) || Date.now(),
      allReadyAt: Number(call.readyAt) || Date.now(),
    };
    const readyAt = Number(call.readyAt) || Date.now();
    const preparationStartedAt = Number(call.preparationStartedAt) || null;
    if (preparationStartedAt) {
      batch.preparationStartedAt = batch.preparationStartedAt
        ? Math.min(batch.preparationStartedAt, preparationStartedAt)
        : preparationStartedAt;
    }
    batch.readyAt = Math.min(batch.readyAt, readyAt);
    batch.allReadyAt = Math.max(batch.allReadyAt, readyAt);
    const toolName = nonEmptyString(call.toolName);
    if (toolName) batch.toolNames.add(toolName);
    batch.calls.set(call.referenceId, {
      referenceId: call.referenceId,
      toolName,
      preparationStartedAt,
      readyAt,
      completedAt: null,
    });
    this.pendingToolBatches.delete(batchKey);
    this.pendingToolBatches.set(batchKey, batch);
    this.toolCallBatchKeys.set(
      pendingToolCallKey(context.threadId, call.referenceId),
      batchKey,
    );
    this.#pruneState();
  }

  #recordCompletedToolCalls(input, threadId, completedAt) {
    if (!threadId) return;
    const completedBatchKeys = new Set();
    for (const referenceId of collectCallReferenceIds(input)) {
      const referenceKey = pendingToolCallKey(threadId, referenceId);
      const batchKey = this.toolCallBatchKeys.get(referenceKey);
      const batch = batchKey ? this.pendingToolBatches.get(batchKey) : null;
      if (!batch) continue;
      const call = batch.calls.get(referenceId);
      if (call) call.completedAt = completedAt;
      this.toolCallBatchKeys.delete(referenceKey);
      if ([...batch.calls.values()].every((value) => value.completedAt != null)) {
        completedBatchKeys.add(batchKey);
      }
    }
    for (const batchKey of completedBatchKeys) {
      const batch = this.pendingToolBatches.get(batchKey);
      if (!batch) continue;
      const calls = [...batch.calls.values()];
      const batchCompletedAt = Math.max(...calls.map((call) => call.completedAt), completedAt);
      this.usageWriter?.write({
        type: "generation-tool-timing",
        threadId: batch.threadId,
        turnId: batch.turnId,
        modelSource: "generation",
        generationMetricsVersion: GENERATION_METRICS_VERSION,
        requestId: batch.requestId,
        toolTiming: {
          toolNames: [...batch.toolNames],
          toolCount: calls.length,
          readyLatencyMs: Math.max(0, batch.allReadyAt - batch.requestStartedAt),
          preparationStartLatencyMs: batch.preparationStartedAt
            ? Math.max(0, batch.preparationStartedAt - batch.requestStartedAt)
            : null,
          preparationDurationMs: batch.preparationStartedAt
            ? Math.max(0, batch.allReadyAt - batch.preparationStartedAt)
            : null,
          durationMs: Math.max(0, batchCompletedAt - batch.readyAt),
          calls: calls.map((call) => ({
            toolName: call.toolName,
            preparationDurationMs: call.preparationStartedAt
              ? Math.max(0, call.readyAt - call.preparationStartedAt)
              : null,
            durationMs: Math.max(0, call.completedAt - call.readyAt),
          })),
        },
      });
      this.#deletePendingToolBatch(batchKey, batch);
    }
  }

  #deletePendingToolBatch(batchKey, batch) {
    this.pendingToolBatches.delete(batchKey);
    for (const referenceId of batch.calls.keys()) {
      this.toolCallBatchKeys.delete(pendingToolCallKey(batch.threadId, referenceId));
    }
  }
}
