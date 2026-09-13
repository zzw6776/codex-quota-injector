import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { decodeJwt, parseTokenInput } from "../src/account-manager.mjs";
import { DeepSeekManager } from "../src/deepseek-manager.mjs";
import { ExtraModelManager } from "../src/extra-model-manager.mjs";
import { ModelRouterManager } from "../src/model-router.mjs";
import { getOpenAIShortContextRates } from "../src/token-pricing.mjs";
import {
  execOffline,
  isolatedEnv,
  officialExecutable,
  RpcClient,
  ROOT,
  stopChild,
} from "../runtime-tests/support/offline-runtime.mjs";
import {
  MACOS_NATIVE,
  WINDOWS_NATIVE,
  WSL_NATIVE,
} from "../scripts/test-runtime-targets.mjs";
const exec = promisify(execFile);
export const approved = process.env.CODEX_TEST_LIVE_APPROVED === "current-run";

export function liveBudget() {
  const maxTokens = Number(process.env.CODEX_TEST_LIVE_MAX_TOKENS ?? 500000);
  const maxTurns = Number(process.env.CODEX_TEST_LIVE_MAX_TURNS ?? 40);
  assert.ok(Number.isSafeInteger(maxTokens) && maxTokens > 0 && Number.isSafeInteger(maxTurns) && maxTurns > 0,
    "Token 和轮次上限必须是正整数，不能通过无效值取消停止阈值");
  return { tokens: 0, turns: 0, maxTokens, maxTurns };
}

export async function liveProfiles({
  extraModelManager = new ExtraModelManager(),
  deepSeekManager = new DeepSeekManager(),
} = {}) {
  const extra = extraModelManager;
  const deep = deepSeekManager;
  await extra.initialize(); await deep.initialize();
  if (extra.messageState === "error" || deep.messageState === "error") throw new Error("供应商配置读取失败；不能把失败误报为未配置");
  const deepView = deep.getViewModel();
  const deepSeek = deepView.enabled ? {
    enabled: deepView.enabled,
    configured: deepView.configured,
    apiKey: deepView.apiKey,
    generation: deep.settings.generation,
    model: deepView.model,
  } : undefined;
  const profiles = [{ id: "official", model: null, protocol: "responses", images: true,
    extraModels: extra.settings, deepSeek }];
  if (deepSeek) profiles.push({ id: "deepseek", model: deepSeek.model.slug, protocol: "responses", images: false, deepSeek });
  for (const platform of extra.settings.platforms.filter(p => p.enabled)) {
    // One model per configured platform/wire contract; enumerate every selection
    // explicitly in the report instead of charging for every catalog entry.
    for (const chat of [false, true]) {
      const model = platform.models.find(m => Boolean(m.chatCompatibility) === chat);
      if (model) profiles.push({ id: `${platform.name}/${chat ? "chat" : "responses"}`, model: model.id,
        protocol: chat ? "chat" : "responses", images: Boolean(model.supportsImage), extraModels: { platforms: [platform] } });
    }
  }
  return profiles;
}

export function publicProfile(profile) {
  return { id: profile.id, model: profile.model, protocol: profile.protocol, images: profile.images };
}

export function selectLiveProfiles(profiles, requested = process.env.CODEX_TEST_LIVE_PROFILE) {
  const id = String(requested ?? "").trim();
  if (!id) return profiles;
  const selected = profiles.filter(profile => profile.id === id);
  assert.equal(selected.length, 1,
    `未找到真实测试配置 ${id}；可用配置：${profiles.map(profile => profile.id).join("、")}`);
  return selected;
}

export function liveRouterConfiguration(route) {
  if (!route) return null;
  return {
    providerId: route.providerId,
    baseUrl: route.baseUrl,
    tokenEnv: route.tokenEnv,
    tokenHeader: route.tokenHeader,
    legacyProviderIds: [...route.legacyProviderIds],
  };
}

function argumentShape(value) {
  if (value === null) return { kind: "null" };
  if (Array.isArray(value)) return { kind: "array" };
  if (typeof value !== "object") return { kind: typeof value };
  const keys = Object.keys(value).sort();
  return { kind: "object", keys,
    valueTypes: Object.fromEntries(keys.map(key => [key, Array.isArray(value[key]) ? "array" : value[key] === null ? "null" : typeof value[key]])) };
}

