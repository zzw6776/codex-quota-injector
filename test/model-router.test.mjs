import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { brotliCompressSync, deflateSync, gzipSync, zstdCompressSync } from "node:zlib";
import WebSocket, { WebSocketServer } from "ws";

import { reusableRouterIdentityFromRelayConfig } from "../src/codex-bridge.mjs";
import {
  MODEL_ROUTER_TOKEN_HEADER,
  ModelRouterManager,
  classifyNetworkLatency,
} from "../src/model-router.mjs";
import { GENERATION_METRICS_VERSION } from "../src/relay-contract.mjs";
import { readJsonRequest, startHttpServer, useTempDir, waitFor } from "./helpers.mjs";

const PLATFORM_ID = "123e4567-e89b-42d3-a456-426614174000";

test("网络 RTT 以近期中位数识别明显波动", () => {
  assert.equal(classifyNetworkLatency([], 48), "stable");
  assert.equal(classifyNetworkLatency([40, 42, 38], 45), "stable");
  assert.equal(classifyNetworkLatency([40, 42, 38], 180), "fluctuating");
  assert.equal(classifyNetworkLatency([40, 42, 38], Number.NaN), "fluctuating");
});

test("Router 跨注入器版本复用原端点，端口被占用时才生成新身份", async (t) => {
  const upstream = await startHttpServer(t, (_request, response) => response.end("ok"));
  const owner = new ModelRouterManager();
  const conflicting = new ModelRouterManager({ endpointReuseWaitMs: 0 });
  const replacement = new ModelRouterManager();
  t.after(async () => Promise.all([
    owner.close(),
    conflicting.close(),
    replacement.close(),
  ]));

  const original = await owner.configure(routerSettings(upstream.origin));
  const identity = reusableRouterIdentityFromRelayConfig({
    version: 4,
    generation: `catalog:usage-events-v40:${original.instanceId}`,
    router: {
      baseUrl: original.baseUrl,
      tokenEnv: original.tokenEnv,
      tokenHeader: original.tokenHeader,
    },
  });
  assert.deepEqual(identity, {
    port: Number(new URL(original.baseUrl).port),
    token: original.token,
    instanceId: original.instanceId,
  });

  const fallback = await conflicting.configure({
    ...routerSettings(upstream.origin),
    reusableIdentity: identity,
  });
  assert.notEqual(fallback.baseUrl, original.baseUrl);
  assert.notEqual(fallback.instanceId, original.instanceId);

  const releaseTimer = setTimeout(() => void owner.close(), 75);
  const reused = await replacement.configure({
    ...routerSettings(upstream.origin),
    reusableIdentity: identity,
  });
  clearTimeout(releaseTimer);
  assert.equal(reused.baseUrl, original.baseUrl);
  assert.equal(reused.token, original.token);
  assert.equal(reused.instanceId, original.instanceId);

  assert.equal(reusableRouterIdentityFromRelayConfig({
    version: 4,
    generation: `catalog:${original.instanceId}`,
    router: {
      baseUrl: original.baseUrl.replace("127.0.0.1", "localhost"),
      tokenEnv: original.tokenEnv,
      tokenHeader: original.tokenHeader,
    },
  }), null);
});

function routerSettings(origin, overrides = {}) {
  return {
    deepSeek: { enabled: false, configured: false, apiKey: "" },
    extraModels: {
      platforms: [{
        id: PLATFORM_ID,
        name: "Test Platform",
        baseUrl: `${origin}/v1/`,
        apiKey: "custom-secret",
        enabled: true,
        models: [{
          id: "custom-model",
          displayName: "Custom Model",
          supportsImage: false,
          reasoningEfforts: ["low", "high"],
          defaultReasoningEffort: "low",
          ...overrides,
        }],
      }],
    },
    officialAuthMode: "apiKey",
  };
}

async function readEvents(path) {
  const content = await readFile(path, "utf8");
  return content.trim().split("\n").map((line) => JSON.parse(line));
}

