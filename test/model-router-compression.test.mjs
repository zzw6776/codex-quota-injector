import assert from "node:assert/strict";
import test from "node:test";
import { brotliCompressSync, deflateSync, gzipSync, zstdCompressSync } from "node:zlib";
import { ModelRouterManager } from "../src/model-router.mjs";
import { startHttpServer, readJsonRequest, useTempDir } from "./helpers.mjs";
import { join } from "node:path";
import { routerSettings, readRequestBuffer, readEvents } from "./model-router/support.mjs";

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
