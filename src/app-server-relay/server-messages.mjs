import { isCodexAppServer, isMcpStatusListMethod } from "../host-health.mjs";
import { THREAD_METHODS, MODEL_LIST_METHOD } from "./contract.mjs";
import { handleHostToolReloadResponse, requestCodexAppToolsStatus } from "./host-tools.mjs";
import { rewriteModelListResponse } from "./model-catalog.mjs";
import { learnThreadContexts, restoreThreadContext, updateThreadContext, rememberTurnModel } from "./thread-context.mjs";
import { captureUsageNotification } from "./usage.mjs";
import { normalizedModel, providerForModel, isExtensionProvider } from "./configuration.mjs";

function rewriteServerLine(line, state) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return line;
  }
  state.hostHealth?.observeServerMessage(message);
  if (message?.method === "mcpServer/startupStatus/updated" &&
    isCodexAppServer(message.params?.name) && message.params.status === "ready") {
    requestCodexAppToolsStatus(state, message.params.threadId ?? null);
  }
  learnThreadContexts(message?.params, state, {
    source: "thread-discovery",
    revision: 0,
  });
  captureUsageNotification(message, state);
  // Server-initiated approvals/tools have their own ID space. Only responses
  // can complete a client request; preserve numeric versus string IDs as well.
  if (message?.id == null || typeof message.method === "string" ||
    (!Object.hasOwn(message, "result") && !Object.hasOwn(message, "error"))) return line;
  const pending = state.pendingRequests.get(message.id);
  if (!pending) return line;
  state.pendingRequests.delete(message.id);
  if (pending.internalHostToolReload) {
    handleHostToolReloadResponse(message, pending, state);
    return "";
  }
  if (isMcpStatusListMethod(pending.method)) {
    state.hostHealth?.observeStatusList(message.result, message.error, pending);
    return line;
  }
  if (pending.hostToolCall) {
    state.hostHealth?.observeToolResult(message.result, message.error, pending);
    return line;
  }
  if (message.error) {
    restoreThreadContext(
      state.threadContexts,
      pending.threadId,
      pending.previousContext,
      pending.modelRevision,
    );
    return line;
  }
  if (pending.method === MODEL_LIST_METHOD) {
    return rewriteModelListResponse(line, message, state, pending);
  }
  const result = message?.result;
  const thread = result?.thread ?? result;
  const threadId = thread?.id ?? pending.threadId;
  const reportedProvider = normalizedModel(result?.modelProvider) ??
    normalizedModel(thread?.modelProvider);
  // thread/start, thread/resume and thread/fork return the selected model at
  // the response envelope level, while the nested Thread object does not.
  const responseModel = normalizedModel(result?.model) ?? normalizedModel(thread?.model);
  const responseProvider = providerForModel(responseModel, state) ?? reportedProvider;
  const responseConflictsWithRequest = Boolean(
    pending.provider && responseProvider && pending.provider !== responseProvider,
  );
  const model = pending.model &&
    (isExtensionProvider(pending.provider) || responseConflictsWithRequest)
    ? pending.model
    : responseModel ?? pending.model;
  // Some app-server paths report their configured default provider (`openai`)
  // even when the selected catalog model belongs to an explicitly injected
  // provider. The catalog mapping is unambiguous after conflict filtering and
  // must win, otherwise a fork is falsely rejected as a provider switch.
  const provider = responseConflictsWithRequest
    ? pending.provider
    : providerForModel(model, state) ?? reportedProvider ?? pending.provider;
  if (threadId && (provider || model)) {
    updateThreadContext(state.threadContexts, threadId, {
      model,
      modelPresent: Boolean(model),
      provider,
      providerPresent: Boolean(provider),
      source: "thread-response",
      revision: pending.modelRevision ?? 0,
    });
  }
  learnThreadContexts(message?.result, state, {
    source: "thread-response",
    revision: pending.modelRevision ?? 0,
  });
  const resolvedTurnModel = model;
  if (pending.method === "turn/start" && result?.turn?.id && resolvedTurnModel) {
    rememberTurnModel(state, result.turn.id, {
      model: resolvedTurnModel,
      source: responseModel ? "turn-response" : pending.modelSource ?? "thread",
    });
  }
  if (threadId && THREAD_METHODS.has(pending.method)) {
    state.emitUsageEvent({
      type: "thread-active",
      threadId,
      model,
      modelSource: "thread-response",
    });
  }
  return line;
}

export { rewriteServerLine };
