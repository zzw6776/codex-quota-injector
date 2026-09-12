import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { gunzipSync, zstdDecompressSync } from "node:zlib";
import { WebSocketServer } from "ws";
import { ModelRouterManager } from "../../src/model-router.mjs";
import { ExtraModelManager } from "../../src/extra-model-manager.mjs";
import deepSeekModel from "../../src/deepseek-model.json" with { type: "json" };

const execFileAsync = promisify(execFile);
export const LOOPBACK_SANDBOX = '(version 1)(allow default)(deny network*)(allow network-outbound (remote ip "localhost:*"))(allow network-inbound (local ip "localhost:*"))(allow network-bind (local ip "localhost:*"))(allow network* (local unix-socket) (remote unix-socket))';
export const ROOT = resolve(import.meta.dirname, "../..");

export async function officialExecutable() {
  const candidates = [process.env.CODEX_TEST_CLI,
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex"].filter(Boolean);
  for (const path of candidates) {
    try { await access(path); return path; } catch {}
  }
  if (process.platform === "win32") {
    try {
      return await import("../../src/platform.mjs")
        .then(({ resolveCodexCliExecutable }) => resolveCodexCliExecutable());
    } catch (error) {
      throw new Error(`BLOCKED: 未找到 Windows 官方 Codex CLI：${error.message}`);
    }
  }
  throw new Error("BLOCKED: 未找到官方 Codex CLI；用 CODEX_TEST_CLI 指定本平台可执行文件");
}

export function isolatedEnv(directory, overrides = {}) {
  if (process.platform === "win32") {
    return {
      PATH: process.env.PATH ?? "",
      PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
      SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
      windir: process.env.windir ?? process.env.SystemRoot ?? "C:\\Windows",
      ComSpec: process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
      HOME: directory,
      USERPROFILE: directory,
      APPDATA: join(directory, "appdata"),
      LOCALAPPDATA: join(directory, "localappdata"),
      TEMP: directory,
      TMP: directory,
      CODEX_HOME: join(directory, "codex-home"),
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_CACHE_HOME: join(directory, "cache"),
      LANG: "en_US.UTF-8",
      ...overrides,
    };
  }
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: directory,
    TMPDIR: directory, CODEX_HOME: join(directory, "codex-home"),
    XDG_CONFIG_HOME: join(directory, "config"), XDG_CACHE_HOME: join(directory, "cache"),
    LANG: "en_US.UTF-8", ...overrides };
}

export function sandboxCommand(executable, args = []) {
  if (process.platform === "win32") {
    return { executable, args };
  }
  if (process.platform !== "darwin") {
    throw new Error("BLOCKED: 当前免费官方运行时适配器只验证 macOS；此平台需实现并验证出站隔离后才能运行");
  }
  return { executable: "/usr/bin/sandbox-exec", args: ["-p", LOOPBACK_SANDBOX, executable, ...args] };
}

export async function activateOfflineNetworkIsolation(executables) {
  if (process.platform === "darwin") {
    return { mode: "macos-seatbelt-loopback-only", close: async () => undefined };
  }
  if (process.platform === "win32") {
    return { mode: "windows-temporary-profile-local-endpoints", close: async () => undefined };
  }
  if (process.platform !== "win32") {
    throw new Error(`BLOCKED: 当前平台 ${process.platform}/${process.arch} 没有免费出站隔离适配器`);
  }
}

export async function execOffline(executable, args, { directory, ...options }) {
  const command = sandboxCommand(executable, args);
  return execFileAsync(command.executable, command.args, {
    env: isolatedEnv(directory), cwd: directory, encoding: "utf8",
    timeout: 15_000, maxBuffer: 16 * 1024 * 1024, ...options,
  });
}

export async function stopChild(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  const exited = once(child, "exit").catch(() => undefined);
  child.stdin?.end();
  child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 2_000);
  try { await exited; } finally { clearTimeout(timeout); }
}

export function message(text, phase = "final_answer") {
  return { type: "message", id: `msg_${randomUUID()}`, role: "assistant", phase,
    content: [{ type: "output_text", text, annotations: [] }] };
}