export function summarizeLiveItem(item, sanitize = String) {
  const evidence = { type: item?.type ?? "unknown", status: item?.status ?? null,
    ...(item?.server ? { server: item.server } : {}), ...(item?.tool ? { tool: item.tool } : {}) };
  if (item?.type === "mcpToolCall") {
    evidence.arguments = argumentShape(item.arguments);
    if (item.error?.message) evidence.error = sanitize(item.error.message).slice(0, 2_000);
  }
  return evidence;
}

export function summarizeMcpRequests(text) {
  return String(text ?? "").split("\n").filter(Boolean).flatMap(line => {
    let event;
    try { event = JSON.parse(line); } catch { return []; }
    if (event.method !== "tools/call") return [];
    return [{ name: event.params?.name ?? "unknown", arguments: argumentShape(event.params?.arguments) }];
  }).slice(-20);
}

export function summarizeLiveEvidence({ events, profile, model, stage, budget, sanitize = String }) {
  const completedItems = events.filter(event => event.method === "item/completed")
    .map(event => summarizeLiveItem(event.params?.item, sanitize)).slice(-40);
  const errors = events.filter(event => event.method === "error").map(event =>
    sanitize(event.params?.error?.message ?? event.params?.message ?? "unknown error")).slice(-3);
  return { profile, model, stage, observedTokens: budget.tokens,
    regularTurns: budget.turns, completedItems, errors };
}

async function currentCredentials() {
  const directory = String(process.env.CODEX_HOME ?? "").trim() || join(homedir(), ".codex");
  const raw = await readFile(join(directory, "auth.json"), "utf8");
  const value = JSON.parse(raw);
  if (value.OPENAI_API_KEY) return { type: "apiKey", apiKey: value.OPENAI_API_KEY };
  const token = parseTokenInput(raw)[0];
  assert.ok(token?.accessToken, "当前账号缺少 access_token");
  const claims = decodeJwt(token.idToken) ?? decodeJwt(token.accessToken) ?? {};
  const auth = claims["https://api.openai.com/auth"] ?? {};
  const accountId = token.accountId ?? auth.chatgpt_account_id;
  assert.ok(accountId, "当前账号缺少 account_id");
  return { type: "chatgptAuthTokens", accessToken: token.accessToken, chatgptAccountId: accountId, chatgptPlanType: auth.chatgpt_plan_type ?? null };
}

