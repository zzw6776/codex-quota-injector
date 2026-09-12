import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { ModelRouterManager } from "../src/model-router.mjs";
import { json, readJsonRequest, startHttpServer, useTempDir, waitFor } from "./helpers.mjs";

async function startRouter(t, handler, { usageEventPath = null, chatCompatibility = false } = {}) {
  const upstream = await startHttpServer(t, handler);
  const manager = new ModelRouterManager({
    officialApiBaseUrl: `${upstream.origin}/official/v1/`,
    officialCodexBaseUrl: `${upstream.origin}/official/codex/`,
  });
  t.after(() => manager.close());
  const config = await manager.configure({
    deepSeek: { enabled: false }, officialAuthMode: "apiKey", usageEventPath,
    extraModels: { platforms: [{
      id: "fixture", name: "Fixture", enabled: true, apiKey: "fixture-custom-key", baseUrl: `${upstream.origin}/custom/v1/`,
      models: [{ id: "custom-model", displayName: "Custom", supportsImage: true, chatCompatibility,
        reasoningEfforts: ["low", "high"], defaultReasoningEffort: "low" }],
    }] },
  });
  const url = new URL("responses", config.baseUrl);
  const post = (body, task = "fixture") => fetch(url, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture-official-key",
      "x-codex-thread-id": task, "x-codex-turn-id": `${task}-turn` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(5_000),
  });
  return { post, url, manager };
}

test("NET-05 官方 HTTP 错误保留状态、响应头和原文，每次只发送一次且可继续请求", async (t) => {
  let requests = 0;
  const router = await startRouter(t, async (request, response) => {
    const body = await readJsonRequest(request);
    requests++;
    if (body.failStatus) {
      response.writeHead(body.failStatus, { "content-type": "application/json", "retry-after": "3", "x-request-id": `error-${body.failStatus}` });
      response.end(`{ "error": { "code": "fixture-${body.failStatus}", "details": [1,null] } }`);
    } else {
      json(response, { id: "healthy", status: "completed", output: [] });
    }
  });
  for (const status of [401, 403, 429, 500, 503]) {
    const before = requests;
    const response = await router.post({ model: "official", input: "check", failStatus: status });
    assert.equal(response.status, status);
    assert.equal(response.headers.get("retry-after"), "3");
    assert.equal(response.headers.get("x-request-id"), `error-${status}`);
    assert.equal(await response.text(), `{ "error": { "code": "fixture-${status}", "details": [1,null] } }`);
    assert.equal(requests, before + 1);
  }
  const healthy = await router.post({ model: "official", input: "next" });
  assert.equal(healthy.status, 200);
  assert.equal((await healthy.json()).id, "healthy");
});

test("MOD-03 两个并发任务逆序返回时保留各自供应商、输入、凭据和结果", async (t) => {
  const pending = [];
  const router = await startRouter(t, async (request, response) => {
    const body = await readJsonRequest(request);
    pending.push({ body, request, response });
    if (pending.length !== 2) return;
    for (const entry of pending.toReversed()) {
      json(entry.response, { id: entry.body.input, status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: entry.body.model }] }] });
    }
  });
  const responses = await Promise.all([
    router.post({ model: "official", input: "official-task", store: true }, "official-task"),
    router.post({ model: "custom-model", input: "custom-task", store: true }, "custom-task"),
  ]);
  assert.deepEqual(await Promise.all(responses.map((response) => response.json().then((body) => body.id))), ["official-task", "custom-task"]);
  const official = pending.find((entry) => entry.body.model === "official");
  const custom = pending.find((entry) => entry.body.model === "custom-model");
  assert.equal(official.request.url, "/official/v1/responses");
  assert.equal(official.request.headers.authorization, "Bearer fixture-official-key");
  assert.equal(official.body.store, true);
  assert.equal(custom.request.url, "/custom/v1/responses");
  assert.equal(custom.request.headers.authorization, "Bearer fixture-custom-key");
  assert.equal(custom.body.store, false);
});

