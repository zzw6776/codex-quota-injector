import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import { request as httpRequest } from "node:http";
import { WebSocketServer } from "ws";
import { ModelRouterManager } from "../src/model-router.mjs";
import { startHttpServer, useTempDir, waitFor } from "./helpers.mjs";
import { readRequestBuffer, routerSettings, openWebSocket, collectWebSocket } from "./model-router/support.mjs";

async function fixture(t, handler, custom = false) {
  const upstream = await startHttpServer(t, handler);
  const directory = await useTempDir(t);
  const manager = new ModelRouterManager({
    officialApiBaseUrl: `${upstream.origin}/v1/`,
    fullRequestDiagnostics: true,
    log() {},
  });
  t.after(() => manager.close());
  const config = await manager.configure({
    ...(custom ? routerSettings(upstream.origin) : { observeOfficial: true, officialAuthMode: "apiKey" }),
    usageEventPath: join(directory, "usage.jsonl"),
  });
  const path = join(directory, "model-request-diagnostics.jsonl");
  const events = async () => (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
  return { upstream, manager, config, path, events };
}

function rawResponse(events) {
  return Buffer.concat(events.filter(e => e.phase === "body-chunk" && e.direction === "response")
    .map(e => Buffer.from(e.dataBase64, "base64")));
}

test("全量请求日志默认关闭，普通用量路径不会隐式创建敏感日志", async t => {
  const upstream = await startHttpServer(t, async (_request, response) => {
    response.writeHead(200, { "content-type": "application/json",
      "x-codex-turn-state": "s".repeat(292) });
    response.end(JSON.stringify({ id: "resp_default_off", status: "completed", output: [] }));
  });
  const directory = await useTempDir(t);
  const manager = new ModelRouterManager({ officialApiBaseUrl: `${upstream.origin}/v1/`, log() {} });
  t.after(() => manager.close());
  const config = await manager.configure({
    observeOfficial: true,
    officialAuthMode: "apiKey",
    usageEventPath: join(directory, "usage.jsonl"),
  });
  const response = await fetch(new URL("responses", config.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: "not persisted",
      client_metadata: { thread_id: "thread-default-off", turn_id: "turn-default-off" } }),
  });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(manager.getTurnStateViewModel("thread-default-off").status, "match",
    "轻量 292 状态不得依赖全量日志");
  await manager.close();
  await assert.rejects(readFile(join(directory, "model-request-diagnostics.jsonl"), "utf8"),
    { code: "ENOENT" });
});

