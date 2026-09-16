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
  if (!state.hostHealth || state.hostToolReloadInFlight ||
    state.hostHealth.snapshot().status === "ready") return;
  state.hostToolReloadInFlight = true;
  sendHostToolReloadRequest(state, MCP_STATUS_LIST_METHOD, "startup-verify", threadId);
}

function sendHostToolReloadRequest(state, method, phase, threadId = null) {
  const id = `codex-quota-host-tools-${phase}-${randomUUID()}`;
  rememberPendingRequest(state, id, {
    method,
    internalHostToolReload: true,
    phase,
    threadId,
  });
  try {
    // The official schema models config/mcpServer/reload as a unit request,
    // while mcpServerStatus/list requires an object even when all fields use
    // defaults. Keep both requests schema-exact for stricter app-server builds.
    state.sendUpstream(method === MCP_CONFIG_RELOAD_METHOD
      ? { id, method }
      : { id, method, params: threadId == null ? {} : { threadId } });
  } catch (error) {
    state.pendingRequests.delete(id);
    reportHostToolError(state, phase, threadId, error);
    finishHostToolReload(state);
    return;
  }
  clearTimeout(state.hostToolReloadTimer);
  state.hostToolReloadTimer = setTimeout(() => {
    const pending = state.pendingRequests.get(id);
    if (pending) pending.expired = true;
    reportHostToolError(state, phase, threadId, new Error("官方 app-server 核验任务工具超时"));
    finishHostToolReload(state);
  }, HOST_TOOL_RELOAD_TIMEOUT_MS);
  state.hostToolReloadTimer.unref?.();
}

function handleHostToolReloadResponse(message, pending, state) {
  if (pending.expired) return;
  clearTimeout(state.hostToolReloadTimer);
  state.hostToolReloadTimer = null;
  if (message.error) {
    reportHostToolError(state, pending.phase, pending.threadId, message.error);
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

function reportHostToolError(state, phase, threadId, error) {
  if (phase === "startup-verify") state.hostHealth?.observeStatusList(null, error, { threadId });
  else state.hostHealth?.observeReloadFailed(error);
}

function finishHostToolReload(state) {
  clearTimeout(state.hostToolReloadTimer);
  state.hostToolReloadTimer = null;
  state.hostToolReloadInFlight = false;
}

export { requestCodexAppToolsReload, requestCodexAppToolsStatus, handleHostToolReloadResponse };
