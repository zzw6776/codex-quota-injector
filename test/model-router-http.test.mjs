import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { MODEL_ROUTER_TOKEN_HEADER, ModelRouterManager } from "../src/model-router.mjs";
import { readJsonRequest, startHttpServer, useTempDir, waitFor } from "./helpers.mjs";
import { routerSettings } from "./model-router/support.mjs";

test("Router 可在没有第三方模型时单独观察官方请求并记录生成明细", async (t) => {
  const directory = await useTempDir(t, "official-observer-");
  const usageEventPath = join(directory, "usage.jsonl");
  const upstream = await startHttpServer(t, async (request, response) => {
    assert.equal(request.url, "/v1/responses");
    assert.equal(request.headers.authorization, "Bearer sk-official-fixture");
    await readJsonRequest(request);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "resp_official_observer",
      status: "completed",
      output: [{ id: "msg-1", type: "message", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
    }));
  });
  const manager = new ModelRouterManager({ officialApiBaseUrl: `${upstream.origin}/v1/` });
  t.after(() => manager.close());
  const config = await manager.configure({
    deepSeek: { enabled: false, configured: false, apiKey: "" },
    extraModels: { platforms: [] },
    officialAuthMode: "apiKey",
    observeOfficial: true,
    usageEventPath,
  });
  assert.ok(config);
  assert.deepEqual(config.routedModels, []);

  const response = await fetch(new URL("responses", config.baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer sk-official-fixture",
      [MODEL_ROUTER_TOKEN_HEADER]: config.token,
      "turn-id": "turn-official-observer",
    },
    body: JSON.stringify({
      model: "official-model",
      input: "observe",
      client_metadata: { thread_id: "thread-official-observer" },
    }),
  });
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  await waitFor(async () => {
    try {
      return (await readFile(usageEventPath, "utf8")).includes('"type":"generation"');
    } catch {
      return false;
    }
  });
  const events = (await readFile(usageEventPath, "utf8")).trim()
    .split(/\r?\n/).map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.type === "generation" &&
    event.threadId === "thread-official-observer" &&
    event.turnId === "turn-official-observer" &&
    event.generation?.responseId === "resp_official_observer"));
});

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