test("NET-05 取消一个 Router 流只关闭对应上游，另一个并发任务继续返回结果", async (t) => {
  const connections = new Map();
  const router = await startRouter(t, async (request, response) => {
    const body = await readJsonRequest(request);
    const connection = { response, closed: false };
    connections.set(body.input, connection);
    response.on("close", () => { connection.closed = true; });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: body.input } })}\n\n`);
  });
  const open = async (id) => {
    const request = httpRequest(router.url, { method: "POST", headers: {
      "content-type": "application/json", authorization: "Bearer fixture-official-key", "x-codex-thread-id": id,
    } });
    request.on("error", () => {});
    t.after(() => request.destroy());
    request.end(JSON.stringify({ model: "official", input: id, stream: true }));
    const [response] = await once(request, "response");
    const received = [];
    response.setEncoding("utf8");
    response.on("data", (chunk) => received.push(chunk));
    return { response, received };
  };
  const [cancelled, continuing] = await Promise.all([open("cancelled"), open("continuing")]);
  cancelled.response.destroy();
  await waitFor(() => connections.get("cancelled")?.closed);
  assert.equal(connections.get("continuing").closed, false);
  const ended = once(continuing.response, "end");
  connections.get("continuing").response.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"continuing","status":"completed"}}\n\n');
  await ended;
  assert.match(continuing.received.join(""), /response.completed/);
});

test("OBS-02 用量存储不可写和观察到未知事件时，Router 仍原样返回完整 SSE", async (t) => {
  const directory = await useTempDir(t);
  const usageEventPath = join(directory, "usage-is-directory");
  await mkdir(usageEventPath);
  const raw = ': keepalive\n\ndata: invalid-observer-json\n\n' +
    'event: future.tool_event\ndata: {"type":"future.tool_event","payload":{"a":[null,false]}}\n\n' +
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"observable","status":"completed","usage":{"input_tokens":3,"output_tokens":2}}}\n\n';
  const router = await startRouter(t, async (request, response) => {
    await readJsonRequest(request);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(raw);
  }, { usageEventPath });
  for (let index = 0; index < 2; index++) {
    const response = await router.post({ model: "custom-model", input: "read", stream: true,
      client_metadata: { thread_id: `task-${index}`, turn_id: `turn-${index}` } }, `task-${index}`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), raw);
  }
  // Flush exercises the failed observation write while both API responses have survived.
  await router.manager.close();
});

test("NET-04 Router 与 Chat 代理组合完成工具调用和结果续接，并记录两次请求用量", async (t) => {
  const directory = await useTempDir(t);
  const usageEventPath = join(directory, "usage.jsonl");
  const requests = [];
  const router = await startRouter(t, async (request, response) => {
    const body = await readJsonRequest(request);
    requests.push({ url: request.url, body, authorization: request.headers.authorization });
    const followup = body.messages.some((message) => message.role === "tool");
    json(response, {
      id: followup ? "second" : "first", model: "custom-model",
      choices: [{ finish_reason: followup ? "stop" : "tool_calls", message: followup
        ? { role: "assistant", content: "result: fixture-content" }
        : { role: "assistant", content: null, tool_calls: [{ id: "fixture-call", type: "function", function: { name: "read", arguments: '{"path":"fixture.txt"}' } }] } }],
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    });
  }, { usageEventPath, chatCompatibility: true });
  const metadata = { thread_id: "combined-task", turn_id: "combined-turn" };
  const first = await (await router.post({ model: "custom-model", input: "read fixture", stream: false, client_metadata: metadata })).json();
  assert.equal(first.output[0].name, "read");
  const second = await router.post({ model: "custom-model", stream: false, previous_response_id: first.id, client_metadata: metadata,
    input: [{ type: "function_call_output", call_id: first.output[0].call_id, output: "fixture-content" }] });
  assert.equal((await second.json()).output[0].content[0].text, "result: fixture-content");
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.url === "/custom/v1/chat/completions" && request.authorization === "Bearer fixture-custom-key"));
  assert.equal(requests[1].body.messages[1].tool_call_id, "fixture-call");
  await router.manager.close();
  const recorded = (await readFile(usageEventPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const usage = recorded.filter((event) => event.type === "usage");
  assert.equal(usage.length, 2);
  assert.ok(usage.every((event) => event.threadId === "combined-task" && event.turnId === "combined-turn"));
  assert.deepEqual(usage.map((event) => event.tokenUsage.last.outputTokens), [3, 3]);
  assert.equal(usage.at(-1).tokenUsage.total.outputTokens, 6);
});
