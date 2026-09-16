import assert from "node:assert/strict";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";
import WebSocket, { WebSocketServer } from "ws";
import { ModelRouterManager, MODEL_ROUTER_TOKEN_HEADER } from "../src/model-router.mjs";
import { startHttpServer, waitFor, useTempDir, readJsonRequest } from "./helpers.mjs";
import { createServer } from "node:http";
import { join } from "node:path";
import { routerSettings, readRequestBuffer, openWebSocket, readEvents, collectWebSocket } from "./model-router/support.mjs";

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
  const inventory = usageEvents.find((event) => event.type === "request-tool-inventory");
  assert.deepEqual(inventory.tools, [{
    type: "mcp",
    name: null,
    namespace: null,
    serverLabel: "yuque",
  }]);
  assert.doesNotMatch(JSON.stringify(inventory), /call_1|ok/);
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
