#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import deepSeekModel from "./deepseek-model.json" with { type: "json" };
import { RELAY_PROTOCOL_VERSION } from "./relay-contract.mjs";

const DEEPSEEK_MODEL = "deepseek-v4-flash";
const DEEPSEEK_PROVIDER = "deepseek";
const OPENAI_PROVIDER = "openai";
const DEEPSEEK_ENV_KEY = "DEEPSEEK_API_KEY";
const PROVIDER_CONFIG =
  `model_providers.${DEEPSEEK_PROVIDER}={name="DeepSeek",base_url="https://api.deepseek.com/",` +
  `env_key="${DEEPSEEK_ENV_KEY}",wire_api="responses"}`;
const THREAD_METHODS = new Set(["thread/start", "thread/resume", "thread/fork"]);
const THREAD_SETTINGS_METHOD = "thread/settings/update";
const MODEL_LIST_METHOD = "model/list";
const OBSERVED_THREAD_METHODS = new Set([
  ...THREAD_METHODS,
  "thread/read",
  "thread/list",
  THREAD_SETTINGS_METHOD,
]);
const TURN_INPUT_METHODS = new Set(["turn/start", "turn/steer"]);
const ALLOWED_DEEPSEEK_EFFORTS = new Set(["low", "high", "max"]);
const MAX_SERVER_INSPECTION_BYTES = 1024 * 1024;
const PENDING_REQUEST_TTL_MS = 2 * 60 * 1000;
const TURN_MODEL_TTL_MS = 15 * 60 * 1000;
const THREAD_CONTEXT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RELAY_CLEANUP_INTERVAL_MS = 60 * 1000;
const JSON_RPC_ID_RE = /^\s*\{\s*"id"\s*:\s*(?:"([^"\\]*)"|(-?\d+(?:\.\d+)?))/;