for (const status of [200, 292, 312, 429, 500]) {
  test(`全量请求日志保留 HTTP ${status} 的正文、凭据、Cookie、state 和实际响应码`, async t => {
    const responseBody = JSON.stringify({ current_turn_state: "response-state-secret",
      error: { code: status, message: "private upstream body" } });
    let received;
    const f = await fixture(t, async (request, response) => {
      received = await readRequestBuffer(request);
      response.writeHead(status, { "content-type": "application/json", "set-cookie": "sid=response-secret",
        "x-request-id": `request-${status}` });
      response.end(responseBody);
    });
    const body = { model: "gpt-6-astra", input: "private prompt", current_turn_state: "request-state-secret",
      client_metadata: { thread_id: "thread-log", turn_id: "turn-log" } };
    const response = await fetch(new URL("responses?private=query-value", f.config.baseUrl), {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/json", authorization: "Bearer secret-key", cookie: "sid=request-secret" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, status);
    assert.equal(await response.text(), responseBody);
    await f.manager.close();
    const events = await f.events();
    const start = events.find(e => e.phase === "request");
    assert.deepEqual(start.body, body);
    assert.deepEqual(Buffer.from(start.bodyBase64, "base64"), received);
    assert.equal(start.headers.authorization, "Bearer secret-key");
    assert.equal(start.headers.cookie, "sid=request-secret");
    assert.ok(start.url.endsWith("?private=query-value"));
    assert.equal(start.threadId, "thread-log");
    assert.equal(start.turnId, "turn-log");
    assert.equal(start.model, "gpt-6-astra");
    assert.equal(new Set(events.map(e => e.requestId)).size, 1);
    const headers = events.find(e => e.phase === "response-headers");
    assert.equal(headers.httpStatusCode, status);
    assert.deepEqual(headers.headers["set-cookie"], ["sid=response-secret"]);
    assert.equal(rawResponse(events).toString(), responseBody);
    const end = events.find(e => e.phase === "finished");
    assert.equal(end.httpStatusCode, status);
    assert.deepEqual(end.responseStateFields, ["current_turn_state"]);
    assert.deepEqual(end.envelopeCodes, [{ field: "error.code", value: status }]);
    assert.equal(end.bodyInspection, "parsed");
    if (process.platform !== "win32") assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  });
}

test("无任务 ID 的 models 请求、压缩二进制响应也完整记录，摘要不把正文中的 292 当状态", async t => {
  const payload = gzipSync(Buffer.from(JSON.stringify({ data: [{ id: "model" }], text: "292 current_turn_state" })));
  const f = await fixture(t, async (_request, response) => {
    response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
    response.end(payload);
  });
  const response = await fetch(new URL("models", f.config.baseUrl));
  assert.deepEqual(await response.json(), JSON.parse(gunzipSync(payload)));
  await f.manager.close();
  const events = await f.events();
  assert.equal(events[0].threadId, null);
  assert.equal(events[0].method, "GET");
  assert.equal(events[0].endpoint, "/v1/models");
  assert.deepEqual(rawResponse(events), payload);
  assert.deepEqual(events.at(-1).responseStateFields, []);
  assert.deepEqual(events.at(-1).envelopeCodes, []);
});

test("压缩请求同时保留原始字节和解码正文，连接错误不伪造上游 HTTP 状态", async t => {
  let received;
  const f = await fixture(t, async (request, response) => {
    received = await readRequestBuffer(request);
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"id":"resp_compressed","output":[]}');
  });
  const body = { model: "gpt-6-astra", input: "压缩正文", current_turn_state: "full-state" };
  const compressed = gzipSync(Buffer.from(JSON.stringify(body)));
  const response = await fetch(new URL("responses", f.config.baseUrl), {
    method: "POST", headers: { "content-type": "application/json", "content-encoding": "gzip" }, body: compressed,
  });
  await response.text();
  await new Promise(resolve => f.upstream.server.close(resolve));
  const failed = await fetch(new URL("models", f.config.baseUrl));
  assert.equal(failed.status, 502);
  await failed.text();
  await f.manager.close();
  const events = await f.events();
  assert.deepEqual(events[0].body, body);
  assert.deepEqual(Buffer.from(events[0].bodyBase64, "base64"), compressed);
  assert.deepEqual(received, compressed);
  const failure = events.find(e => e.phase === "finished" && e.outcome === "request-error");
  assert.ok(failure);
  assert.equal(failure.httpStatusCode, null);
});

test("超过摘要检查上限的 SSE 正文仍逐字节完整落盘，后续 state 仍能检查", async t => {
  const payload = `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "x".repeat(300_000) })}\n\n` +
    `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_large",
      status: "completed", current_turn_state: "state-at-end" } })}\n\n`;
  const f = await fixture(t, async (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (let i = 0; i < payload.length; i += 8192) response.write(payload.slice(i, i + 8192));
    response.end();
  });
  const response = await fetch(new URL("responses", f.config.baseUrl), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-6-astra", input: "private" }),
  });
  assert.equal(await response.text(), payload);
  await f.manager.close();
  const events = await f.events();
  assert.equal(rawResponse(events).toString(), payload);
  const end = events.find(e => e.phase === "finished");
  assert.equal(end.bodyInspection, "partial");
  assert.deepEqual(end.responseStateFields, ["response.current_turn_state"]);
});

