import assert from "node:assert/strict";
import test from "node:test";
import { ModelRouterManager } from "../src/model-router.mjs";
import { startHttpServer } from "./helpers.mjs";
import { routerSettings, openWebSocket, collectWebSocket } from "./model-router/support.mjs";

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