export function reasoning(text) {
  return { type: "reasoning", id: `rs_${randomUUID()}`, status: "completed",
    content: [{ type: "reasoning_text", text }], summary: [] };
}

export function call(name, args, id = `call_${randomUUID()}`) {
  return { type: "function_call", id: `fc_${randomUUID()}`, call_id: id,
    name, arguments: JSON.stringify(args), status: "completed" };
}

export function customCall(name, input, id = `call_${randomUUID()}`) {
  return { type: "custom_tool_call", id: `ctc_${randomUUID()}`, call_id: id,
    name, input, status: "completed" };
}

export function responseEvents(output, id = `resp_${randomUUID()}`) {
  const response = { id, object: "response", created_at: 1, status: "completed", output,
    usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  const events = [{ type: "response.created", response: { ...response, status: "in_progress", output: [] } }];
  for (const [output_index, item] of output.entries()) {
    events.push({ type: "response.output_item.added", output_index, item });
    if (item.type === "message") {
      for (const [content_index, part] of item.content.entries()) {
        events.push({ type: "response.content_part.added", item_id: item.id, output_index, content_index, part: { ...part, text: "" } });
        events.push({ type: "response.output_text.delta", item_id: item.id, output_index, content_index, delta: part.text });
        events.push({ type: "response.output_text.done", item_id: item.id, output_index, content_index, text: part.text });
      }
    } else if (item.type === "reasoning") {
      for (const [content_index, part] of (item.content ?? []).entries()) {
        events.push({ type: "response.content_part.added", item_id: item.id, output_index, content_index,
          part: { ...part, text: "" } });
        events.push({ type: "response.reasoning_text.delta", item_id: item.id, output_index, content_index,
          delta: part.text });
        events.push({ type: "response.reasoning_text.done", item_id: item.id, output_index, content_index,
          text: part.text });
        events.push({ type: "response.content_part.done", item_id: item.id, output_index, content_index, part });
      }
    }
    events.push({ type: "response.output_item.done", output_index, item });
  }
  events.push({ type: "response.completed", response });
  return events;
}

export class RpcClient {
  constructor(child, { sanitize = value => value } = {}) {
    this.child = child;
    this.sanitize = sanitize;
    this.events = [];
    this.pending = new Map();
    this.waiters = new Set();
    this.nextId = 1;
    this.stderr = "";
    this.onRequest = async (request) => { throw new Error(`未处理的宿主请求 ${request.method}`); };
    child.stderr.on("data", (chunk) => { this.stderr = sanitize(this.stderr + chunk).slice(-32_000); });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let value;
      try { value = JSON.parse(line); } catch { return; }
      this.events.push(value);
      if (Object.hasOwn(value, "id") && !value.method) {
        const pending = this.pending.get(value.id);
        if (pending) {
          this.pending.delete(value.id);
          clearTimeout(pending.timer);
          value.error ? pending.reject(Object.assign(new Error(sanitize(value.error.message)), { ...value.error, message: sanitize(value.error.message) })) : pending.resolve(value.result);
        }
      } else if (Object.hasOwn(value, "id") && value.method) {
        Promise.resolve().then(() => this.onRequest(value)).then(
          result => this.send({ id: value.id, result }),
          error => this.send({ id: value.id, error: { code: -32603, message: error.message } }),
        );
      }
      for (const waiter of this.waiters) if (waiter.predicate(value)) waiter.resolve(value);
    });
    child.once("exit", (code, signal) => {
      this.exited = true;
      const error = new Error(`官方测试子进程退出 (${code ?? signal}): ${this.stderr}`);
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      this.pending.clear();
      for (const waiter of this.waiters) waiter.reject(error);
    });
  }

  send(value) { if (!this.child.stdin.destroyed) this.child.stdin.write(`${JSON.stringify(value)}\n`); }

  request(method, params = {}, timeoutMs = 12_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC 超时 ${method}: ${this.stderr}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  async event(method, predicate = () => true, { after = 0, timeoutMs = 12_000 } = {}) {
    const matches = value => value.method === method && predicate(value.params);
    const found = this.events.slice(after).find(matches);
    if (found) return found.params;
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.waiters.delete(waiter); };
      const waiter = { predicate: matches, resolve: value => { cleanup(); resolve(value.params); }, reject: error => { cleanup(); reject(error); } };
      const timer = setTimeout(() => waiter.reject(new Error(this.sanitize(`事件超时 ${method}: ${JSON.stringify(this.events.slice(-6)).slice(0,5000)}\n${this.stderr.slice(-3000)}`))), timeoutMs);
      this.waiters.add(waiter);
    });
  }
}