async function readRequestBuffer(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function openWebSocket(url, options = {}) {
  const socket = new WebSocket(url, options);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function collectWebSocket(socket, terminalCount) {
  const events = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("等待 WebSocket 响应超时")), 2_000);
    socket.on("message", (data) => {
      const value = JSON.parse(data.toString("utf8"));
      events.push(value);
      const count = events.filter((event) =>
        ["response.completed", "response.incomplete", "response.failed"].includes(event.type)
      ).length;
      if (count >= terminalCount) {
        clearTimeout(timer);
        resolve(events);
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test("Router 拒绝未认证与非 API 请求，认证后的新 API 路径默认透传官方上游", async (t) => {
  const received = [];
  const upstream = await startHttpServer(t, (request, response) => {
    received.push({ method: request.method, url: request.url, headers: request.headers });
    response.writeHead(200, { "content-type": "text/plain", "x-upstream": "yes" });
    response.end("ok");
  });
  const manager = new ModelRouterManager({
    officialApiBaseUrl: `${upstream.origin}/v1/`,
    officialCodexBaseUrl: `${upstream.origin}/codex/`,
  });
  t.after(() => manager.close());
  const config = await manager.configure(routerSettings(upstream.origin));

  const routerOrigin = new URL(config.baseUrl).origin;
  const unauthorized = await fetch(`${routerOrigin}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "custom-model", input: "hi" }),
  });
  assert.equal(unauthorized.status, 403);

  const forwarded = await fetch(`${routerOrigin}/v1/future/capability?mode=fast`, {
    headers: { [MODEL_ROUTER_TOKEN_HEADER]: config.token },
  });
  assert.equal(forwarded.status, 200);
  assert.equal(forwarded.headers.get("x-upstream"), "yes");
  assert.equal(await forwarded.text(), "ok");
  assert.equal(received[0].method, "GET");
  assert.equal(received[0].url, "/v1/future/capability?mode=fast");
  assert.equal(received[0].headers[MODEL_ROUTER_TOKEN_HEADER], undefined);

  const outOfScope = await fetch(`${routerOrigin}/internal/status`, {
    headers: { [MODEL_ROUTER_TOKEN_HEADER]: config.token },
  });
  assert.equal(outOfScope.status, 404);
  assert.equal(received.length, 1);
});

test("官方 Responses HTTP 支持压缩请求，转发原始字节和编码而不重新序列化", async (t) => {
  const received = [];
  const result = { id: "resp_compaction_v2", output: [{ type: "compaction", encrypted_content: "fixture" }] };
  const upstream = await startHttpServer(t, async (request, response) => {
    received.push({ url: request.url, headers: request.headers, body: await readRequestBuffer(request) });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
  });
  const manager = new ModelRouterManager({ officialApiBaseUrl: `${upstream.origin}/official/v1/` });
  t.after(() => manager.close());
  const config = await manager.configure(routerSettings(upstream.origin));
  const source = Buffer.from('{\n "model": "official-model", "input": "压缩上下文", "store": true\n}');
  for (const [encoding, encode] of [
    ["identity", (value) => value],
    ["gzip", gzipSync], ["deflate", deflateSync], ["br", brotliCompressSync],
    ["zstd", zstdCompressSync], ["gzip, br", (value) => brotliCompressSync(gzipSync(value))],
  ]) {
    const payload = encode(source);
    const response = await fetch(new URL("responses?compact=v2", config.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": encoding, authorization: "Bearer sk-fixture" },
      body: payload,
    });
    assert.equal(response.status, 200, encoding);
    assert.deepEqual(await response.json(), result);
    const request = received.at(-1);
    assert.equal(request.url, "/official/v1/responses?compact=v2");
    assert.equal(request.headers["content-encoding"], encoding);
    assert.equal(Number(request.headers["content-length"]), payload.length);
    assert.deepEqual(request.body, payload);
  }
});

test("WebSocket 断开后客户端回退到 zstd HTTP，仍能完成同一路由的 Responses 请求", async (t) => {
  let received;
  const upstream = await startHttpServer(t, async (request, response) => {
    received = { headers: request.headers, body: await readRequestBuffer(request) };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "resp_http_recovery", output: [] }));
  });
  const sockets = new WebSocketServer({ server: upstream.server });
  sockets.on("connection", (socket) => socket.once("message", () => socket.close(1012, "fixture reconnect")));
  t.after(() => {
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
  });
  const manager = new ModelRouterManager({ officialApiBaseUrl: `${upstream.origin}/v1/` });
  t.after(() => manager.close());
  const config = await manager.configure(routerSettings(upstream.origin));
  const wsUrl = new URL("responses", config.baseUrl);
  wsUrl.protocol = "ws:";
  const client = await openWebSocket(wsUrl);
  t.after(() => client.terminate());
  const body = { model: "official-model", input: "same compact request" };
  client.send(JSON.stringify({ type: "response.create", ...body }));
  await waitFor(() => client.readyState === WebSocket.CLOSED);
  // Codex's HTTP fallback was confirmed in the incident logs; here the mock
  // client exercises the Router's recovery path without using a real account.
  const payload = zstdCompressSync(Buffer.from(JSON.stringify(body)));
  const response = await fetch(new URL("responses", config.baseUrl), {
    method: "POST", headers: { "content-type": "application/json", "content-encoding": "zstd" }, body: payload,
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).id, "resp_http_recovery");
  assert.equal(received.headers["content-encoding"], "zstd");
  assert.deepEqual(received.body, payload);
});

test("zstd 自定义 Responses 改写后发送普通 JSON，移除旧压缩头并保留路由与鉴权隔离", async (t) => {
  let received;
  const upstream = await startHttpServer(t, async (request, response) => {
    received = { headers: request.headers, body: await readJsonRequest(request) };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "resp_custom_compressed", output: [] }));
  });
  const manager = new ModelRouterManager();
  t.after(() => manager.close());
  const config = await manager.configure(routerSettings(upstream.origin));
  const input = [{ role: "user", content: "保留输入" }];
  const response = await fetch(new URL("responses", config.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", "content-encoding": "zstd", authorization: "Bearer official-fixture" },
    body: zstdCompressSync(Buffer.from(JSON.stringify({ model: "custom-model", input, store: true, service_tier: "priority" }))),
  });
  assert.equal(response.status, 200);
  await response.json();
  assert.equal(received.headers["content-encoding"], undefined);
  assert.equal(received.headers.authorization, "Bearer custom-secret");
  assert.equal(received.body.model, "custom-model");
  assert.equal(received.body.store, false);
  assert.equal(received.body.service_tier, undefined);
  assert.deepEqual(received.body.input, input);
});

test("压缩辅助 JSON 首次请求即可按自定义模型路由，未知二进制编码仍透传", async (t) => {
  const received = [];
  const upstream = await startHttpServer(t, async (request, response) => {
    received.push({ url: request.url, headers: request.headers, body: await readRequestBuffer(request) });
    response.end("ok");
  });
  const manager = new ModelRouterManager({ officialApiBaseUrl: `${upstream.origin}/official/v1/` });
  t.after(() => manager.close());
  const config = await manager.configure(routerSettings(upstream.origin));
  const payload = zstdCompressSync(Buffer.from(JSON.stringify({ model: "custom-model", input: ["compact"] })));
  const compact = await fetch(new URL("responses/compact", config.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", "content-encoding": "zstd", authorization: "Bearer official-fixture" },
    body: payload,
  });
  assert.equal(compact.status, 200);
  await compact.text();
  assert.equal(received[0].url, "/v1/responses/compact");
  assert.equal(received[0].headers.authorization, "Bearer custom-secret");
  assert.equal(received[0].headers["content-encoding"], "zstd");
  assert.deepEqual(received[0].body, payload);
  const binary = Buffer.from([0, 255, 3]);
  const future = await fetch(new URL("future/binary", config.baseUrl), {
    method: "PUT",
    headers: { "content-type": "application/octet-stream", "content-encoding": "future-encoding" },
    body: binary,
  });
  assert.equal(future.status, 200);
  await future.text();
  assert.equal(received[1].url, "/official/v1/future/binary");
  assert.equal(received[1].headers["content-encoding"], "future-encoding");
  assert.deepEqual(received[1].body, binary);
});

test("损坏的压缩体和未知 JSON 编码在本地明确报错，不发送上游请求", async (t) => {
  let forwarded = 0;
  const upstream = await startHttpServer(t, (_request, response) => { forwarded++; response.end("unexpected"); });
  const manager = new ModelRouterManager({ officialApiBaseUrl: `${upstream.origin}/v1/` });
  t.after(() => manager.close());
  const config = await manager.configure(routerSettings(upstream.origin));
  for (const [encoding, body, status, message] of [
    ["zstd", Buffer.from("not-compressed"), 400, "无法解压 zstd 请求体"],
    ["unknown", Buffer.from("{}"), 415, "不支持的请求 Content-Encoding"],
    ["zstd", zstdCompressSync(Buffer.from("not-json")), 400, "无法解析 Responses JSON 请求"],
  ]) {
    const response = await fetch(new URL("responses", config.baseUrl), {
      method: "POST", headers: { "content-type": "application/json", "content-encoding": encoding }, body,
    });
    assert.equal(response.status, status);
    assert.ok((await response.json()).error.message.includes(message));
  }
  assert.equal(forwarded, 0);
});

test("官方辅助接口与未来 API 保持方法、路径、原始请求体和响应透明", async (t) => {
  const received = [];
  const upstream = await startHttpServer(t, async (request, response) => {
    received.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: await readRequestBuffer(request),
    });
    if (request.url.startsWith("/official/v1/responses/compact")) {
      response.writeHead(202, {
        "content-type": "application/json",
        "x-upstream-kind": "compact",
      });
      response.end(JSON.stringify({ type: "compaction", usage: { total_tokens: 99 } }));
      return;
    }
    response.writeHead(207, {
      "content-type": "application/octet-stream",
      "x-upstream-kind": "future",
    });
    response.end(Buffer.from([0, 255, 17, 23]));
  });
  const dataDir = await useTempDir(t);
  const usageEventPath = join(dataDir, "usage.jsonl");
  const manager = new ModelRouterManager({
    officialApiBaseUrl: `${upstream.origin}/official/v1/`,
    officialCodexBaseUrl: `${upstream.origin}/official/codex/`,
  });
  t.after(() => manager.close());
  const config = await manager.configure({
    ...routerSettings(upstream.origin),
    usageEventPath,
  });

  const compactBody = '{\n  "model": "official-model",\n  "input": ["keep-spacing"]\n}';
  const compact = await fetch(new URL("responses/compact?mode=lossless", config.baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer sk-test",
      "x-feature-header": "preserved",
    },
    body: compactBody,
  });
  assert.equal(compact.status, 202);
  assert.equal(compact.headers.get("x-upstream-kind"), "compact");
  assert.deepEqual(await compact.json(), {
    type: "compaction",
    usage: { total_tokens: 99 },
  });

  const binaryBody = Buffer.from([9, 8, 7, 0, 6]);
  const future = await fetch(new URL("future/binary?revision=2", config.baseUrl), {
    method: "PUT",
    headers: {
      "content-type": "application/octet-stream",
      authorization: "Bearer sk-test",
    },
    body: binaryBody,
  });
  assert.equal(future.status, 207);
  assert.equal(future.headers.get("x-upstream-kind"), "future");
  assert.deepEqual(Buffer.from(await future.arrayBuffer()), Buffer.from([0, 255, 17, 23]));

  assert.equal(received[0].method, "POST");
  assert.equal(received[0].url, "/official/v1/responses/compact?mode=lossless");
  assert.equal(received[0].headers.authorization, "Bearer sk-test");
  assert.equal(received[0].headers["x-feature-header"], "preserved");
  assert.equal(received[0].body.toString("utf8"), compactBody);
  assert.equal(received[1].method, "PUT");
  assert.equal(received[1].url, "/official/v1/future/binary?revision=2");
  assert.deepEqual(received[1].body, binaryBody);

  await manager.close();
  await assert.rejects(readFile(usageEventPath, "utf8"), { code: "ENOENT" });
});

test("辅助响应按 usage 结构统一计账，不依赖压缩或未来接口名称", async (t) => {
  const received = [];
  const upstream = await startHttpServer(t, async (request, response) => {
    received.push({ url: request.url, body: await readRequestBuffer(request) });
    const usage = {
      input_tokens: 8,
      input_tokens_details: { cached_tokens: 6 },
      output_tokens: 2,
      output_tokens_details: { reasoning_tokens: 1 },
      total_tokens: 10,
    };
    if (received.length > 1) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({
        id: "resp_aux_2",
        type: "future.progress",
        usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
      })}\n\n`);
      response.end(`data: ${JSON.stringify({
        id: "resp_aux_2",
        type: "future.done",
        usage,
      })}\n\n`);
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      type: "auxiliary_result",
      usage,
    }));
  });
  const dataDir = await useTempDir(t);
  const usageEventPath = join(dataDir, "usage.jsonl");
  const manager = new ModelRouterManager({
    officialApiBaseUrl: `${upstream.origin}/v1/`,
    officialCodexBaseUrl: `${upstream.origin}/codex/`,
  });
  t.after(() => manager.close());
  const config = await manager.configure({
    ...routerSettings(upstream.origin),
    usageEventPath,
  });
  const source = {
    model: "official-model",
    input: ["preserve me"],
    client_metadata: {
      thread_id: "thread-aux-usage",
      turn_id: "turn-aux-usage",
    },
  };
  const legacySource = { model: "official-model", input: ["legacy compact"] };
  const requests = [
    {
      path: "responses/compact",
      body: legacySource,
      headers: {
        "session-id": "thread-aux-usage",
        "x-codex-turn-metadata": JSON.stringify({ turn_id: "turn-aux-usage" }),
      },
    },
    { path: "future/billed-operation", body: source, headers: {} },
  ];
  for (const request of requests) {
    const response = await fetch(new URL(request.path, config.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk-test",
        ...request.headers,
      },
      body: JSON.stringify(request.body),
    });
    assert.equal(response.status, 200);
    if (request.path === "responses/compact") {
      assert.equal((await response.json()).type, "auxiliary_result");
    } else {
      assert.match(await response.text(), /future\.done/);
    }
  }
  assert.deepEqual(received.map((request) => request.url), [
    "/v1/responses/compact",
    "/v1/future/billed-operation",
  ]);
  assert.deepEqual(received.map((request) => request.body.toString("utf8")), [
    JSON.stringify(legacySource),
    JSON.stringify(source),
  ]);

  await manager.close();
  const events = await readEvents(usageEventPath);
  const usageEvents = events.filter((event) => event.type === "usage");
  assert.equal(usageEvents.length, 2);
  assert.ok(usageEvents.every((event) => event.rolloutUsageFallback === false));
  assert.match(usageEvents[0].responseId, /^router-request:/);
  assert.equal(usageEvents[1].responseId, "resp_aux_2");
  assert.equal(usageEvents[0].tokenUsage.last.totalTokens, 10);
  assert.equal(usageEvents[1].tokenUsage.total.totalTokens, 20);
  assert.equal(usageEvents[1].tokenUsage.last.cachedInputTokens, 6);
  assert.equal(usageEvents[1].tokenUsage.last.reasoningOutputTokens, 1);
  assert.equal(events.some((event) => event.type === "generation"), false);
});

