#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const DEEPSEEK_MODEL = "deepseek-v4-flash";
const DEEPSEEK_PROVIDER = "deepseek";
const OPENAI_PROVIDER = "openai";
const DEEPSEEK_ENV_KEY = "DEEPSEEK_API_KEY";
const PROVIDER_CONFIG =
  `model_providers.${DEEPSEEK_PROVIDER}={name="DeepSeek",base_url="https://api.deepseek.com/",` +
  `env_key="${DEEPSEEK_ENV_KEY}",wire_api="responses"}`;
const THREAD_METHODS = new Set(["thread/start", "thread/resume", "thread/fork"]);
const THREAD_SETTINGS_METHOD = "thread/settings/update";
const OBSERVED_THREAD_METHODS = new Set([
  ...THREAD_METHODS,
  "thread/read",
  "thread/list",
  THREAD_SETTINGS_METHOD,
]);
const TURN_INPUT_METHODS = new Set(["turn/start", "turn/steer"]);
const ALLOWED_DEEPSEEK_EFFORTS = new Set(["low", "high", "max"]);
const MAX_SERVER_INSPECTION_BYTES = 1024 * 1024;
const JSON_RPC_ID_RE = /^\s*\{\s*"id"\s*:\s*(?:"([^"\\]*)"|(-?\d+(?:\.\d+)?))/;

