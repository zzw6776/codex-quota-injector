import { isMcpStatusListMethod } from "../host-health.mjs";
import { THREAD_METHODS, THREAD_SETTINGS_METHOD, MODEL_LIST_METHOD, OBSERVED_THREAD_METHODS, TURN_INPUT_METHODS } from "./contract.mjs";
import { readModelSetting, getThreadContext, cloneThreadContext, updateThreadContext, rememberPendingRequest, nextModelRevision } from "./thread-context.mjs";
import { normalizedModel, providerForModel, deepSeekRouteModel, customThreadConfig, isCustomProvider, customPlatformForProvider, containsImageInput, jsonRpcError } from "./configuration.mjs";

function rewriteClientLine(line, state) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return line;
  }
  if (!message || typeof message !== "object") return line;

  const method = message.method;
  const params = message.params && typeof message.params === "object"
    ? { ...message.params }
    : {};
  if (isMcpStatusListMethod(method)) {
    if (message.id != null) {
      rememberPendingRequest(state, message.id, {
        method, threadId: params.threadId ?? null,
        healthRevision: state.hostHealth?.statusRevision(params.threadId ?? null),
      });
    }
    return line;
  }
  if (method === MODEL_LIST_METHOD) {
    if (message.id != null) {
      rememberPendingRequest(state, message.id, {
        method,
        cursor: params.cursor ?? null,
      });
    }
    return line;
  }
  if (!OBSERVED_THREAD_METHODS.has(method) && !TURN_INPUT_METHODS.has(method)) return line;
  const requestRevision = nextModelRevision(state);

  if (method === THREAD_SETTINGS_METHOD) {
    const configuredModel = readModelSetting(
      params.threadSettings ?? params.thread_settings ?? params,
    );
    const previousContext = params.threadId
      ? cloneThreadContext(getThreadContext(state.threadContexts, params.threadId))
      : null;
    if (params.threadId && configuredModel.present) {
      updateThreadContext(state.threadContexts, params.threadId, {
        model: configuredModel.model,
        modelPresent: true,
        source: "thread-settings",
        revision: requestRevision,
      });
    }
    if (message.id != null) {
      rememberPendingRequest(state, message.id, {
        method,
        provider: null,
        threadId: params.threadId ?? null,
        model: configuredModel.present ? configuredModel.model : null,
        modelSource: "thread-settings",
        modelRevision: requestRevision,
        previousContext,
      });
    }
    return JSON.stringify({ ...message, params });
  }

  if (!THREAD_METHODS.has(method) && !TURN_INPUT_METHODS.has(method)) {
    if (message.id != null) {
      rememberPendingRequest(state, message.id, {
        method,
        provider: null,
        threadId: params.threadId ?? null,
        model: null,
        modelSource: "thread",
        modelRevision: requestRevision,
      });
    }
    return line;
  }
  const threadContext = getThreadContext(state.threadContexts, params.threadId);
  const previousContext = params.threadId ? cloneThreadContext(threadContext) : null;
  const requestModel = readModelSetting(params);
  let requestedModel = requestModel.present ? requestModel.model : threadContext?.model ?? null;
  let provider = providerForModel(requestedModel, state) ??
    threadContext?.provider ?? null;
  let routedCustomPlatform = customPlatformForProvider(provider, state);
  let routedDeepSeekModel = deepSeekRouteModel(requestedModel, routedCustomPlatform);
  if (routedDeepSeekModel) requestedModel = routedDeepSeekModel;

  if (THREAD_METHODS.has(method)) {
    const customPlatform = routedCustomPlatform;
    if (isCustomProvider(provider) && !customPlatform?.enabled) {
      return jsonRpcError(message.id, "该额外模型平台尚未启用或 API Key 为空");
    }
    if (provider) params.modelProvider = provider;
    if (routedDeepSeekModel) {
      params.model = routedDeepSeekModel;
    } else if (!normalizedModel(params.model) && requestedModel) {
      params.model = requestedModel;
    }
    if (customPlatform?.enabled) {
      params.config = customThreadConfig(params.config, state.customModels.get(requestedModel));
    }
  }

  if (TURN_INPUT_METHODS.has(method)) {
    const knownProvider = threadContext?.provider ?? null;
    provider ??= knownProvider;
    routedCustomPlatform = customPlatformForProvider(provider, state);
    routedDeepSeekModel = deepSeekRouteModel(requestedModel, routedCustomPlatform);
    if (routedDeepSeekModel) requestedModel = routedDeepSeekModel;
    if (method === "turn/start" && knownProvider && provider && knownProvider !== provider) {
      return jsonRpcError(message.id, "同一任务不能切换模型供应商；请新建任务后再选择目标模型");
    }
    if (routedDeepSeekModel) {
      params.model = routedDeepSeekModel;
    } else if (!normalizedModel(params.model) && requestedModel) {
      params.model = requestedModel;
    }
    const customPlatform = routedCustomPlatform;
    if (isCustomProvider(provider)) {
      if (!customPlatform?.enabled) {
        return jsonRpcError(message.id, "该额外模型平台尚未启用或 API Key 为空");
      }
      const selectedModel = state.customModels.get(requestedModel ?? threadContext?.model);
      if (containsImageInput(params.input) && !selectedModel?.supportsImage) {
        return jsonRpcError(message.id, "该模型的当前配置未启用图片输入");
      }
      if (method === "turn/start") {
        if (selectedModel?.reasoningEfforts.length) {
          if (params.effort != null && !selectedModel.reasoningEfforts.includes(params.effort)) {
            return jsonRpcError(
              message.id,
              `${selectedModel.displayName} 的推理深度仅支持 ${selectedModel.reasoningEfforts.join("、")}`,
            );
          }
          params.effort ??= selectedModel.defaultReasoningEffort;
        } else {
          delete params.effort;
        }
        delete params.summary;
        delete params.serviceTier;
      }
    }
    if (method === "turn/start" && params.threadId) {
      if (requestModel.present) {
        updateThreadContext(state.threadContexts, params.threadId, {
          model: requestedModel,
          modelPresent: true,
          source: "turn-request",
          revision: requestRevision,
        });
      }
      state.emitUsageEvent({
        type: "thread-active",
        threadId: params.threadId,
        model: requestedModel,
        modelSource: requestModel.present ? "turn-request" : threadContext?.source ?? "thread",
      });
    }
  }

  if (method === "thread/resume" && params.threadId) {
    if (requestModel.present) {
      updateThreadContext(state.threadContexts, params.threadId, {
        model: requestedModel,
        modelPresent: true,
        source: "thread-request",
        revision: requestRevision,
      });
    }
    state.emitUsageEvent({
      type: "thread-active",
      threadId: params.threadId,
      model: requestedModel,
      modelSource: requestModel.present ? "thread-request" : threadContext?.source ?? "thread",
    });
  }

  if (message.id != null && (THREAD_METHODS.has(method) || method === "turn/start")) {
    rememberPendingRequest(state, message.id, {
      method,
      provider,
      threadId: params.threadId,
      model: requestedModel,
      modelSource: requestModel.present
        ? "turn-request"
        : threadContext?.source ?? "thread",
      modelRevision: requestRevision,
      previousContext: requestModel.present ? previousContext : null,
    });
  }
  return JSON.stringify({ ...message, params });
}

export { rewriteClientLine };