test("辅助接口显式模型优先、无模型继承任务绑定且不污染主路由", async (t) => {
  const officialRequests = [];
  const customRequests = [];
  const official = await startHttpServer(t, async (request, response) => {
    officialRequests.push({
      url: request.url,
      headers: request.headers,
      body: await readRequestBuffer(request),
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"object":"list","data":[]}');
  });
  const custom = await startHttpServer(t, async (request, response) => {
    customRequests.push({
      url: request.url,
      headers: request.headers,
      body: await readRequestBuffer(request),
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(request.url === "/v1/responses"
      ? '{"id":"resp_custom","status":"completed","output":[]}'
      : '{"type":"compaction"}');
  });
  const manager = new ModelRouterManager({
    officialApiBaseUrl: `${official.origin}/official/v1/`,
    officialCodexBaseUrl: `${official.origin}/official/codex/`,
  });
  t.after(() => manager.close());
  const config = await manager.configure(routerSettings(custom.origin));
  const headers = {
    "content-type": "application/json",
    authorization: "Bearer official-secret",
    "chatgpt-account-id": "official-account",
    "x-codex-private": "official-metadata",
    "thread-id": "thread-custom-compact",
  };

  const primary = await fetch(new URL("responses", config.baseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "custom-model", input: "bind this task" }),
  });
  assert.equal(primary.status, 200);

  const explicitBody = JSON.stringify({
    model: "custom-model",
    input: ["first compact"],
  });
  const explicit = await fetch(new URL("responses/compact", config.baseUrl), {
    method: "POST",
    headers,
    body: explicitBody,
  });
  assert.equal(explicit.status, 200);

  const guardianBody = JSON.stringify({
    model: "official-guardian-model",
    input: ["classify without changing the task route"],
  });
  const guardian = await fetch(
    new URL("responses/guardian/guardian-classifier", config.baseUrl),
    { method: "POST", headers, body: guardianBody },
  );
  assert.equal(guardian.status, 200);

  const rememberedBody = JSON.stringify({ input: ["continue same task"] });
  const remembered = await fetch(new URL("responses/compact?followup=1", config.baseUrl), {
    method: "POST",
    headers,
    body: rememberedBody,
  });
  assert.equal(remembered.status, 200);

  const models = await fetch(new URL("models", config.baseUrl), {
    headers: { authorization: "Bearer sk-test", "thread-id": "thread-custom-compact" },
  });
  assert.equal(models.status, 200);

  assert.equal(customRequests.length, 3);
  assert.equal(customRequests[0].url, "/v1/responses");
  assert.equal(customRequests[0].headers.authorization, "Bearer custom-secret");
  assert.equal(customRequests[0].headers["chatgpt-account-id"], undefined);
  assert.equal(customRequests[0].headers["x-codex-private"], undefined);
  assert.equal(customRequests[1].url, "/v1/responses/compact");
  assert.equal(customRequests[1].body.toString("utf8"), explicitBody);
  assert.equal(customRequests[2].url, "/v1/responses/compact?followup=1");
  assert.equal(customRequests[2].body.toString("utf8"), rememberedBody);
  assert.equal(officialRequests.length, 2);
  assert.equal(
    officialRequests[0].url,
    "/official/v1/responses/guardian/guardian-classifier",
  );
  assert.equal(officialRequests[0].headers.authorization, "Bearer official-secret");
  assert.equal(officialRequests[0].body.toString("utf8"), guardianBody);
  assert.equal(officialRequests[1].url, "/official/v1/models");
});

test("自定义 Responses 请求只改写声明过的兼容字段并隔离官方凭据", async (t) => {
  let received;
  const requestShapes = [];
  const upstream = await startHttpServer(t, async (request, response) => {
    received = { headers: request.headers, body: await readJsonRequest(request) };
    response.writeHead(200, { "content-type": "application/json", "x-upstream": "yes" });
    response.end(JSON.stringify({
      id: "resp_custom",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
      usage: {
        input_tokens: 12,
        input_tokens_details: { cached_tokens: 3 },
        output_tokens: 5,
        output_tokens_details: { reasoning_tokens: 2 },
        total_tokens: 17,
      },
    }));
  });
  const dataDir = await useTempDir(t);
  const usageEventPath = join(dataDir, "usage.jsonl");
  const manager = new ModelRouterManager({ onRequestShape: shape => requestShapes.push(shape) });
  t.after(() => manager.close());
  const config = await manager.configure({
    ...routerSettings(upstream.origin),
    usageEventPath,
  });
  const source = {
    model: "custom-model",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
        internal_chat_message_metadata_passthrough: { turn_id: "private-turn" },
      },
      { type: "configuration_update", reasoning: { effort: "medium" } },
    ],
    tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
    service_tier: "priority",
    store: true,
    reasoning: { summary: "auto" },
    client_metadata: { thread_id: "thread-custom", turn_id: "turn-custom" },
  };
  const response = await fetch(new URL("responses?trace=1", config.baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer official-secret",
      "chatgpt-account-id": "account-id",
      "thread-id": "thread-custom",
      "turn-id": "turn-custom",
      "x-codex-test": "remove-me",
    },
    body: JSON.stringify(source),
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-upstream"), "yes");
  assert.equal((await response.json()).id, "resp_custom");
  assert.equal(received.headers.authorization, "Bearer custom-secret");
  assert.equal(received.headers["chatgpt-account-id"], undefined);
  assert.equal(received.headers["x-codex-test"], undefined);
  assert.equal(received.body.store, false);
  assert.equal(received.body.service_tier, undefined);
  assert.deepEqual(received.body.reasoning, { effort: "low" });
  assert.equal(received.body.input[0].internal_chat_message_metadata_passthrough, undefined);
  assert.deepEqual(received.body.input[0].content, source.input[0].content);
  assert.deepEqual(received.body.input[1], source.input[1],
    "公开的 Responses 配置更新必须保留，不能与 Codex 私有元数据一起误删");
  assert.deepEqual(source.input[0].internal_chat_message_metadata_passthrough, { turn_id: "private-turn" },
    "路由改写不能反向修改调用方请求对象");
  assert.deepEqual(received.body.tools, source.tools);
  assert.equal(requestShapes.length, 1);
  assert.equal(requestShapes[0].path, "/v1/responses");
  assert.equal(requestShapes[0].targetKind, "custom");
  assert.equal(requestShapes[0].shape.input[0].type, "message");
  assert.deepEqual(requestShapes[0].shape.input[0].content, [{ type: "input_text", keys: ["text", "type"] }]);
  assert.doesNotMatch(JSON.stringify(requestShapes), /hello|private-turn/);

  await manager.close();
  const events = await readEvents(usageEventPath);
  assert.equal(events.filter((event) => event.type === "turn-started").length, 1);
  assert.equal(events.filter((event) => event.type === "usage").length, 1);
  assert.equal(events.find((event) => event.type === "usage").responseId, "resp_custom");
  assert.equal(events.find((event) => event.type === "usage").tokenUsage.last.totalTokens, 17);
  assert.equal(events.filter((event) => event.type === "generation").length, 1);
  assert.equal(
    events.find((event) => event.type === "generation").generation.responseId,
    "resp_custom",
  );
  assert.equal(events.find((event) => event.type === "generation").generation.hasVisibleText, true);
});