// This is a scripted model endpoint, not a model. Every reply is consumed once.
// The official CLI, tools, filesystem and production routing components are real.
export async function startRuntime(t, { profile = "direct", config = "", model = null,
  initialize = true, experimental = true, prepare = null, cliArgs = [] } = {}) {
  const profileLabel = profile;
  const productionCatalog = profile.startsWith("configured-");
  if (productionCatalog) profile = profile === "configured-chat" ? "chat" : "custom";
  const directory = await mkdtemp(join(tmpdir(), "codex 免费回归 "));
  const cwd = join(directory, "测试项目 with spaces");
  const env = isolatedEnv(directory, { OPENAI_API_KEY: "sk-offline-fixture-no-account" });
  await mkdir(cwd, { recursive: true });
  await mkdir(env.CODEX_HOME, { recursive: true });
  await writeFile(join(env.CODEX_HOME, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: env.OPENAI_API_KEY }));
  const cli = await officialExecutable();
  let child;
  let rpc;
  let router;
  let route = null;
  const failures = [];
  const requests = [];
  const steps = [];
  const sockets = new WebSocketServer({ noServer: true });
  const server = createServer(async (request, response) => {
    try {
      const buffers = [];
      for await (const chunk of request) buffers.push(chunk);
      let bytes = Buffer.concat(buffers);
      if (request.headers["content-encoding"] === "zstd") bytes = zstdDecompressSync(bytes);
      if (request.headers["content-encoding"] === "gzip") bytes = gunzipSync(bytes);
      const body = bytes.length ? JSON.parse(bytes.toString()) : {};
      requests.push({ path: request.url, method: request.method, body, headers: request.headers });
      if (request.method === "HEAD") { response.writeHead(200); response.end(); return; }
      const step = steps.shift();
      assert.ok(step, `非预期模型请求 ${request.method} ${request.url}`);
      const result = await step(body, request, response);
      if (response.writableEnded || result === null) return;
      if (request.url.includes("/chat/completions")) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        const outputs = Array.isArray(result) ? result : [message(String(result))];
        const delta = { role: "assistant" };
        const text = outputs.filter(x => x.type === "message").flatMap(x => x.content).map(x => x.text).join("");
        if (text) delta.content = text;
        const calls = outputs.filter(x => ["function_call", "custom_tool_call"].includes(x.type));
        if (calls.length) delta.tool_calls = calls.map((item, index) => {
          const declaration = (body.tools ?? []).find(t => t.function?.name === item.name ||
            (item.type === "custom_tool_call" && t.function?.name.startsWith(`functions_${item.name}_`)));
          assert.ok(declaration, `模型必须先发现工具 ${item.name}`);
          return { index, id: item.call_id, type: "function", function: { name: declaration.function.name,
            arguments: item.arguments ?? JSON.stringify({ input: item.input }) } };
        });
        for (const chunk of [{ id: `chat_${randomUUID()}`, choices: [{ index: 0, delta, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: calls.length ? "tool_calls" : "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }]) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
        response.end("data: [DONE]\n\n");
      } else {
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of responseEvents(Array.isArray(result) ? result : [message(String(result))])) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        response.end();
      }
    } catch (error) {
      failures.push(error);
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  server.on("upgrade", (request, socket, head) => sockets.handleUpgrade(request, socket, head, ws => {
    ws.on("message", async raw => {
      try {
        const frame = JSON.parse(raw.toString());
        const body = frame.response ?? frame;
        requests.push({ path: request.url, method: "WS", body, headers: request.headers });
        if (body.generate === false) {
          for (const event of responseEvents([])) ws.send(JSON.stringify(event));
          return;
        }
        const step = steps.shift();
        assert.ok(step, "非预期模型 WebSocket 请求");
        const result = await step(body, request, ws);
        if (result === null) return;
        for (const event of responseEvents(Array.isArray(result) ? result : [message(String(result))])) ws.send(JSON.stringify(event));
      } catch (error) {
        failures.push(error);
        ws.send(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: error.message } }));
      }
    });
  }));
  t.after(async () => {
    if (failures.length) t.diagnostic(`本地服务最早失败: ${failures[0].stack}`);
    await stopChild(child);
    await router?.close();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(failures.map(e => e.message), [], "本地模型服务断言失败");
    assert.equal(steps.length, 0, "有已计划但未执行的模型请求");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}/v1/`;
  const { stdout: version } = await execOffline(cli, ["--version"], { directory });
  const { stdout } = await execOffline(cli, ["debug", "models"], { directory, env });
  let catalog = JSON.parse(stdout);
  const baseline = catalog.models.find(m => m.slug === "gpt-5.3-codex") ?? catalog.models[0];
  model ??= baseline.slug;
  const customModel = { ...baseline, slug: "offline-custom", display_name: "Offline fixture" };
  const deepSeekFixture = { ...deepSeekModel };
  const platform = { id: "123e4567-e89b-42d3-a456-426614174099", name: "Offline fixture", enabled: true,
    baseUrl: origin, apiKey: "sk-fixture-platform", models: [{ id: customModel.slug, supportsImage: true,
      contextWindow: 128000, displayName: "Offline fixture", defaultReasoningEffort: "low",
      chatCompatibility: profile === "chat", reasoningEfforts: ["low", "medium", "high"] }] };
  if (profile === "deepseek") {
    catalog.models = catalog.models.filter(candidate => candidate?.slug !== deepSeekFixture.slug);
    catalog.models.push(deepSeekFixture);
  } else if (productionCatalog) {
    const manager = new ExtraModelManager({ dataDir: join(directory, "model-settings") });
    manager.settings = { generation: 1, platforms: [platform] };
    catalog = (await manager.writeRuntimeCatalog(catalog)).catalog;
  } else catalog.models.push(customModel);
  const catalogPath = join(directory, "模型目录 with spaces.json");
  await writeFile(catalogPath, JSON.stringify(catalog));
  let endpoint = origin;
  const usagePath = join(directory, "usage.jsonl");
  if (["router", "custom", "chat", "deepseek"].includes(profile)) {
    router = new ModelRouterManager({
      officialApiBaseUrl: origin,
      officialCodexBaseUrl: origin,
      deepSeekBaseUrl: origin,
    });
    const deepSeek = profile === "deepseek" ? {
      enabled: true,
      configured: true,
      apiKey: "sk-fixture-deepseek",
      model: {
        displayName: deepSeekFixture.display_name,
        reasoningEfforts: deepSeekFixture.supported_reasoning_levels.map(item => item.effort),
      },
    } : undefined;
    route = await router.configure({
      officialAuthMode: "apiKey", usageEventPath: usagePath,
      deepSeek,
      extraModels: { platforms: [platform] },
    });
    endpoint = route.baseUrl;
    env[route.tokenEnv] = route.token;
    if (profile !== "router") model = profile === "deepseek" ? deepSeekFixture.slug : customModel.slug;
  }
  await writeFile(join(env.CODEX_HOME, "config.toml"), [
    `model = ${JSON.stringify(model)}`,
    'model_provider = "openai"',
    `openai_base_url = ${JSON.stringify(endpoint)}`,
    `model_catalog_json = ${JSON.stringify(catalogPath)}`,
    'cli_auth_credentials_store = "file"',
    'mcp_oauth_credentials_store = "file"',
    'web_search = "disabled"',
    'sandbox_mode = "danger-full-access"',
    'approval_policy = "never"',
    'features.responses_websockets_v2 = false',
    'features.multi_agent = false',
    'features.multi_agent_v2 = false',
    'features.shell_snapshot = false',
    'features.guardian_approval = false',
    config,
  ].join("\n") + "\n");
  await prepare?.({ directory, cwd, env, catalog, catalogPath, origin });
  let executable = cli;
  let executablePrefixArgs = [];
  if (profile !== "direct") {
    let shim = null;
    if (process.platform === "darwin") {
      shim = join(directory, "Codex Quota Injector Shim");
      await execFileAsync("/usr/bin/xcrun", ["swiftc", "-O", resolve(ROOT, "src/macos-codex-shim.swift"), "-o", shim], { timeout: 30_000 });
    } else if (process.platform === "win32") {
      shim = process.execPath;
      executablePrefixArgs = [resolve(ROOT, "src/windows-relay-entry.mjs")];
    } else {
      throw new Error(`BLOCKED: ${process.platform}/${process.arch} 没有生产中继测试适配器`);
    }
    const providerSettingsPath = join(directory, "provider-settings.json");
    const extraModelSettingsPath = join(directory, "runtime-extra-model-settings.json");
    await writeFile(providerSettingsPath, JSON.stringify(profile === "deepseek"
      ? { enabled: true, apiKey: "sk-fixture-deepseek", generation: 1 }
      : { enabled: false, apiKey: "", generation: 0 }));
    await writeFile(extraModelSettingsPath, JSON.stringify({
      generation: 1,
      platforms: route ? [platform] : [],
    }));
    const configPath = join(directory, "relay-config.json");
    await writeFile(configPath, JSON.stringify({ version: 4, upstreamExecutable: cli,
      relayExecutable: process.execPath, relayArguments: [resolve(ROOT, "src/launcher.mjs")],
      providerSettingsPath, extraModelSettingsPath, modelCatalogPath: catalogPath,
      relayStatePath: join(directory, "relay-state.json"), tokenUsageEventsPath: usagePath,
      generation: `offline-${randomUUID()}`,
      router: route ? { providerId: route.providerId, baseUrl: route.baseUrl,
        tokenEnv: route.tokenEnv, tokenHeader: route.tokenHeader,
        legacyProviderIds: route.legacyProviderIds } : null }));
    env.CODEX_QUOTA_RELAY_CONFIG = configPath;
    env.CODEX_QUOTA_UPSTREAM_CODEX_CLI = cli;
    executable = shim;
  }
  const command = sandboxCommand(executable, [...executablePrefixArgs, ...cliArgs, "app-server"]);
  child = spawn(command.executable, command.args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
  rpc = new RpcClient(child);
  if (initialize) {
    await rpc.request("initialize", { clientInfo: { name: "quota_offline_tests", version: "1.0.0" },
      capabilities: { experimentalApi: experimental } });
    rpc.send({ method: "initialized", params: {} });
  }
  t.diagnostic(`${version.trim()} / ${process.platform} ${process.arch} / ${profileLabel} / loopback-only`);
  return { ...{ directory, cwd, env, cli, rpc, child, model, catalog, catalogPath, origin, usagePath, requests, router, failures },
    enqueue(...handlers) { steps.push(...handlers.map(value => typeof value === "function" ? value : () => value)); },
    async thread(params = {}) { return rpc.request("thread/start", { model, cwd, approvalPolicy: "never", sandbox: "danger-full-access", ...params }); },
    async turn(threadId, text = "offline fixture", params = {}) {
      const after = rpc.events.length;
      const started = await rpc.request("turn/start", { threadId, input: [{ type: "text", text }], ...params });
      const completed = await rpc.event("turn/completed", p => p.threadId === threadId && p.turn.id === started.turn.id, { after });
      assert.equal(completed.turn.status, "completed", JSON.stringify(completed));
      return completed.turn;
    },
  };
}

function powershellQuote(value) {
  return String(value).replaceAll("'", "''");
}
