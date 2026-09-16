import assert from "node:assert/strict";
import test from "node:test";
import { ModelRouterManager } from "../src/model-router.mjs";
import { startHttpServer } from "./helpers.mjs";
import { routerSettings } from "./model-router/support.mjs";

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