export async function runAppServerRelay() {
  const upstreamExecutable = String(process.env.CODEX_QUOTA_UPSTREAM_CODEX_CLI ?? "").trim();
  if (!upstreamExecutable || upstreamExecutable === process.execPath) {
    throw new Error("CODEX_QUOTA_UPSTREAM_CODEX_CLI 未配置或指向了中继自身");
  }

  const originalArgs = process.argv.slice(2);
  const appServerIndex = originalArgs.indexOf("app-server");
  if (appServerIndex < 0) {
    await runPassthrough(upstreamExecutable, originalArgs);
    return;
  }

  const settings = await readJson(process.env.CODEX_QUOTA_PROVIDER_SETTINGS).catch((error) => {
    console.error(`DeepSeek 本地配置读取失败，已按停用处理: ${error.message}`);
    return null;
  });
  const deepSeekEnabled = Boolean(settings?.enabled && settings?.apiKey);
  const catalogPath = String(process.env.CODEX_QUOTA_MODEL_CATALOG ?? "").trim();
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
  delete env.CODEX_APP_SERVER_FORCE_CLI;
  delete env.CODEX_APP_SERVER_WS_URL;
  delete env.CODEX_QUOTA_ROLE;

  const child = spawn(upstreamExecutable, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  const statePath = String(process.env.CODEX_QUOTA_RELAY_STATE ?? "").trim();
  const usageEventWriter = createUsageEventWriter(
    String(process.env.CODEX_QUOTA_TOKEN_USAGE_EVENTS ?? "").trim(),
  );
  await writeRelayState(statePath);
  const cleanup = () => Promise.all([removeRelayState(statePath), usageEventWriter.close()]);
  forwardSignals(child);
  child.once("error", (error) => fail(error));
  child.once("exit", (code, signal) => {
    void cleanup().finally(() => exitLikeChild(code, signal));
  });
  process.once("exit", () => void cleanup());

  const pendingRequests = new Map();
  const threadProviders = new Map();
  const threadModels = new Map();
  const turnModels = new Map();
  pipeLines(process.stdin, child.stdin, (line) => rewriteClientLine(line, {
    deepSeekEnabled,
    officialModels,
    pendingRequests,
    threadProviders,
    threadModels,
    turnModels,
    emitUsageEvent: usageEventWriter.write,
  }));
  pipeLines(child.stdout, process.stdout, (line) => rewriteServerLine(line, {
    pendingRequests,
    threadProviders,
    threadModels,
    turnModels,
    emitUsageEvent: usageEventWriter.write,
  }));
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
  if (!OBSERVED_THREAD_METHODS.has(method) && !TURN_INPUT_METHODS.has(method)) return line;
  const params = message.params && typeof message.params === "object"
    ? { ...message.params }
    : {};

  if (method === THREAD_SETTINGS_METHOD) {
    const configuredModel = readModelSetting(params);
    if (params.threadId && configuredModel.present) {
      updateThreadModel(state.threadModels, params.threadId, configuredModel.model, "thread-settings");
    }
    return JSON.stringify({ ...message, params });
  }

  if (!THREAD_METHODS.has(method) && !TURN_INPUT_METHODS.has(method)) {
    if (message.id != null) {
      state.pendingRequests.set(String(message.id), { method, provider: null, threadId: null });
    }
    return line;
  }
  const threadModel = getThreadModel(state.threadModels, params.threadId);
  const requestModel = readModelSetting(params);
  const requestedModel = requestModel.present ? requestModel.model : threadModel?.model ?? null;
  let provider = providerForModel(requestedModel, state.officialModels) ??
    state.threadProviders.get(params.threadId) ?? null;

  if (THREAD_METHODS.has(method)) {
    if (provider === DEEPSEEK_PROVIDER && !state.deepSeekEnabled) {
      return jsonRpcError(message.id, "DeepSeek 尚未启用或 API Key 为空");
    }
    if (provider) params.modelProvider = provider;
    if (provider === DEEPSEEK_PROVIDER) params.config = deepSeekThreadConfig(params.config);
  }

  if (TURN_INPUT_METHODS.has(method)) {
    const knownProvider = state.threadProviders.get(params.threadId);
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
      if (requestedModel && requestModel.present) {
        updateThreadModel(state.threadModels, params.threadId, requestedModel, "turn-request");
      }
      state.emitUsageEvent({
        type: "thread-active",
        threadId: params.threadId,
        model: requestedModel,
        modelSource: requestModel.present ? "turn-request" : threadModel?.source ?? "thread",
      });
    }
  }

  if (method === "thread/resume" && params.threadId) {
    if (requestedModel && requestModel.present) {
      updateThreadModel(state.threadModels, params.threadId, requestedModel, "thread-request");
    }
    state.emitUsageEvent({
      type: "thread-active",
      threadId: params.threadId,
      model: requestedModel,
      modelSource: requestModel.present ? "thread-request" : threadModel?.source ?? "thread",
    });
  }

  if (message.id != null && (THREAD_METHODS.has(method) || method === "turn/start")) {
    state.pendingRequests.set(String(message.id), {
      method,
      provider,
      threadId: params.threadId,
      model: requestedModel,
      modelSource: requestModel.present
        ? "turn-request"
        : threadModel?.source ?? "thread",
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
  learnThreadProviders(message?.params, state.threadProviders);
  learnThreadModels(message?.params, state.threadModels);
  captureUsageNotification(message, state);
  if (message?.id == null) return line;
  const pending = state.pendingRequests.get(String(message.id));
  if (!pending) return line;
  state.pendingRequests.delete(String(message.id));
  const result = message?.result;
  const thread = result?.thread ?? result;
  const threadId = thread?.id ?? pending.threadId;
  const provider = normalizedModel(result?.modelProvider) ??
    normalizedModel(thread?.modelProvider) ?? pending.provider;
  // thread/start, thread/resume and thread/fork return the selected model at
  // the response envelope level, while the nested Thread object does not.
  const model = normalizedModel(result?.model) ??
    normalizedModel(thread?.model) ?? pending.model;
  if (threadId && provider) state.threadProviders.set(threadId, provider);
  if (threadId && model) updateThreadModel(state.threadModels, threadId, model, "thread-response");
  learnThreadProviders(message?.result, state.threadProviders);
  learnThreadModels(message?.result, state.threadModels);
  if (pending.method === "turn/start" && result?.turn?.id && pending.model) {
    state.turnModels.set(String(result.turn.id), {
      model: pending.model,
      source: pending.modelSource ?? "thread",
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

function completeLargeResponse(line, state) {
  const match = line.match(JSON_RPC_ID_RE);
  if (!match) return;
  const requestId = match[1] ?? match[2];
  const pending = state.pendingRequests.get(requestId);
  if (!pending) return;
  state.pendingRequests.delete(requestId);
  const threadId = pending.threadId;
  const provider = extractResponseStringField(line, "modelProvider") ?? pending.provider;
  const model = extractResponseStringField(line, "model") ?? pending.model;
  if (threadId && provider) state.threadProviders.set(threadId, provider);
  if (threadId && model) updateThreadModel(state.threadModels, threadId, model, "thread-response");
  if (threadId && THREAD_METHODS.has(pending.method)) {
    state.emitUsageEvent({
      type: "thread-active",
      threadId,
      model,
      modelSource: "thread-response",
    });
  }
}

function learnThreadProviders(value, threadProviders) {
  if (!value || typeof value !== "object") return;
  const candidates = [
    value,
    value.thread,
    ...(Array.isArray(value.data) ? value.data : []),
  ].filter(Boolean);
  for (const thread of candidates) {
    if (thread?.id && thread?.modelProvider) {
      threadProviders.set(thread.id, thread.modelProvider);
    }
  }
}

function learnThreadModels(value, threadModels) {
  if (!value || typeof value !== "object") return;
  const configuredModel = readModelSetting(value.threadSettings);
  if (value.threadId && configuredModel.present) {
    updateThreadModel(threadModels, value.threadId, configuredModel.model, "thread-settings");
  }
  const envelopeModel = normalizedModel(value.model);
  const envelopeThreadId = value.thread?.id ?? value.threadId;
  if (envelopeModel && envelopeThreadId) {
    updateThreadModel(threadModels, envelopeThreadId, envelopeModel, "thread-response");
  }
  const candidates = [
    value,
    value.thread,
    ...(Array.isArray(value.data) ? value.data : []),
  ].filter(Boolean);
  for (const thread of candidates) {
    const model = normalizedModel(thread?.model);
    if (thread?.id && model) updateThreadModel(threadModels, thread.id, model, "thread-response");
  }
}

function captureUsageNotification(message, state) {
  const method = message?.method;
  const params = message?.params;
  if (!params || typeof params !== "object") return;
  const configuredModel = readModelSetting(params.threadSettings);
  if (method === "thread/settings/updated" && params.threadId && configuredModel.present) {
    updateThreadModel(state.threadModels, params.threadId, configuredModel.model, "thread-settings");
    return;
  }
  if (method === "turn/started" && params.threadId && params.turn?.id) {
    const tracked = state.turnModels.get(String(params.turn.id));
    const threadModel = getThreadModel(state.threadModels, params.threadId);
    const explicitModel = normalizedModel(params.model) ?? normalizedModel(params.turn.model);
    const model = explicitModel ?? tracked?.model ?? threadModel?.model ?? null;
    const source = explicitModel
      ? "turn-started"
      : tracked?.source ?? threadModel?.source ?? "thread";
    if (model) state.turnModels.set(String(params.turn.id), { model, source });
    return;
  }
  if (method === "model/rerouted" && params.threadId) {
    const model = normalizedModel(params.toModel);
    if (model && params.turnId) {
      state.turnModels.set(String(params.turnId), { model, source: "rerouted" });
    }
    return;
  }
  if (method === "thread/tokenUsage/updated" && params.threadId && params.turnId) {
    const tracked = state.turnModels.get(String(params.turnId));
    const threadModel = getThreadModel(state.threadModels, params.threadId);
    const explicitModel = normalizedModel(params.model) ?? normalizedModel(params.turn?.model);
    const model = explicitModel ?? tracked?.model ?? threadModel?.model ?? null;
    state.emitUsageEvent({
      type: "usage",
      threadId: params.threadId,
      turnId: params.turnId,
      model,
      modelSource: explicitModel ? "usage" : tracked?.source ?? threadModel?.source ?? "thread",
      tokenUsage: params.tokenUsage,
    });
    return;
  }
  if (method === "turn/completed" && params.threadId && params.turn?.id) {
    const turnId = String(params.turn.id);
    const tracked = state.turnModels.get(turnId);
    const threadModel = getThreadModel(state.threadModels, params.threadId);
    const explicitModel = normalizedModel(params.model) ?? normalizedModel(params.turn.model);
    const model = explicitModel ?? tracked?.model ?? threadModel?.model ?? null;
    state.emitUsageEvent({
      type: "turn-completed",
      threadId: params.threadId,
      turnId,
      model,
      modelSource: explicitModel ? "completed" : tracked?.source ?? threadModel?.source ?? "thread",
      status: params.turn.status ?? null,
    });
    state.turnModels.delete(turnId);
  }
}

function readModelSetting(value) {
  if (!value || typeof value !== "object") return { present: false, model: null };
  if (Object.prototype.hasOwnProperty.call(value, "model")) {
    return { present: true, model: normalizedModel(value.model) };
  }
  const collaborationSettings = value.collaborationMode?.settings;
  if (collaborationSettings &&
    Object.prototype.hasOwnProperty.call(collaborationSettings, "model")) {
    return { present: true, model: normalizedModel(collaborationSettings.model) };
  }
  return { present: false, model: null };
}

function getThreadModel(threadModels, threadId) {
  if (!threadId) return null;
  const value = threadModels.get(String(threadId));
  if (!value) return null;
  return typeof value === "string" ? { model: value, source: "thread" } : value;
}

function updateThreadModel(threadModels, threadId, model, source) {
  if (!threadId) return;
  const key = String(threadId);
  if (model == null) {
    threadModels.delete(key);
    return;
  }
  const normalized = normalizedModel(model);
  if (!normalized) return;
  const current = getThreadModel(threadModels, key);
  // A stale thread/read or thread/start response must not overwrite a newer
  // settings/request update. Settings and explicit requests are ordered by
  // arrival, so they are always allowed to replace the thread default.
  if (source === "thread-response" && current && current.source !== "thread-response") return;
  threadModels.set(key, { model: normalized, source });
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
  delete env.CODEX_APP_SERVER_FORCE_CLI;
  delete env.CODEX_QUOTA_ROLE;
  const child = spawn(upstreamExecutable, args, { env, stdio: "inherit" });
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

async function writeRelayState(path) {
  if (!path) return;
  await writeFile(path, `${JSON.stringify({
    pid: process.pid,
    generation: process.env.CODEX_QUOTA_BRIDGE_GENERATION ?? null,
    startedAt: Date.now(),
  })}\n`, { encoding: "utf8", mode: 0o600 });
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
  let tail = Promise.resolve();
  const write = (event) => {
    if (!path || !event?.type) return;
    const payload = {
      ...event,
      eventId: `${sessionId}:${++sequence}`,
      recordedAt: Date.now(),
    };
    tail = tail
      .then(async () => {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await appendFile(path, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
      })
      .catch((error) => {
        console.error(`记录 Token 用量事件失败: ${error.message}`);
      });
  };
  return {
    write,
    close: () => tail,
  };
}
