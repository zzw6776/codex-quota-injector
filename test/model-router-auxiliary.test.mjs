import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ModelRouterManager } from "../src/model-router.mjs";
import { startHttpServer, useTempDir } from "./helpers.mjs";
import { routerSettings, readRequestBuffer } from "./model-router/support.mjs";

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