test("自定义模型 4xx 只记录字段结构，不把提示词、工具参数或凭据写入诊断", async (t) => {
  const upstream = await startHttpServer(t, async (_request, response) => {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "fixture rejection" } }));
  });
  const diagnostics = [];
  const originalError = console.error;
  console.error = (...values) => diagnostics.push(values.join(" "));
  t.after(() => { console.error = originalError; });
  const manager = new ModelRouterManager();
  t.after(() => manager.close());
  const config = await manager.configure(routerSettings(upstream.origin));
  const secretText = "PROMPT_AND_ARGUMENT_MUST_NOT_APPEAR";
  const response = await fetch(new URL("responses", config.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer OFFICIAL_SECRET_MUST_NOT_APPEAR" },
    body: JSON.stringify({
      model: "custom-model",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: secretText }] },
        { type: "function_call", name: "fixture", call_id: "call_fixture", arguments: JSON.stringify({ secretText }) },
      ],
    }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.message, "fixture rejection");
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0], /上游返回 400/);
  assert.match(diagnostics[0], /"index":0/);
  assert.match(diagnostics[0], /"type":"message"/);
  assert.match(diagnostics[0], /"type":"input_text"/);
  assert.doesNotMatch(diagnostics[0], /PROMPT_AND_ARGUMENT_MUST_NOT_APPEAR|OFFICIAL_SECRET_MUST_NOT_APPEAR|custom-secret/);
});