test("WebSocket 握手 101 与逐请求预热/生成分开记录，完整保留双向消息", async t => {
  const f = await fixture(t, async (_request, response) => response.end());
  const wss = new WebSocketServer({ server: f.upstream.server });
  t.after(() => { for (const s of wss.clients) s.terminate(); wss.close(); });
  const replies = [];
  wss.on("connection", socket => socket.on("message", raw => {
    const body = JSON.parse(raw);
    const metadata = JSON.stringify({ type: "codex.response.metadata", stream_id: body.stream_id,
      headers: { "x-codex-turn-state": "s".repeat(292) } });
    const reply = JSON.stringify({ type: "response.completed", stream_id: body.stream_id,
      response: { id: `resp_${body.stream_id}`, model: body.model, status: "completed",
        current_turn_state: `secret_${body.stream_id}`, output: [{ text: "private answer" }] } });
    replies.push(metadata, reply);
    socket.send(metadata);
    socket.send(reply);
  }));
  const url = new URL("responses", f.config.baseUrl); url.protocol = "ws:";
  const socket = await openWebSocket(url, { headers: { authorization: "Bearer ws-secret", cookie: "ws-cookie" } });
  t.after(() => socket.terminate());
  const done = collectWebSocket(socket, 2);
  for (const lane of ["warm", "generate"]) socket.send(JSON.stringify({
    type: "response.create", model: "gpt-6-astra", stream_id: lane, generate: lane !== "warm",
    input: "private request", current_turn_state: "private state",
    client_metadata: { thread_id: "thread-ws", turn_id: `turn-${lane}` },
  }));
  await done;
  assert.deepEqual(f.manager.getTurnStateViewModel("thread-ws"), {
    status: "match", expectedByteLength: 292, byteLength: 292,
    model: "gpt-6-astra", observedAt: f.manager.getTurnStateViewModel("thread-ws").observedAt,
  });
  assert.ok(Number.isFinite(f.manager.getTurnStateViewModel("thread-ws").observedAt));
  await f.manager.close();
  const events = await f.events();
  const handshake = events.find(e => e.transport === "websocket-handshake" && e.phase === "response-headers");
  assert.equal(handshake.httpStatusCode, 101);
  assert.ok(events.some(e => e.phase === "request-headers" && e.headers["sec-websocket-key"]));
  const requests = events.filter(e => e.transport === "websocket" && e.phase === "request");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(e => e.turnId), ["turn-warm", "turn-generate"]);
  assert.ok(requests.every(e => e.connectionId === handshake.connectionId));
  assert.ok(requests.every(e => JSON.parse(Buffer.from(e.bodyBase64, "base64")).current_turn_state === "private state"));
  const ends = events.filter(e => e.transport === "websocket" && e.phase === "finished");
  assert.equal(ends.length, 2);
  assert.ok(ends.every(e => e.httpStatusCode === null));
  assert.deepEqual(ends.map(e => e.responseId), ["resp_warm", "resp_generate"]);
  assert.ok(ends.every(e => e.responseStates.some(state => state.field === "headers.x-codex-turn-state" &&
    state.byteLength > 0 && /^[a-f0-9]{64}$/.test(state.sha256))));
  const raw = events.filter(e => e.phase === "body-chunk" && e.direction === "response");
  assert.deepEqual(raw.map(e => Buffer.from(e.dataBase64, "base64").toString()), replies);
});

test("WebSocket 被 312 拒绝时保留真实握手码，仍触发原有关闭而不会挂住", async t => {
  const f = await fixture(t, async (_request, response) => {
    response.writeHead(312, { "content-type": "application/json" });
    response.end(JSON.stringify({ current_turn_state: "rejected-state" }));
  });
  const url = new URL("responses", f.config.baseUrl); url.protocol = "ws:";
  const socket = await openWebSocket(url);
  t.after(() => socket.terminate());
  socket.send(JSON.stringify({ type: "response.create", model: "gpt-6-astra" }));
  await waitFor(() => socket.readyState === 3);
  await f.manager.close();
  const events = await f.events();
  assert.ok(events.some(e => e.phase === "response-headers" && e.httpStatusCode === 312));
  assert.ok(events.some(e => e.phase === "error" && /312/.test(e.message)));
});

test("自定义 WebSocket 的 HTTP 桥记录实际供应商密钥与重写后的请求", async t => {
  let received;
  const f = await fixture(t, async (request, response) => {
    received = { headers: request.headers, body: await readRequestBuffer(request) };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "resp_custom", status: "completed", output: [], current_turn_state: "custom-state" }));
  }, true);
  const url = new URL("responses", f.config.baseUrl); url.protocol = "ws:";
  const socket = await openWebSocket(url);
  t.after(() => socket.terminate());
  const done = collectWebSocket(socket, 1);
  socket.send(JSON.stringify({ type: "response.create", model: "custom-model", input: "custom prompt" }));
  await done;
  await f.manager.close();
  const events = await f.events();
  const request = events.find(e => e.phase === "request");
  assert.equal(request.transport, "websocket-http-bridge");
  assert.equal(request.headers.authorization, received.headers.authorization);
  assert.equal(request.headers.authorization, "Bearer custom-secret");
  assert.deepEqual(Buffer.from(request.bodyBase64, "base64"), received.body);
  assert.equal(JSON.parse(rawResponse(events)).current_turn_state, "custom-state");
});

test("客户端中止流时保留已收到的原文，并标记未完整结束", async t => {
  const f = await fixture(t, async (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"current_turn_state":"partial-state"}\n\n');
  });
  await new Promise((resolve, reject) => {
    const request = httpRequest(new URL("responses", f.config.baseUrl), {
      method: "POST", headers: { "content-type": "application/json" },
    }, response => response.once("data", () => { response.destroy(); resolve(); }));
    request.once("error", reject);
    request.end(JSON.stringify({ model: "gpt-6-astra", input: "test" }));
  });
  await waitFor(async () => (await f.events().catch(() => [])).some(e => e.phase === "finished"));
  await f.manager.close();
  const events = await f.events();
  assert.match(rawResponse(events).toString(), /partial-state/);
  assert.notEqual(events.find(e => e.phase === "finished").outcome, "end");
});