export async function startLiveRuntime(t, profile, budget) {
  assert.ok(approved, "真实测试只能由 npm run test:live -- --confirm-token-use 启动");
  const runtimeTarget = process.env.CODEX_TEST_RUNTIME_TARGET ||
    (process.platform === "darwin" ? MACOS_NATIVE : process.platform === "win32" ? WINDOWS_NATIVE : null);
  const credentials = await currentCredentials();
  const secrets = [credentials.accessToken ?? credentials.apiKey, profile.deepSeek?.apiKey, ...(profile.extraModels?.platforms ?? []).map(p => p.apiKey)].filter(Boolean);
  const sanitize = text => secrets.reduce((value, secret) => value.replaceAll(secret, "[凭据已隐藏]"), String(text));
  const directory = await mkdtemp(join(tmpdir(), "quota-live-"));
  const cwd = join(directory, "project");
  const env = isolatedEnv(directory, { CODEX_TEST_RUNTIME_TARGET: runtimeTarget });
  await mkdir(cwd); await mkdir(env.CODEX_HOME);
  let child;
  let router;
  const requestShapes = [];
  t.after(async () => { await stopChild(child); await router?.close(); await rm(directory, { recursive: true, force: true }); });
  const cli = await officialExecutable();
  const catalogResult = await execOffline(cli, ["debug", "models"], {
    directory,
    env: { ...env, OPENAI_API_KEY: "sk-catalog-only" },
    cwd,
  });
  const { stdout } = catalogResult;
  let catalog = JSON.parse(stdout);
  const extra = new ExtraModelManager({ dataDir: directory });
  extra.settings = { generation: 1, platforms: profile.extraModels?.platforms ?? [] };
  const extraPath = await extra.writeRuntimeCatalog(catalog);
  if (extraPath?.path) catalog = JSON.parse(await readFile(extraPath.path, "utf8"));
  else if (typeof extraPath === "string") catalog = JSON.parse(await readFile(extraPath, "utf8"));
  if (profile.deepSeek) {
    const deep = new DeepSeekManager({ dataDir: directory }); deep.settings = profile.deepSeek;
    const path = await deep.writeRuntimeCatalog(catalog);
    if (path) catalog = JSON.parse(await readFile(typeof path === "string" ? path : path.path, "utf8"));
  }
  const catalogPath = join(directory, "catalog.json");
  await writeFile(catalogPath, JSON.stringify(catalog));
  const providerSettingsPath = join(directory, "provider-settings.json");
  const extraModelSettingsPath = join(directory, "runtime-extra-model-settings.json");
  await writeFile(providerSettingsPath, JSON.stringify(profile.deepSeek
    ? {
        enabled: Boolean(profile.deepSeek.enabled),
        apiKey: profile.deepSeek.apiKey,
        generation: profile.deepSeek.generation ?? 0,
      }
    : { enabled: false, apiKey: "", generation: 0 }));
  await writeFile(extraModelSettingsPath, JSON.stringify({
    generation: profile.extraModels?.generation ?? 0,
    platforms: profile.extraModels?.platforms ?? [],
  }));
  if (process.platform === "darwin") {
    router = new ModelRouterManager({
      onRequestShape(shape) {
        requestShapes.push(shape);
        if (requestShapes.length > 10) requestShapes.shift();
      },
    });
  }
  const route = await router?.configure({
    officialAuthMode: credentials.type === "apiKey" ? "apiKey" : "oauth",
    extraModels: profile.extraModels,
    deepSeek: profile.deepSeek,
    usageEventPath: join(directory, "usage.jsonl"),
  });
  if (profile.model) {
    if (process.platform === "darwin") {
      assert.ok(route?.routedModels.includes(profile.model),
        `真实配置 ${profile.id} 的模型 ${profile.model} 未注册到隔离 Router；已在发送模型请求前停止`);
    } else {
      assert.ok(catalog.models.some((model) => model.slug === profile.model),
        `真实配置 ${profile.id} 的模型 ${profile.model} 未写入 Windows 中继目录；已在发送模型请求前停止`);
    }
  }
  if (route) env[route.tokenEnv] = route.token;
  let relayExecutable;
  let relayArguments = [];
  if (process.platform === "darwin") {
    relayExecutable = join(directory, "test-shim");
    await exec("/usr/bin/xcrun", [
      "swiftc",
      "-O",
      join(ROOT, "src/macos-codex-shim.swift"),
      "-o",
      relayExecutable,
    ], { timeout: 30000 });
  } else if (process.platform === "win32" && runtimeTarget === WINDOWS_NATIVE) {
    relayExecutable = String(process.env.CODEX_TEST_RELAY_EXECUTABLE ?? "").trim();
    assert.ok(relayExecutable, "Windows 真实测试缺少 A 批验证过的原生 Relay");
  } else if (process.platform === "linux" && runtimeTarget === WSL_NATIVE) {
    relayExecutable = String(process.env.CODEX_TEST_RELAY_EXECUTABLE ?? "").trim();
    assert.ok(relayExecutable, "WSL 真实测试缺少 A 批验证过的原生 Relay");
  } else {
    throw new Error(`当前环境 ${process.platform}/${process.arch}/${runtimeTarget ?? "unknown"} 没有真实中继测试适配器`);
  }
  const config = join(directory, "relay.json");
  await writeFile(config, JSON.stringify({
    version: process.platform === "darwin" ? 4 : 1,
    upstreamExecutable: cli,
    ...(process.platform === "darwin" ? {
      relayExecutable: process.execPath,
      relayArguments: [join(ROOT, "src", "launcher.mjs")],
    } : {}),
    providerSettingsPath, extraModelSettingsPath, modelCatalogPath: catalogPath,
    relayStatePath: join(directory, "relay-state.json"),
    tokenUsageEventsPath: join(directory, "relay-usage.jsonl"), generation: randomUUID(),
    router: liveRouterConfiguration(route) }));
  env.CODEX_QUOTA_RELAY_CONFIG = config; env.CODEX_QUOTA_UPSTREAM_CODEX_CLI = cli;
  if (runtimeTarget === WSL_NATIVE) env.CODEX_QUOTA_WSL_UPSTREAM_CODEX_CLI = cli;
  const mcp = join(ROOT, "runtime-tests/support/mcp-fixture.mjs");
  await writeFile(join(env.CODEX_HOME, "config.toml"), [
    'cli_auth_credentials_store="ephemeral"', 'mcp_oauth_credentials_store="file"', 'model_provider="openai"',
    ...(route ? [`openai_base_url=${JSON.stringify(route.baseUrl)}`] : []), `model_catalog_json=${JSON.stringify(catalogPath)}`,
    'sandbox_mode="workspace-write"', 'approval_policy="never"', 'features.guardian_approval=false', 'features.multi_agent=false',
    'features.multi_agent_v2=false', 'features.shell_snapshot=false', 'web_search="disabled"',
    '[mcp_servers.fixture]', `command=${JSON.stringify(process.execPath)}`, `args=${JSON.stringify([mcp, cwd])}`,
  ].join("\n"));
  child = spawn(relayExecutable, [...relayArguments, "app-server"], {
    env,
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: process.platform === "win32",
  });
  const rpc = new RpcClient(child, { sanitize });
  let requests = 0;
  const totals = new Map();
  let budgetExceeded = false;
  child.stdout.on("data", () => {
    for (const event of rpc.events.slice(requests)) {
      if (event.method !== "thread/tokenUsage/updated") continue;
      const total = Number(event.params.tokenUsage?.total?.totalTokens) || 0;
      const previous = totals.get(event.params.threadId) ?? 0;
      budget.tokens += Math.max(0, total - previous); totals.set(event.params.threadId, Math.max(total, previous));
      if (budget.tokens >= budget.maxTokens && !budgetExceeded) {
        budgetExceeded = true;
        rpc.request("turn/interrupt", { threadId: event.params.threadId, turnId: event.params.turnId }).catch(() => {});
      }
    }
    requests = rpc.events.length;
  });
  await rpc.request("initialize", { clientInfo: { name: "quota_live_regression", version: "1" }, capabilities: { experimentalApi: true } });
  rpc.send({ method: "initialized", params: {} });
  rpc.onRequest = async request => { throw new Error(`真实测试不支持宿主请求 ${request.method}；停止，不操作日常账号`); };
  await rpc.request("account/login/start", credentials);
  const available = [];
  const seenCursors = new Set();
  let cursor;
  do {
    const page = await rpc.request("model/list", { includeHidden: false, ...(cursor ? { cursor } : {}) });
    available.push(...page.data);
    cursor = page.nextCursor;
    if (cursor) {
      assert.ok(!seenCursors.has(cursor), "模型目录分页重复游标，停止真实测试");
      seenCursors.add(cursor);
    }
  } while (cursor);
  const priced = available.filter(m => !m.hidden && getOpenAIShortContextRates(m.model)).sort((a,b) => {
    const x=getOpenAIShortContextRates(a.model),y=getOpenAIShortContextRates(b.model);return x.ordinaryInput+x.output-y.ordinaryInput-y.output;
  });
  const model = profile.model ?? process.env.CODEX_TEST_LIVE_MODEL ?? priced[0]?.model;
  assert.ok(model && available.some(m => m.model === model), `模型未出现在实际目录：${model ?? "无已知计价模型"}`);
  const selected = available.find(m => m.model === model);
  const supported = selected.supportedReasoningEfforts?.map(e => e.reasoningEffort) ?? [];
  const effort = ["none", "minimal", "low", "medium", "high", "xhigh", "max"].find(e => supported.includes(e)) ?? selected.defaultReasoningEffort;
  t.diagnostic(`真实配置 ${profile.id} / ${model} / ${process.platform} ${process.arch} / ${runtimeTarget}`);
  return { rpc, cwd, model, effort, directory, sanitize,
    async diagnostics(stage) {
      const evidence = summarizeLiveEvidence({ events: rpc.events, profile: profile.id, model, stage, budget, sanitize });
      evidence.mcpRequests = summarizeMcpRequests(await readFile(join(cwd, "mcp-events.jsonl"), "utf8").catch(() => ""));
      evidence.requestShapes = requestShapes;
      return evidence;
    },
    async thread(params = {}) { return rpc.request("thread/start", { cwd, model, approvalPolicy: "never", sandbox: "workspace-write", ...params }); },
    async turn(threadId, text, params = {}) {
      assert.ok(!budgetExceeded && budget.tokens < budget.maxTokens, "已达到观察到的 Token 停止阈值");
      assert.ok(++budget.turns <= budget.maxTurns, "已达到真实测试轮次数上限");
      const after = rpc.events.length;
      const result = await rpc.request("turn/start", { threadId, input: [{ type: "text", text }], ...(effort ? { effort } : {}), ...params });
      const done = await rpc.event("turn/completed", p => p.turn.id === result.turn.id, { after, timeoutMs: 90000 });
      assert.equal(done.turn.status, "completed");
      return done.turn.items.filter(i => i.type === "agentMessage").map(i => i.text).join("\n");
    },
  };
}
