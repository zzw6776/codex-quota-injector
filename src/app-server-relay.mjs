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
const OBSERVED_THREAD_METHODS = new Set([...THREAD_METHODS, "thread/read", "thread/list"]);
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
  pipeLines(process.stdin, child.stdin, (line) => rewriteClientLine(line, {
    deepSeekEnabled,
    officialModels,
    pendingRequests,
    threadProviders,
    threadModels,
    emitUsageEvent: usageEventWriter.write,
  }));
  pipeLines(child.stdout, process.stdout, (line) => rewriteServerLine(line, {
    pendingRequests,
    threadProviders,
    threadModels,
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
  if (!THREAD_METHODS.has(method) && !TURN_INPUT_METHODS.has(method)) {
    if (message.id != null) {
      state.pendingRequests.set(String(message.id), { method, provider: null, threadId: null });
    }
    return line;
  }
  const params = message.params && typeof message.params === "object"
    ? { ...message.params }
    : {};
  const requestedModel = normalizedModel(params.model) ?? state.threadModels.get(params.threadId) ?? null;
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
      if (requestedModel) state.threadModels.set(params.threadId, requestedModel);
      state.emitUsageEvent({
        type: "thread-active",
        threadId: params.threadId,
        model: requestedModel,
      });
    }
  }

  if (method === "thread/resume" && params.threadId) {
    if (requestedModel) state.threadModels.set(params.threadId, requestedModel);
    state.emitUsageEvent({
      type: "thread-active",
      threadId: params.threadId,
      model: requestedModel,
    });
  }

  if (message.id != null && (THREAD_METHODS.has(method) || method === "turn/start")) {
    state.pendingRequests.set(String(message.id), {
      method,
      provider,
      threadId: params.threadId,
      model: requestedModel,
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
  const thread = message?.result?.thread ?? message?.result;
  const threadId = thread?.id ?? pending.threadId;
  const provider = thread?.modelProvider ?? pending.provider;
  const model = normalizedModel(thread?.model) ?? pending.model;
  if (threadId && provider) state.threadProviders.set(threadId, provider);
  if (threadId && model) state.threadModels.set(threadId, model);
  learnThreadProviders(message?.result, state.threadProviders);
  learnThreadModels(message?.result, state.threadModels);
  if (threadId && THREAD_METHODS.has(pending.method)) {
    state.emitUsageEvent({ type: "thread-active", threadId, model });
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
  if (threadId && pending.provider) state.threadProviders.set(threadId, pending.provider);
  if (threadId && pending.model) state.threadModels.set(threadId, pending.model);
  if (threadId && THREAD_METHODS.has(pending.method)) {
    state.emitUsageEvent({ type: "thread-active", threadId, model: pending.model });
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
  const candidates = [
    value,
    value.thread,
    ...(Array.isArray(value.data) ? value.data : []),
  ].filter(Boolean);
  for (const thread of candidates) {
    const model = normalizedModel(thread?.model);
    if (thread?.id && model) threadModels.set(thread.id, model);
  }
}

function captureUsageNotification(message, state) {
  const method = message?.method;
  const params = message?.params;
  if (!params || typeof params !== "object") return;
  if (method === "model/rerouted" && params.threadId) {
    const model = normalizedModel(params.toModel);
    if (model) state.threadModels.set(params.threadId, model);
    return;
  }
  if (method === "thread/tokenUsage/updated" && params.threadId && params.turnId) {
    state.emitUsageEvent({
      type: "usage",
      threadId: params.threadId,
      turnId: params.turnId,
      model: state.threadModels.get(params.threadId) ?? null,
      tokenUsage: params.tokenUsage,
    });
    return;
  }
  if (method === "turn/completed" && params.threadId && params.turn?.id) {
    state.emitUsageEvent({
      type: "turn-completed",
      threadId: params.threadId,
      turnId: params.turn.id,
      model: state.threadModels.get(params.threadId) ?? null,
      status: params.turn.status ?? null,
    });
  }
}

function normalizedModel(value) {
  const model = String(value ?? "").trim();
  return model || null;
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