test("自定义模型 HTTP 流内失败事件记录脱敏请求结构", async (t) => {
  const upstream = await startHttpServer(t, async (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({
      type: "response.failed",
      response: { status: "failed", error: { message: "PRIVATE_HTTP_STREAM_ERROR" } },
    })}\n\n`);
  });
  const diagnostics = [];
  const originalError = console.error;
  console.error = (...values) => diagnostics.push(values.join(" "));
  t.after(() => { console.error = originalError; });
  const manager = new ModelRouterManager();
  t.after(() => manager.close());
  const config = await manager.configure(routerSettings(upstream.origin));
  const response = await fetch(new URL("responses", config.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "custom-model",
      input: [{ type: "reasoning", id: "PRIVATE_HTTP_REASONING_ID", content: [
        { type: "reasoning_text", text: "PRIVATE_HTTP_REASONING_TEXT" },
      ] }],
    }),
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /response\.failed/);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0], /上游响应失败/);
  assert.match(diagnostics[0], /"type":"reasoning_text"/);
  assert.match(diagnostics[0], /"keys":\["text","type"\]/);
  assert.doesNotMatch(diagnostics[0], /PRIVATE_HTTP_STREAM_ERROR|PRIVATE_HTTP_REASONING_ID|PRIVATE_HTTP_REASONING_TEXT|custom-secret/);
});

test("Router 按请求 ID 聚合任意结构的非文字输出，并按引用关联每次工具耗时", async (t) => {
  let requestCount = 0;
  const upstream = await startHttpServer(t, async (request, response) => {
    const body = await readJsonRequest(request);
    requestCount += 1;
    if (requestCount === 1) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
      send({ type: "response.created", response: { id: "resp_tools" } });
      send({
        type: "response.in_progress",
        response: {
          id: "resp_tools",
          usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
        },
      });
      send({
        type: "response.output_item.done",
        item: { type: "future_action", id: "opaque_a", name: "first_tool" },
      });
      await new Promise((resolve) => setTimeout(resolve, 15));
      send({
        type: "response.output_item.done",
        item: { type: "another_action", id: "opaque_b", name: "second_tool" },
      });
      send({
        type: "response.completed",
        response: {
          id: "resp_tools",
          usage: { input_tokens: 5, output_tokens: 4, total_tokens: 9 },
        },
      });
      response.end();
      return;
    }
    assert.deepEqual(body.input, [
      { type: "opaque_result", call_id: "opaque_a", output: "a" },
      { type: "opaque_result", call_id: "opaque_b", output: "b" },
    ]);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "resp_final",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }],
      usage: { input_tokens: 6, output_tokens: 2, total_tokens: 8 },
    }));
  });
  const dataDir = await useTempDir(t);
  const usageEventPath = join(dataDir, "usage.jsonl");
  const manager = new ModelRouterManager();
  t.after(() => manager.close());
  const config = await manager.configure({
    ...routerSettings(upstream.origin),
    usageEventPath,
  });
  const post = (input) => fetch(new URL("responses", config.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "custom-model",
      input,
      client_metadata: { thread_id: "thread-tools", turn_id: "turn-tools" },
    }),
  });

  const toolResponse = await post("start");
  assert.equal(toolResponse.status, 200);
  await toolResponse.text();
  await new Promise((resolve) => setTimeout(resolve, 15));
  const finalResponse = await post([
    { type: "opaque_result", call_id: "opaque_a", output: "a" },
    { type: "opaque_result", call_id: "opaque_b", output: "b" },
  ]);
  assert.equal(finalResponse.status, 200);
  await finalResponse.text();

  await manager.close();
  const events = await readEvents(usageEventPath);
  const generations = events.filter((event) => event.type === "generation");
  const usageEvents = events.filter((event) => event.type === "usage");
  const timing = events.find((event) => event.type === "generation-tool-timing");
  assert.equal(generations.length, 2);
  assert.equal(usageEvents.length, 2);
  assert.deepEqual(usageEvents.map((event) => event.responseId), ["resp_tools", "resp_final"]);
  assert.equal(usageEvents[0].tokenUsage.last.totalTokens, 9);
  assert.equal(usageEvents[1].tokenUsage.total.totalTokens, 17);
  assert.equal(generations[0].generationMetricsVersion, GENERATION_METRICS_VERSION);
  assert.equal(generations[0].generation.responseId, "resp_tools");
  assert.equal(generations[1].generation.responseId, "resp_final");
  assert.equal(generations[0].generation.hasNonTextOutput, true);
  assert.deepEqual(generations[0].generation.toolNames, []);
  assert.equal(generations[1].generation.followsToolResult, true);
  assert.equal(generations[1].generation.hasVisibleText, true);
  assert.equal(timing.generationMetricsVersion, GENERATION_METRICS_VERSION);
  assert.equal(timing.requestId, generations[0].generation.requestId);
  assert.deepEqual(timing.toolTiming.toolNames, ["first_tool", "second_tool"]);
  assert.equal(timing.toolTiming.toolCount, 2);
  assert.ok(timing.toolTiming.readyLatencyMs >= 15);
  assert.equal(timing.toolTiming.calls.length, 2);
  assert.ok(timing.toolTiming.calls[0].durationMs > timing.toolTiming.calls[1].durationMs);
  assert.ok(timing.toolTiming.durationMs >= timing.toolTiming.calls[0].durationMs);
});

test("Router 按消息阶段记录文本耗时，并从输出项开始计算工具准备阶段", async (t) => {
  let requestCount = 0;
  const upstream = await startHttpServer(t, async (request, response) => {
    const body = await readJsonRequest(request);
    requestCount += 1;
    if (requestCount === 1) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
      send({ type: "response.created", response: { id: "resp_stages_tool" } });
      await new Promise((resolve) => setTimeout(resolve, 10));
      send({
        type: "response.output_item.added",
        item: { type: "message", id: "msg_commentary", role: "assistant", phase: "commentary", content: [] },
      });
      send({
        type: "response.output_text.delta",
        item_id: "msg_commentary",
        delta: "我先",
      });
      await new Promise((resolve) => setTimeout(resolve, 15));
      send({ type: "response.output_text.delta", item_id: "msg_commentary", delta: "检查。" });
      send({
        type: "response.output_text.done",
        item_id: "msg_commentary",
        text: "我先检查。",
      });
      send({
        type: "response.output_item.done",
        item: {
          type: "message",
          id: "msg_commentary",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "我先检查。" }],
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      send({
        type: "response.output_item.added",
        item: { type: "function_call", id: "fc_stage", call_id: "call_stage", name: "exec" },
      });
      await new Promise((resolve) => setTimeout(resolve, 15));
      send({
        type: "response.function_call_arguments.delta",
        item_id: "fc_stage",
        call_id: "call_stage",
        delta: "{\"cmd\":",
      });
      await new Promise((resolve) => setTimeout(resolve, 15));
      send({ type: "response.function_call_arguments.delta", item_id: "fc_stage", delta: "\"pwd\"}" });
      send({
        type: "response.output_item.done",
        item: {
          type: "function_call",
          id: "fc_stage",
          call_id: "call_stage",
          name: "exec",
          arguments: "{\"cmd\":\"pwd\"}",
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 15));
      send({
        type: "response.completed",
        response: {
          id: "resp_stages_tool",
          output: [
            {
              type: "message",
              id: "msg_commentary",
              role: "assistant",
              phase: "commentary",
              content: [{ type: "output_text", text: "我先检查。" }],
            },
            {
              type: "function_call",
              id: "fc_stage",
              call_id: "call_stage",
              name: "exec",
              arguments: "{\"cmd\":\"pwd\"}",
            },
          ],
          usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
        },
      });
      response.end();
      return;
    }
    assert.deepEqual(body.input, [
      { type: "function_call_output", call_id: "call_stage", output: "ok" },
    ]);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "resp_stages_final",
      status: "completed",
      output: [{
        type: "message",
        id: "msg_final",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "完成。" }],
      }],
      usage: { input_tokens: 6, output_tokens: 2, total_tokens: 8 },
    }));
  });
  const dataDir = await useTempDir(t);
  const usageEventPath = join(dataDir, "usage.jsonl");
  const manager = new ModelRouterManager();
  t.after(() => manager.close());
  const config = await manager.configure({ ...routerSettings(upstream.origin), usageEventPath });
  const post = (input) => fetch(new URL("responses", config.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "custom-model",
      input,
      client_metadata: { thread_id: "thread-stages", turn_id: "turn-stages" },
    }),
  });

  await (await post("start")).text();
  await new Promise((resolve) => setTimeout(resolve, 15));
  await (await post([
    { type: "function_call_output", call_id: "call_stage", output: "ok" },
  ])).text();
  await manager.close();

  const events = await readEvents(usageEventPath);
  const generations = events.filter((event) => event.type === "generation");
  assert.equal(generations.length, 2);
  assert.equal(generations[0].generation.textPhases.length, 1);
  assert.equal(generations[0].generation.textPhases[0].phase, "commentary");
  assert.ok(generations[0].generation.textPhases[0].startLatencyMs >= 8);
  assert.ok(generations[0].generation.textPhases[0].durationMs >= 12);
  assert.deepEqual(generations[1].generation.textPhases, [{
    phase: "final_answer",
    startLatencyMs: generations[1].generation.textPhases[0].startLatencyMs,
    durationMs: null,
  }]);

  const timing = events.find((event) => event.type === "generation-tool-timing");
  assert.ok(timing.toolTiming.preparationStartLatencyMs >= 30);
  assert.ok(timing.toolTiming.preparationDurationMs >= 25);
  assert.ok(
    generations[0].generation.textPhases[0].startLatencyMs +
      generations[0].generation.textPhases[0].durationMs <=
      timing.toolTiming.preparationStartLatencyMs,
  );
  assert.ok(timing.toolTiming.readyLatencyMs >=
    timing.toolTiming.preparationStartLatencyMs + timing.toolTiming.preparationDurationMs);
  assert.ok(timing.toolTiming.calls[0].preparationDurationMs >= 25);
  assert.ok(timing.toolTiming.durationMs >= 12);
});

test("自定义模型能力约束和同任务供应商锁在访问上游前生效", async (t) => {
  let requests = 0;
  const upstream = await startHttpServer(t, (_request, response) => {
    requests += 1;
    response.end("{}");
  });
  const manager = new ModelRouterManager();
  t.after(() => manager.close());
  const settings = routerSettings(upstream.origin);
  settings.extraModels.platforms.push({
    ...settings.extraModels.platforms[0],
    id: "123e4567-e89b-42d3-a456-426614174001",
    name: "Second Platform",
    models: [{
      ...settings.extraModels.platforms[0].models[0],
      id: "second-model",
      supportsImage: true,
    }],
  });
  const config = await manager.configure(settings);
  const post = (body) => fetch(new URL("responses", config.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", "thread-id": "locked-thread" },
    body: JSON.stringify(body),
  });

  const image = await post({
    model: "custom-model",
    input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }] }],
  });
  assert.equal(image.status, 400);
  assert.match((await image.json()).error.message, /图片输入能力/);

  const effort = await post({ model: "custom-model", input: "hi", reasoning: { effort: "max" } });
  assert.equal(effort.status, 400);
  assert.match((await effort.json()).error.message, /推理深度/);

  const first = await post({ model: "custom-model", input: "hi" });
  assert.equal(first.status, 200);
  const rerouted = await post({ model: "second-model", input: "hi" });
  assert.equal(rerouted.status, 409);
  assert.equal(requests, 1);
});

test("无生成预热不会抢占任务供应商，首个被接受的真实请求才建立锁", async (t) => {
  const requests = [];
  const upstream = await startHttpServer(t, async (request, response) => {
    requests.push(await readJsonRequest(request));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: `resp_${requests.length}`, status: "completed", output: [] }));
  });
  const manager = new ModelRouterManager({
    officialApiBaseUrl: `${upstream.origin}/v1/`,
    officialCodexBaseUrl: `${upstream.origin}/v1/`,
    deepSeekBaseUrl: `${upstream.origin}/v1/`,
  });
  t.after(() => manager.close());
  const settings = routerSettings(upstream.origin);
  settings.deepSeek = {
    enabled: true,
    configured: true,
    apiKey: "deepseek-secret",
    model: { displayName: "DeepSeek V4 Flash", reasoningEfforts: ["low", "high", "max"] },
  };
  const config = await manager.configure(settings);
  const post = (body) => fetch(new URL("responses", config.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", "thread-id": "prewarm-task" },
    body: JSON.stringify(body),
  });

  const prewarm = await post({ model: "deepseek-v4-flash", generate: false, input: [] });
  assert.equal(prewarm.status, 200);
  const official = await post({ model: "official-model", input: "real turn" });
  assert.equal(official.status, 200);
  const rerouted = await post({ model: "deepseek-v4-flash", input: "must reject" });
  assert.equal(rerouted.status, 409);
  assert.equal(requests.length, 2);
});

test("本地校验失败和上游拒绝均不会留下任务供应商锁", async (t) => {
  const requests = [];
  const upstream = await startHttpServer(t, async (request, response) => {
    const body = await readJsonRequest(request);
    requests.push(body);
    const status = body.model === "custom-model" ? 400 : 200;
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(status === 200
      ? { id: `resp_${requests.length}`, status: "completed", output: [] }
      : { error: { message: "fixture rejection" } }));
  });
  const manager = new ModelRouterManager();
  t.after(() => manager.close());
  const settings = routerSettings(upstream.origin);
  settings.extraModels.platforms.push({
    ...settings.extraModels.platforms[0],
    id: "123e4567-e89b-42d3-a456-426614174001",
    name: "Second Platform",
    models: [{
      ...settings.extraModels.platforms[0].models[0],
      id: "second-model",
      supportsImage: true,
    }],
  });
  const config = await manager.configure(settings);
  const post = (threadId, body) => fetch(new URL("responses", config.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", "thread-id": threadId },
    body: JSON.stringify(body),
  });

  const invalid = await post("validation-task", {
    model: "custom-model",
    input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }] }],
  });
  assert.equal(invalid.status, 400);
  assert.equal((await post("validation-task", { model: "second-model", input: "accepted" })).status, 200);

  assert.equal((await post("rejected-task", { model: "custom-model", input: "reject" })).status, 400);
  assert.equal((await post("rejected-task", { model: "second-model", input: "accepted" })).status, 200);
  assert.deepEqual(requests.map((body) => body.model), ["second-model", "custom-model", "second-model"]);
});

test("官方 HTTP 路由完整透传 Codex 能力字段且不重复记录 usage", async (t) => {
  const requests = [];
  const upstream = await startHttpServer(t, async (request, response) => {
    if (request.method === "GET") {
      requests.push({ method: request.method, url: request.url, headers: request.headers });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: "official-model" }] }));
      return;
    }
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: await readJsonRequest(request),
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "resp_official",
      status: "completed",
      output: [],
      usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 },
    }));
  });
  const dataDir = await useTempDir(t);
  const usageEventPath = join(dataDir, "usage.jsonl");
  const base = `${upstream.origin}/v1/`;
  const manager = new ModelRouterManager({
    officialApiBaseUrl: base,
    officialCodexBaseUrl: base,
  });
  t.after(() => manager.close());
  const config = await manager.configure({ ...routerSettings(upstream.origin), usageEventPath });
  const models = await fetch(new URL("models?limit=10", config.baseUrl), {
    headers: { authorization: "Bearer sk-test" },
  });
  assert.equal(models.status, 200);

  const payload = {
    model: "official-model",
    input: [
      { role: "user", content: [
        { type: "input_text", text: "inspect" },
        { type: "input_image", image_url: "data:image/png;base64,AA==" },
      ] },
      { type: "function_call_output", call_id: "call_1", output: "done" },
    ],
    previous_response_id: "resp_previous",
    tools: [
      { type: "function", name: "lookup", parameters: { type: "object" } },
      { type: "mcp", server_label: "yuque" },
      { type: "computer" },
      { type: "shell" },
      { type: "apply_patch" },
    ],
    tool_choice: "auto",
    parallel_tool_calls: true,
    reasoning: { effort: "high", summary: "auto" },
    client_metadata: { thread_id: "thread-official", turn_id: "turn-official" },
    stream: false,
  };
  const response = await fetch(new URL("responses?include=usage", config.baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer sk-test",
      "x-feature-header": "preserved",
    },
    body: JSON.stringify(payload),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).id, "resp_official");
  assert.equal(requests[0].url, "/v1/models?limit=10");
  assert.equal(requests[1].url, "/v1/responses?include=usage");
  assert.deepEqual(requests[1].body, payload);
  assert.equal(requests[1].headers.authorization, "Bearer sk-test");
  assert.equal(requests[1].headers["x-feature-header"], "preserved");

  await manager.close();
  const events = await readEvents(usageEventPath);
  const started = events.find((event) => event.type === "turn-started");
  assert.equal(started.rolloutUsageFallback, true);
  assert.equal(events.some((event) => event.type === "usage"), false);
  assert.equal(events.filter((event) => event.type === "generation").length, 1);
  assert.equal(
    events.find((event) => event.type === "generation").generation.responseId,
    "resp_official",
  );
});

test("官方 WebSocket 连续预热与 incomplete 响应保持帧透明且只统计真实生成", async (t) => {
  const received = [];
  const requestShapes = [];
  let pingCount = 0;
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
  });
  wss.on("connection", (socket) => {
    socket.on("ping", () => { pingCount += 1; });
    let tail = Promise.resolve();
    socket.on("message", (raw) => {
      tail = tail.then(async () => {
        const body = JSON.parse(raw.toString("utf8"));
        received.push(body);
        const common = { stream_id: body.stream_id, response: { id: `resp_${received.length}` } };
        socket.send(JSON.stringify({ type: "response.created", ...common }));
        if (body.generate === false) {
          socket.send(JSON.stringify({
            type: "response.completed",
            ...common,
            response: { ...common.response, usage: { input_tokens: 0, output_tokens: 0 } },
          }));
          return;
        }
        socket.send(JSON.stringify({ type: "response.output_text.delta", stream_id: body.stream_id, delta: "A" }));
        socket.send(JSON.stringify({
          type: "response.output_item.added",
          stream_id: body.stream_id,
          item: { type: "function_call", name: "exec_command" },
        }));
        await new Promise((resolve) => setTimeout(resolve, 15));
        socket.send(JSON.stringify({ type: "response.output_text.delta", stream_id: body.stream_id, delta: "B" }));
        socket.send(JSON.stringify({
          type: "response.incomplete",
          stream_id: body.stream_id,
          response: {
            id: common.response.id,
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
          },
        }));
      });
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const dataDir = await useTempDir(t);
  const usageEventPath = join(dataDir, "usage.jsonl");
  const manager = new ModelRouterManager({
    officialApiBaseUrl: `${origin}/v1/`,
    officialCodexBaseUrl: `${origin}/v1/`,
    networkProbeIntervalMs: 20,
    networkProbeTimeoutMs: 100,
    onRequestShape: shape => requestShapes.push(shape),
  });
  const networkStates = [];
  const removeNetworkListener = manager.onNetworkChange((state) => networkStates.push(state));
  t.after(removeNetworkListener);
  t.after(() => manager.close());
  const config = await manager.configure({ ...routerSettings(origin), usageEventPath });
  const socketUrl = new URL("responses", config.baseUrl);
  socketUrl.protocol = "ws:";
  const socket = await openWebSocket(socketUrl);
  t.after(() => socket.terminate());
  const eventsPromise = collectWebSocket(socket, 2);
  const baseRequest = {
    type: "response.create",
    model: "official-model",
    stream_id: "lane-1",
    client_metadata: { thread_id: "thread-ws", turn_id: "turn-ws" },
  };
  socket.send(JSON.stringify({ ...baseRequest, generate: false }));
  socket.send(JSON.stringify({
    ...baseRequest,
    generate: true,
    input: [{ type: "function_call_output", call_id: "call_1", output: "ok" }],
    tools: [{ type: "mcp", server_label: "yuque" }],
  }));

  const events = await eventsPromise;
  assert.equal(events.filter((event) => event.type === "response.completed").length, 1);
  assert.equal(events.filter((event) => event.type === "response.incomplete").length, 1);
  assert.deepEqual(received[0], { ...baseRequest, generate: false });
  assert.deepEqual(received[1], {
    ...baseRequest,
    generate: true,
    input: [{ type: "function_call_output", call_id: "call_1", output: "ok" }],
    tools: [{ type: "mcp", server_label: "yuque" }],
  });
  assert.equal(requestShapes.length, 2);
  assert.ok(requestShapes.every(shape => shape.targetKind === "official"));
  assert.equal(requestShapes[1].shape.input[0].type, "function_call_output");
  assert.doesNotMatch(JSON.stringify(requestShapes), /yuque|call_1|ok/);

  await waitFor(async () => {
    try {
      return (await readEvents(usageEventPath)).some((event) => event.type === "generation");
    } catch {
      return false;
    }
  });
  await waitFor(() => manager.getNetworkViewModel().status === "stable");
  const usageEvents = await readEvents(usageEventPath);
  assert.equal(usageEvents.filter((event) => event.type === "generation").length, 1);
  const generation = usageEvents.find((event) => event.type === "generation").generation;
  assert.equal(generation.responseId, "resp_2");
  assert.equal(generation.hasVisibleText, true);
  assert.equal(generation.hasNonTextOutput, true);
  assert.deepEqual(generation.toolNames, []);
  assert.equal(generation.followsToolResult, true);
  assert.ok(generation.generationDurationMs >= 1);
  assert.ok(pingCount >= 1);
  assert.equal(generation.networkLatency.status, "stable");
  assert.ok(generation.networkLatency.latencyMs >= 1);
  const started = usageEvents.find((event) => event.type === "turn-started");
  assert.equal(started.networkLatencySupported, true);
  assert.equal(started.networkConnectionId, generation.networkLatency.connectionId);
  assert.equal(usageEvents.some((event) => event.type === "usage"), false);

  for (const upstreamSocket of wss.clients) upstreamSocket.terminate();
  await waitFor(() => manager.getNetworkViewModel().status === "reconnecting");
  assert.equal(manager.getNetworkViewModel().latencyMs, null);

  const replacementSocket = await openWebSocket(socketUrl);
  t.after(() => replacementSocket.terminate());
  const replacementEvents = collectWebSocket(replacementSocket, 1);
  replacementSocket.send(JSON.stringify({
    ...baseRequest,
    stream_id: "lane-rebuilt",
    generate: false,
  }));
  await replacementEvents;
  await waitFor(() => networkStates.some((state) => state.status === "reconnected"));
  await manager.close();
});

test("未来的 API WebSocket 路径透明桥接到官方上游", async (t) => {
  let receivedRequest;
  let receivedMessage;
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
  });
  wss.on("connection", (socket, request) => {
    receivedRequest = { url: request.url, headers: request.headers, protocol: socket.protocol };
    socket.once("message", (data, isBinary) => {
      receivedMessage = { data: Buffer.from(data), isBinary };
      socket.send(data, { binary: isBinary });
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const manager = new ModelRouterManager({
    officialApiBaseUrl: `${origin}/official/v1/`,
    officialCodexBaseUrl: `${origin}/official/codex/`,
  });
  t.after(() => manager.close());
  const config = await manager.configure(routerSettings(origin));
  const socketUrl = new URL("future/live?revision=3", config.baseUrl);
  socketUrl.protocol = "ws:";
  const socket = new WebSocket(socketUrl, "codex-transparent-v1", {
    headers: {
      authorization: "Bearer sk-test",
      "x-feature-header": "preserved",
    },
  });
  t.after(() => socket.terminate());
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const echoed = new Promise((resolve, reject) => {
    socket.once("message", (data, isBinary) => resolve({ data: Buffer.from(data), isBinary }));
    socket.once("error", reject);
  });
  const payload = Buffer.from([5, 4, 3, 2, 1]);
  socket.send(payload, { binary: true });
  assert.deepEqual(await echoed, { data: payload, isBinary: true });

  assert.equal(receivedRequest.url, "/official/v1/future/live?revision=3");
  assert.equal(receivedRequest.protocol, "codex-transparent-v1");
  assert.equal(receivedRequest.headers.authorization, "Bearer sk-test");
  assert.equal(receivedRequest.headers["x-feature-header"], "preserved");
  assert.equal(receivedRequest.headers[MODEL_ROUTER_TOKEN_HEADER], undefined);
  assert.deepEqual(receivedMessage, { data: payload, isBinary: true });
});

test("自定义模型 WebSocket 将 HTTP SSE 转成同通道事件并本地完成预热", async (t) => {
  let received;
  const upstream = await startHttpServer(t, async (request, response) => {
    received = await readJsonRequest(request);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
    send({ type: "response.created", response: { id: "resp_custom_ws" } });
    send({ type: "response.output_text.delta", delta: "hello" });
    send({
      type: "response.completed",
      response: {
        id: "resp_custom_ws",
        status: "completed",
        usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
      },
    });
    response.end();
  });
  const manager = new ModelRouterManager();
  t.after(() => manager.close());
  const config = await manager.configure(routerSettings(upstream.origin));
  const socketUrl = new URL("responses", config.baseUrl);
  socketUrl.protocol = "ws:";
  const socket = await openWebSocket(socketUrl);
  t.after(() => socket.terminate());
  const eventsPromise = collectWebSocket(socket, 2);
  const metadata = { thread_id: "thread-custom-ws", turn_id: "turn-custom-ws" };
  socket.send(JSON.stringify({
    type: "response.create",
    model: "custom-model",
    stream_id: "custom-lane",
    generate: false,
    client_metadata: metadata,
  }));
  socket.send(JSON.stringify({
    type: "response.create",
    model: "custom-model",
    stream_id: "custom-lane",
    generate: true,
    input: "hello",
    client_metadata: metadata,
  }));
  const events = await eventsPromise;
  assert.equal(events.filter((event) => event.stream_id === "custom-lane").length, events.length);
  assert.equal(events.filter((event) => event.type === "response.completed").length, 2);
  assert.equal(received.type, undefined);
  assert.equal(received.generate, undefined);
  assert.equal(received.stream_id, undefined);
  assert.equal(received.client_metadata, undefined);
  assert.equal(received.stream, true);
  assert.equal(received.store, false);
  assert.equal(manager.getNetworkViewModel().status, "unavailable");
});

test("自定义模型 WebSocket 4xx 的结构诊断不记录正文或凭据", async (t) => {
  const upstream = await startHttpServer(t, async (_request, response) => {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "fixture websocket rejection" } }));
  });
  const diagnostics = [];
  const originalError = console.error;
  console.error = (...values) => diagnostics.push(values.join(" "));
  t.after(() => { console.error = originalError; });
  const manager = new ModelRouterManager();
  t.after(() => manager.close());
  const config = await manager.configure(routerSettings(upstream.origin));
  const socketUrl = new URL("responses", config.baseUrl);
  socketUrl.protocol = "ws:";
  const socket = await openWebSocket(socketUrl);
  t.after(() => socket.terminate());
  const eventsPromise = collectWebSocket(socket, 1);
  socket.send(JSON.stringify({
    type: "response.create",
    model: "custom-model",
    stream_id: "diagnostic-lane",
    generate: true,
    input: [{ type: "message", role: "user", content: [
      { type: "input_text", text: "WEBSOCKET_PROMPT_MUST_NOT_APPEAR" },
    ] }],
  }));
  const events = await eventsPromise;
  assert.equal(events.at(-1).type, "response.failed");
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0], /上游返回 400/);
  assert.match(diagnostics[0], /"type":"input_text"/);
  assert.doesNotMatch(diagnostics[0], /WEBSOCKET_PROMPT_MUST_NOT_APPEAR|custom-secret/);
});

test("自定义模型 WebSocket 成功连接中的失败事件仍记录脱敏请求结构", async (t) => {
  const upstream = await startHttpServer(t, async (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({
      type: "response.failed",
      response: { status: "failed", error: { message: "PRIVATE_UPSTREAM_ERROR" } },
    })}\n\n`);
  });
  const diagnostics = [];
  const originalError = console.error;
  console.error = (...values) => diagnostics.push(values.join(" "));
  t.after(() => { console.error = originalError; });
  const manager = new ModelRouterManager();
  t.after(() => manager.close());
  const config = await manager.configure(routerSettings(upstream.origin));
  const socketUrl = new URL("responses", config.baseUrl);
  socketUrl.protocol = "ws:";
  const socket = await openWebSocket(socketUrl);
  t.after(() => socket.terminate());
  const eventsPromise = collectWebSocket(socket, 1);
  socket.send(JSON.stringify({
    type: "response.create",
    model: "custom-model",
    stream_id: "failed-event-lane",
    generate: true,
    input: [{ type: "reasoning", id: "PRIVATE_REASONING_ID", content: [
      { type: "reasoning_text", text: "PRIVATE_REASONING_TEXT" },
    ] }],
  }));
  const events = await eventsPromise;
  assert.equal(events.at(-1).type, "response.failed");
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0], /上游响应失败/);
  assert.match(diagnostics[0], /"type":"reasoning_text"/);
  assert.match(diagnostics[0], /"keys":\["text","type"\]/);
  assert.doesNotMatch(diagnostics[0], /PRIVATE_UPSTREAM_ERROR|PRIVATE_REASONING_ID|PRIVATE_REASONING_TEXT|custom-secret/);
});