export async function runAppServerRelay() {
  const relayConfig = await readJson(process.env.CODEX_QUOTA_RELAY_CONFIG);
  const upstreamExecutable = String(
    relayConfig?.upstreamExecutable ?? process.env.CODEX_QUOTA_UPSTREAM_CODEX_CLI ?? "",
  ).trim();
  if (!upstreamExecutable || upstreamExecutable === process.execPath) {
    throw new Error("模型中继配置缺少有效的官方 Codex CLI 路径，或路径指向了中继自身");
  }

  const originalArgs = process.argv.slice(2);
  const appServerIndex = originalArgs.indexOf("app-server");
  if (appServerIndex < 0) {
    await runPassthrough(upstreamExecutable, originalArgs);
    return;
  }

  const providerSettingsPath = relayConfig?.providerSettingsPath ??
    process.env.CODEX_QUOTA_PROVIDER_SETTINGS;
  const settings = await readJson(providerSettingsPath).catch((error) => {
    console.error(`DeepSeek 本地配置读取失败，已按停用处理: ${error.message}`);
    return null;
  });
  const deepSeekEnabled = Boolean(settings?.enabled && settings?.apiKey);
  const catalogPath = String(
    relayConfig?.modelCatalogPath ?? process.env.CODEX_QUOTA_MODEL_CATALOG ?? "",
  ).trim();
  const officialModels = await readOfficialModelSlugs(catalogPath);
  officialModels.delete(DEEPSEEK_MODEL);

  const args = [...originalArgs];
  if (deepSeekEnabled) args.splice(appServerIndex, 0, "-c", PROVIDER_CONFIG);
  if (catalogPath) {
    args.splice(appServerIndex, 0, "-c", `model_catalog_json=${JSON.stringify(catalogPath)}`);
  }

  const env = { ...process.env, CODEX_CLI_PATH: upstreamExecutable };
  if (deepSeekEnabled) env[DEEPSEEK_ENV_KEY] = settings.apiKey;
  else delete env[DEEPSEEK_ENV_KEY];
  clearRelayEnvironment(env);
  delete env.CODEX_APP_SERVER_FORCE_CLI;
  delete env.CODEX_APP_SERVER_WS_URL;
  env.CODEX_CLI_PATH = upstreamExecutable;

  const child = spawn(upstreamExecutable, args, {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: process.platform === "win32",
  });
  const statePath = String(
    relayConfig?.relayStatePath ?? process.env.CODEX_QUOTA_RELAY_STATE ?? "",
  ).trim();
  const usageEventWriter = createUsageEventWriter(
    String(
      relayConfig?.tokenUsageEventsPath ?? process.env.CODEX_QUOTA_TOKEN_USAGE_EVENTS ?? "",
    ).trim(),
  );
  await writeRelayState(
    statePath,
    relayConfig?.generation ?? process.env.CODEX_QUOTA_BRIDGE_GENERATION ?? null,
  );
  let relayCleanupTimer = null;
  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (relayCleanupTimer) clearInterval(relayCleanupTimer);
    relayCleanupTimer = null;
    await Promise.all([removeRelayState(statePath), usageEventWriter.close()]);
  };
  forwardSignals(child);
  child.once("error", (error) => fail(error));
  child.once("exit", (code, signal) => {
    void cleanup().finally(() => exitLikeChild(code, signal));
  });
  process.once("exit", () => void cleanup());

  const pendingRequests = new Map();
  const threadContexts = new Map();
  const turnModels = new Map();
  const relayState = {
    deepSeekEnabled,
    officialModels,
    pendingRequests,
    threadContexts,
    turnModels,
    modelRevision: 0,
    modelListStatus: null,
    emitUsageEvent: usageEventWriter.write,
  };
  relayCleanupTimer = setInterval(() => pruneRelayState(relayState), RELAY_CLEANUP_INTERVAL_MS);
  relayCleanupTimer.unref?.();
  pipeLines(process.stdin, child.stdin, (line) => rewriteClientLine(line, relayState));
  pipeLines(child.stdout, process.stdout, (line) => rewriteServerLine(line, relayState));
  pipeRaw(child.stderr, process.stderr);
}

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
  const requestedModel = requestModel.present ? requestModel.model : threadContext?.model ?? null;
  let provider = providerForModel(requestedModel, state.officialModels) ??
    threadContext?.provider ?? null;

  if (THREAD_METHODS.has(method)) {
    if (provider === DEEPSEEK_PROVIDER && !state.deepSeekEnabled) {
      return jsonRpcError(message.id, "DeepSeek 尚未启用或 API Key 为空");
    }
    if (provider) params.modelProvider = provider;
    if (provider === DEEPSEEK_PROVIDER) params.config = deepSeekThreadConfig(params.config);
  }

  if (TURN_INPUT_METHODS.has(method)) {
    const knownProvider = threadContext?.provider ?? null;
    provider ??= knownProvider;
    if (method === "turn/start" && knownProvider && provider && knownProvider !== provider) {
      return jsonRpcError(message.id, "同一任务不能切换模型供应商；请新建任务后再选择目标模型");
    }
    if (provider === DEEPSEEK_PROVIDER) {
      if (!state.deepSeekEnabled) {
        return jsonRpcError(message.id, "DeepSeek 尚未启用或 API Key 为空");
      }
      if (method === "turn/start" &&
        params.effort != null && !ALLOWED_DEEPSEEK_EFFORTS.has(params.effort)) {
        return jsonRpcError(message.id, "DeepSeek V4 Flash 的推理深度仅支持 low、high、max");
      }
      if (containsImageInput(params.input)) {
        return jsonRpcError(message.id, "DeepSeek Responses API 当前不支持图片输入");
      }
      if (method === "turn/start") {
        params.summary = "none";
        params.serviceTier = null;
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

function rewriteServerLine(line, state) {
  if (line.length > MAX_SERVER_INSPECTION_BYTES) {
    completeLargeResponse(line, state);
    return line;
  }
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return line;
  }
  learnThreadContexts(message?.params, state, {
    source: "thread-discovery",
    revision: 0,
  });
  captureUsageNotification(message, state);
  if (message?.id == null) return line;
  const pending = state.pendingRequests.get(String(message.id));
  if (!pending) return line;
  state.pendingRequests.delete(String(message.id));
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
  const provider = normalizedModel(result?.modelProvider) ??
    normalizedModel(thread?.modelProvider) ?? pending.provider;
  // thread/start, thread/resume and thread/fork return the selected model at
  // the response envelope level, while the nested Thread object does not.
  const responseModel = normalizedModel(result?.model) ?? normalizedModel(thread?.model);
  const model = responseModel ?? pending.model;
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

function rewriteModelListResponse(line, message, state, pending) {
  const models = message?.result?.data;
  if (!Array.isArray(models)) {
    reportModelListStatus(state, "invalid", "model/list 返回格式无法识别，未修改响应");
    return line;
  }

  const hasDeepSeek = models.some((model) =>
    normalizedModel(model?.id) === DEEPSEEK_MODEL ||
    normalizedModel(model?.model) === DEEPSEEK_MODEL
  );
  if (!state.deepSeekEnabled) {
    reportModelListStatus(state, "disabled", "DeepSeek 未启用，不向模型列表补充选项");
    return line;
  }
  if (hasDeepSeek) {
    reportModelListStatus(state, "present", "DeepSeek 模型选项已由官方 app-server 返回");
    return line;
  }
  if (pending.cursor != null && String(pending.cursor).trim()) return line;

  reportModelListStatus(state, "injected", "model/list 缺少 DeepSeek，已在首屏响应中补齐");
  return JSON.stringify({
    ...message,
    result: {
      ...message.result,
      data: [...models, createDeepSeekAppServerModel()],
    },
  });
}

function createDeepSeekAppServerModel() {
  const reasoningLevels = Array.isArray(deepSeekModel.supported_reasoning_levels)
    ? deepSeekModel.supported_reasoning_levels
    : [];
  const inputModalities = Array.isArray(deepSeekModel.input_modalities)
    ? deepSeekModel.input_modalities.filter((value) => ["text", "image", "audio"].includes(value))
    : [];
  return {
    id: deepSeekModel.slug,
    model: deepSeekModel.slug,
    upgrade: deepSeekModel.upgrade ?? null,
    upgradeInfo: null,
    availabilityNux: deepSeekModel.availability_nux ?? null,
    displayName: deepSeekModel.display_name,
    description: deepSeekModel.description,
    hidden: deepSeekModel.visibility === "hide",
    supportedReasoningEfforts: reasoningLevels.map((level) => ({
      reasoningEffort: level.effort,
      description: level.description,
    })),
    defaultReasoningEffort: deepSeekModel.default_reasoning_level ??
      reasoningLevels[0]?.effort ?? "high",
    inputModalities,
    supportsPersonality: Object.keys(
      deepSeekModel.model_messages?.instructions_variables ?? {},
    ).some((key) => key.startsWith("personality_")),
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: deepSeekModel.default_service_tier ?? null,
    isDefault: false,
  };
}

function reportModelListStatus(state, status, message) {
  if (state.modelListStatus === status) return;
  state.modelListStatus = status;
  console.error(`[codex-quota-relay] ${message}`);
}

function completeLargeResponse(line, state) {
  const match = line.match(JSON_RPC_ID_RE);
  if (!match) return;
  const requestId = match[1] ?? match[2];
  const pending = state.pendingRequests.get(requestId);
  if (!pending) return;
  state.pendingRequests.delete(requestId);
  const resultIndex = line.indexOf('"result"');
  const errorIndex = line.indexOf('"error"');
  if (errorIndex >= 0 && (resultIndex < 0 || errorIndex < resultIndex)) {
    restoreThreadContext(
      state.threadContexts,
      pending.threadId,
      pending.previousContext,
      pending.modelRevision,
    );
    return;
  }
  const threadId = extractResponseThreadId(line) ?? pending.threadId;
  const provider = extractResponseStringField(line, "modelProvider") ?? pending.provider;
  const responseModel = extractResponseStringField(line, "model");
  const model = responseModel ?? pending.model;
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
  const turnId = extractResponseTurnId(line);
  const resolvedTurnModel = model;
  if (pending.method === "turn/start" && turnId && resolvedTurnModel) {
    rememberTurnModel(state, turnId, {
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
}

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
    const provider = normalizedModel(thread?.modelProvider);
    const threadId = thread?.id ?? thread?.threadId;
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

function captureUsageNotification(message, state) {
  const method = message?.method;
  const params = message?.params;
  if (!params || typeof params !== "object") return;
  const configuredModel = readModelSetting(params.threadSettings ?? params);
  if (method === "thread/settings/updated" && params.threadId && configuredModel.present) {
    updateThreadContext(state.threadContexts, params.threadId, {
      model: configuredModel.model,
      modelPresent: true,
      source: "thread-settings",
      revision: nextModelRevision(state),
    });
    return;
  }
  if (method === "turn/started" && params.threadId && params.turn?.id) {
    const turnId = String(params.turn.id);
    const resolved = resolveTurnModel(state, params.threadId, turnId, params);
    const model = resolved.model;
    const source = resolved.explicit ? "turn-started" : resolved.source;
    if (model) rememberTurnModel(state, turnId, { model, source });
    state.emitUsageEvent({
      type: "turn-started",
      threadId: params.threadId,
      turnId,
      model,
      modelSource: source,
    });
    return;
  }
  if (method === "model/rerouted" && params.threadId) {
    const model = normalizedModel(params.toModel);
    const turnId = params.turnId ?? params.turn?.id;
    if (model && turnId) {
      rememberTurnModel(state, turnId, { model, source: "rerouted" });
    }
    return;
  }
  if (method === "thread/tokenUsage/updated" && params.threadId && params.turnId) {
    const resolved = resolveTurnModel(state, params.threadId, params.turnId, params);
    state.emitUsageEvent({
      type: "usage",
      threadId: params.threadId,
      turnId: params.turnId,
      model: resolved.model,
      modelSource: resolved.explicit ? "usage" : resolved.source,
      tokenUsage: params.tokenUsage,
    });
    return;
  }
  if (method === "turn/completed" && params.threadId && params.turn?.id) {
    const turnId = String(params.turn.id);
    const resolved = resolveTurnModel(state, params.threadId, turnId, params);
    state.emitUsageEvent({
      type: "turn-completed",
      threadId: params.threadId,
      turnId,
      model: resolved.model,
      modelSource: resolved.explicit ? "completed" : resolved.source,
      status: params.turn.status ?? null,
    });
    state.turnModels.delete(turnId);
    return;
  }
  if (method === "turn/aborted" && params.threadId) {
    const turnId = params.turnId ?? params.turn?.id;
    if (!turnId) return;
    const resolved = resolveTurnModel(state, params.threadId, turnId, params);
    state.emitUsageEvent({
      type: "turn-completed",
      threadId: params.threadId,
      turnId: String(turnId),
      model: resolved.model,
      modelSource: resolved.explicit ? "completed" : resolved.source,
      status: params.reason === "interrupted" ? "interrupted" : "failed",
    });
    state.turnModels.delete(String(turnId));
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
  state.pendingRequests.set(String(requestId), {
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

function normalizedModel(value) {
  const model = String(value ?? "").trim();
  return model || null;
}

function extractResponseStringField(line, field) {
  const resultIndex = line.indexOf('"result"');
  if (resultIndex < 0) return null;
  const escapedField = String(field).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = line.slice(resultIndex).match(
    new RegExp(`"${escapedField}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`),
  );
  if (!match) return null;
  try {
    return normalizedModel(JSON.parse(`"${match[1]}"`));
  } catch {
    return null;
  }
}

function extractResponseTurnId(line) {
  const resultIndex = line.indexOf('"result"');
  if (resultIndex < 0) return null;
  const turnIndex = line.indexOf('"turn"', resultIndex);
  if (turnIndex < 0) return null;
  const match = line.slice(turnIndex).match(/"id"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (!match) return null;
  try {
    return normalizedModel(JSON.parse(`"${match[1]}"`));
  } catch {
    return null;
  }
}

function extractResponseThreadId(line) {
  const resultIndex = line.indexOf('"result"');
  if (resultIndex < 0) return null;
  const threadIndex = line.indexOf('"thread"', resultIndex);
  if (threadIndex < 0) return null;
  const match = line.slice(threadIndex).match(/"id"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (!match) return null;
  try {
    return normalizedModel(JSON.parse(`"${match[1]}"`));
  } catch {
    return null;
  }
}

function providerForModel(model, officialModels) {
  if (model === DEEPSEEK_MODEL) return DEEPSEEK_PROVIDER;
  if (typeof model === "string" && officialModels.has(model)) return OPENAI_PROVIDER;
  return null;
}

function deepSeekThreadConfig(config) {
  return {
    ...(config && typeof config === "object" ? config : {}),
    model_reasoning_summary: "none",
    service_tier: null,
  };
}

function containsImageInput(value) {
  if (Array.isArray(value)) return value.some(containsImageInput);
  if (!value || typeof value !== "object") return false;
  if (["image", "localImage", "input_image", "image_url"].includes(value.type)) return true;
  return Object.values(value).some(containsImageInput);
}

function jsonRpcError(id, message) {
  if (id == null) return "";
  return {
    directOutput: JSON.stringify({
      id,
      error: { code: -32602, message },
    }),
  };
}

function pipeLines(input, output, transform) {
  input.setEncoding("utf8");
  let pending = "";
  input.on("data", (chunk) => {
    pending += chunk;
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const line = pending.slice(0, newline).replace(/\r$/, "");
      pending = pending.slice(newline + 1);
      const transformed = transform(line);
      if (transformed && typeof transformed === "object" && "directOutput" in transformed) {
        writeWithBackpressure(process.stdout, `${transformed.directOutput}\n`, input);
      } else if (transformed !== "") {
        writeWithBackpressure(output, `${transformed}\n`, input);
      }
    }
  });
  input.once("end", () => {
    if (pending) {
      const transformed = transform(pending.replace(/\r$/, ""));
      if (transformed && typeof transformed === "object" && "directOutput" in transformed) {
        writeWithBackpressure(process.stdout, transformed.directOutput, input);
      } else if (transformed !== "") {
        output.write(transformed);
      }
    }
    output.end();
  });
  input.once("error", (error) => {
    if (error.code !== "EPIPE") fail(error);
  });
  output.once("error", (error) => {
    if (error.code !== "EPIPE") fail(error);
  });
}

function pipeRaw(input, output) {
  input.on("data", (chunk) => writeWithBackpressure(output, chunk, input));
}

function writeWithBackpressure(output, chunk, input) {
  if (output.write(chunk)) return;
  input.pause();
  output.once("drain", () => input.resume());
}

async function runPassthrough(upstreamExecutable, args) {
  const env = { ...process.env, CODEX_CLI_PATH: upstreamExecutable };
  clearRelayEnvironment(env);
  delete env.CODEX_APP_SERVER_FORCE_CLI;
  delete env.CODEX_APP_SERVER_WS_URL;
  env.CODEX_CLI_PATH = upstreamExecutable;
  const child = spawn(upstreamExecutable, args, {
    env,
    stdio: "inherit",
    windowsHide: process.platform === "win32",
  });
  forwardSignals(child);
  child.once("error", fail);
  child.once("exit", (code, signal) => exitLikeChild(code, signal));
}

async function readOfficialModelSlugs(path) {
  const catalog = await readJson(path);
  return new Set(Array.isArray(catalog?.models)
    ? catalog.models.map((model) => model?.slug).filter(Boolean)
    : []);
}

async function readJson(path) {
  if (!path) return null;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeRelayState(path, generation) {
  if (!path) return;
  const resolvedGeneration = generation ??
    process.env.CODEX_QUOTA_BRIDGE_GENERATION ??
    `usage-events-v${RELAY_PROTOCOL_VERSION}`;
  const processStartedAt = Math.max(
    0,
    Math.floor(Date.now() - process.uptime() * 1000),
  );
  await writeFile(path, `${JSON.stringify({
    pid: process.pid,
    generation: resolvedGeneration,
    processStartedAt,
    startedAt: Date.now(),
  })}\n`, { encoding: "utf8", mode: 0o600 });
}

function clearRelayEnvironment(env) {
  for (const key of [
    "CODEX_QUOTA_RELAY_CONFIG",
    "CODEX_QUOTA_ROLE",
    "CODEX_QUOTA_UPSTREAM_CODEX_CLI",
    "CODEX_QUOTA_PROVIDER_SETTINGS",
    "CODEX_QUOTA_MODEL_CATALOG",
    "CODEX_QUOTA_RELAY_STATE",
    "CODEX_QUOTA_TOKEN_USAGE_EVENTS",
    "CODEX_QUOTA_BRIDGE_GENERATION",
  ]) {
    delete env[key];
  }
}

async function removeRelayState(path) {
  if (!path) return;
  try {
    const state = JSON.parse(await readFile(path, "utf8"));
    if (state?.pid === process.pid) await unlink(path);
  } catch (error) {
    if (error.code !== "ENOENT") console.error(`清理模型中继状态失败: ${error.message}`);
  }
}

function forwardSignals(child) {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      if (!child.killed) child.kill(signal);
    });
  }
}

function exitLikeChild(code, signal) {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
}

function fail(error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function createUsageEventWriter(path) {
  const sessionId = randomUUID();
  let sequence = 0;
  let buffer = [];
  let flushTimer = null;
  let closed = false;
  let tail = Promise.resolve();
  const directoryReady = path
    ? mkdir(dirname(path), { recursive: true, mode: 0o700 })
    : Promise.resolve();
  const flush = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!path || buffer.length === 0) return tail;
    const batch = buffer;
    buffer = [];
    const content = `${batch.map((payload) => JSON.stringify(payload)).join("\n")}\n`;
    tail = tail
      .then(async () => {
        await directoryReady;
        await appendFile(path, content, { encoding: "utf8", mode: 0o600 });
      })
      .catch((error) => {
        console.error(`记录 Token 用量事件失败: ${error.message}`);
      });
    return tail;
  };
  const write = (event) => {
    if (closed || !path || !event?.type) return;
    const payload = {
      ...event,
      eventId: `${sessionId}:${++sequence}`,
      recordedAt: Date.now(),
    };
    buffer.push(payload);
    if (buffer.length >= 32) {
      void flush();
    } else if (!flushTimer) {
      flushTimer = setTimeout(() => void flush(), 25);
    }
  };
  return {
    write,
    close: async () => {
      closed = true;
      await flush();
      await tail;
    },
  };
}
