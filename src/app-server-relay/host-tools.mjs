import { randomUUID } from "node:crypto";
import { MCP_CONFIG_RELOAD_METHOD, HOST_TOOL_RELOAD_TIMEOUT_MS, MCP_STATUS_LIST_METHOD } from "./contract.mjs";
import { rememberPendingRequest } from "./thread-context.mjs";

function requestCodexAppToolsReload(state) {
  if (state.hostToolReloadInFlight) return;
  state.hostToolReloadInFlight = true;
  state.hostHealth?.observeReloadStarted();
  sendHostToolReloadRequest(state, MCP_CONFIG_RELOAD_METHOD, "reload");
}

function requestCodexAppToolsStatus(state, threadId) {
  if (!state.hostHealth || state.hostHealth.snapshot(threadId).status === "ready") return;
  state.hostToolStatusQueue ??= new Set();
  state.hostToolStatusQueue.add(threadId);
  drainHostToolStatusQueue(state);
}

function drainHostToolStatusQueue(state) {
  if (state.hostToolReloadInFlight) return;
  for (const threadId of state.hostToolStatusQueue ?? []) {
    state.hostToolStatusQueue.delete(threadId);
    if (state.hostHealth.snapshot(threadId).status === "ready") continue;
    state.hostToolReloadInFlight = true;
    sendHostToolReloadRequest(state, MCP_STATUS_LIST_METHOD, "startup-verify", threadId);
    return;
  }
}

function sendHostToolReloadRequest(state, method, phase, threadId = null) {
  const id = `codex-quota-host-tools-${phase}-${randomUUID()}`;
  const pending = {
    method,
    internalHostToolReload: true,
    phase,
    threadId,
    healthRevision: state.hostHealth?.statusRevision(threadId),
  };
  rememberPendingRequest(state, id, pending);
  try {
    // The official schema models config/mcpServer/reload as a unit request,
    // while mcpServerStatus/list requires an object even when all fields use
    // defaults. Keep both requests schema-exact for stricter app-server builds.
    state.sendUpstream(method === MCP_CONFIG_RELOAD_METHOD
      ? { id, method }
      : { id, method, params: threadId == null ? {} : { threadId } });
  } catch (error) {
    state.pendingRequests.delete(id);
    reportHostToolError(state, pending, error);
    finishHostToolReload(state);
    return;
  }
  clearTimeout(state.hostToolReloadTimer);
  state.hostToolReloadTimer = setTimeout(() => {
    const request = state.pendingRequests.get(id);
    if (request) request.expired = true;
    reportHostToolError(state, pending, new Error("官方 app-server 核验任务工具超时"));
    finishHostToolReload(state);
  }, HOST_TOOL_RELOAD_TIMEOUT_MS);
  state.hostToolReloadTimer.unref?.();
}

function handleHostToolReloadResponse(message, pending, state) {
  if (pending.expired) return;
  clearTimeout(state.hostToolReloadTimer);
  state.hostToolReloadTimer = null;
  if (message.error) {
    reportHostToolError(state, pending, message.error);
    finishHostToolReload(state);
    return;
  }
  if (pending.phase === "reload") {
    sendHostToolReloadRequest(state, MCP_STATUS_LIST_METHOD, "verify");
    return;
  }
  state.hostHealth?.observeStatusList(message.result, message.error, pending);
  finishHostToolReload(state);
}

function reportHostToolError(state, pending, error) {
  if (pending.phase === "startup-verify") state.hostHealth?.observeStatusList(null, error, pending);
  else state.hostHealth?.observeReloadFailed(error);
}

function finishHostToolReload(state) {
  clearTimeout(state.hostToolReloadTimer);
  state.hostToolReloadTimer = null;
  state.hostToolReloadInFlight = false;
  drainHostToolStatusQueue(state);
}

export { requestCodexAppToolsReload, requestCodexAppToolsStatus, handleHostToolReloadResponse };
