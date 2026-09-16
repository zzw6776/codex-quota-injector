import { PENDING_REQUEST_TTL_MS, TURN_MODEL_TTL_MS, THREAD_CONTEXT_TTL_MS } from "./contract.mjs";
import { normalizedModel, providerForModel } from "./configuration.mjs";

function learnThreadContexts(value, state, { source, revision }) {
  if (!value || typeof value !== "object") return;
  const candidates = [
    value,
    value.thread,
    ...(Array.isArray(value.data) ? value.data : []),
  ].filter(Boolean);
  if (value.thread?.id && value.model) {
    candidates.push({ id: value.thread.id, model: value.model });
  }
  if (value.threadId && (value.model || value.modelProvider)) {
    candidates.push({
      id: value.threadId,
      model: value.model,
      modelProvider: value.modelProvider,
    });
  }
  for (const thread of candidates) {
    const configuredModel = readModelSetting(thread?.threadSettings ?? thread?.thread_settings);
    const model = normalizedModel(thread?.model) ?? configuredModel.model;
    const reportedProvider = normalizedModel(thread?.modelProvider);
    const threadId = thread?.id ?? thread?.threadId;
    const provider = providerForModel(model, state) ?? reportedProvider;
    if (threadId && (model || provider)) {
      updateThreadContext(state.threadContexts, threadId, {
        model,
        modelPresent: Boolean(model),
        provider,
        providerPresent: Boolean(provider),
        source,
        revision,
      });
    }
  }
}

function readModelSetting(value) {
  if (!value || typeof value !== "object") return { present: false, model: null };
  const directModel = normalizedModel(value.model);
  if (directModel) return { present: true, model: directModel };
  const nestedSettings = value.threadSettings ?? value.thread_settings;
  if (nestedSettings && nestedSettings !== value) {
    const nestedModel = readModelSetting(nestedSettings);
    if (nestedModel.present) return nestedModel;
  }
  const collaborationSettings = value.collaborationMode?.settings;
  const collaborationModel = normalizedModel(collaborationSettings?.model);
  if (collaborationModel) return { present: true, model: collaborationModel };
  // A null/empty model is a placeholder meaning that the caller did not
  // override the thread model. It must not erase an already known context.
  return { present: false, model: null };
}

function getThreadContext(threadContexts, threadId) {
  if (!threadId) return null;
  const context = threadContexts.get(String(threadId)) ?? null;
  if (context) context.lastSeenAt = Date.now();
  return context;
}

function cloneThreadContext(context) {
  return context ? { ...context } : null;
}

function restoreThreadContext(threadContexts, threadId, previousContext, revision) {
  if (!threadId) return;
  const key = String(threadId);
  const current = getThreadContext(threadContexts, key);
  if (!current || current.revision !== revision) return;
  if (previousContext) threadContexts.set(key, { ...previousContext, lastSeenAt: Date.now() });
  else threadContexts.delete(key);
}

function updateThreadContext(
  threadContexts,
  threadId,
  {
    model,
    modelPresent = false,
    provider,
    providerPresent = false,
    source = "thread",
    revision = 0,
  } = {},
) {
  if (!threadId || (!modelPresent && !providerPresent)) return false;
  const key = String(threadId);
  const current = getThreadContext(threadContexts, key);
  const nextRevision = Number.isInteger(revision) ? revision : 0;
  if (current && nextRevision < current.revision) return false;
  if (current && source === "thread-response" &&
    current.source === "thread-response" && nextRevision === current.revision &&
    ((modelPresent && current.model) || (providerPresent && current.provider))) {
    return false;
  }
  // Discovery from thread/read or thread/list is only a bootstrap fallback.
  // It may fill a missing field, but it must never replace a value learned
  // from an ordered request/response.
  if (source === "thread-discovery" && current &&
    ((modelPresent && current.model) || (providerPresent && current.provider))) {
    return false;
  }
  const next = {
    model: current?.model ?? null,
    provider: current?.provider ?? null,
    source,
    revision: Math.max(nextRevision, current?.revision ?? 0),
    lastSeenAt: Date.now(),
  };
  if (modelPresent) next.model = normalizedModel(model);
  if (providerPresent) next.provider = normalizedModel(provider);
  threadContexts.set(key, next);
  return true;
}

function resolveTurnModel(state, threadId, turnId, value) {
  const tracked = turnId ? state.turnModels.get(String(turnId)) : null;
  if (tracked) tracked.lastSeenAt = Date.now();
  const threadContext = getThreadContext(state.threadContexts, threadId);
  const setting = readModelSetting(value);
  // Usage notifications may carry a null placeholder when the model is not
  // included. Treat that as absent so the per-turn/ thread fallback survives.
  const explicit = setting.present && setting.model
    ? setting
    : { present: false, model: null };
  return {
    model: explicit.present
      ? explicit.model
      : tracked?.model ?? threadContext?.model ?? null,
    explicit: explicit.present,
    source: explicit.present
      ? "event"
      : tracked?.source ?? threadContext?.source ?? "thread",
  };
}

function rememberPendingRequest(state, requestId, value) {
  state.pendingRequests.set(requestId, {
    ...value,
    createdAt: Date.now(),
  });
}

function rememberTurnModel(state, turnId, value) {
  state.turnModels.set(String(turnId), {
    ...value,
    lastSeenAt: Date.now(),
  });
}

function pruneRelayState(state) {
  const now = Date.now();
  for (const [requestId, request] of state.pendingRequests) {
    if (now - Number(request.createdAt || 0) > PENDING_REQUEST_TTL_MS) {
      state.pendingRequests.delete(requestId);
    }
  }
  for (const [threadId, context] of state.threadContexts) {
    if (now - Number(context.lastSeenAt || 0) > THREAD_CONTEXT_TTL_MS) {
      state.threadContexts.delete(threadId);
    }
  }
  for (const [turnId, model] of state.turnModels) {
    if (now - Number(model.lastSeenAt || 0) > TURN_MODEL_TTL_MS) {
      state.turnModels.delete(turnId);
    }
  }
}

function nextModelRevision(state) {
  state.modelRevision += 1;
  return state.modelRevision;
}

export { pruneRelayState, readModelSetting, getThreadContext, cloneThreadContext, updateThreadContext, rememberPendingRequest, nextModelRevision, learnThreadContexts, restoreThreadContext, rememberTurnModel, resolveTurnModel };
