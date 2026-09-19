import assert from "node:assert/strict";
import test from "node:test";
import { analyzeStateLifecycle } from "../src/model-router/state-lifecycle-analysis.mjs";

test("state 生命周期分析区分 HTTP 状态、响应 state、回传和换回合且不输出原值", () => {
  const stateA = "state-a";
  const stateB = "state-b";
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64");
  const common = { type: "model-request-diagnostic", version: 2, connectionId: "connection-1" };
  const records = [
    { ...common, line: 1, phase: "request", requestId: "request-a", transport: "websocket",
      method: "response.create", threadId: "thread-1", turnId: "turn-1", model: "gpt-5.6-sol",
      sourceFile: "part-1.jsonl", body: { type: "response.create", model: "gpt-5.6-sol",
        client_metadata: { turn_id: "turn-1" } } },
    { ...common, line: 2, phase: "request", requestId: "handshake", transport: "websocket-handshake",
      method: "GET", threadId: null, turnId: null, model: null, body: null },
    { ...common, line: 3, phase: "request-headers", requestId: "handshake", transport: "websocket-handshake",
      headers: { "x-codex-turn-state": stateA } },
    { ...common, line: 4, phase: "response-headers", requestId: "handshake", transport: "websocket-handshake",
      httpStatusCode: 101, headers: {} },
    { ...common, line: 5, phase: "body-chunk", requestId: "handshake", transport: "websocket-handshake",
      direction: "response", dataBase64: encode({ type: "codex.response.metadata", headers: { "x-codex-turn-state": stateA } }) },
    { ...common, line: 5, phase: "body-chunk", requestId: "handshake", transport: "websocket-handshake",
      direction: "response", dataBase64: encode({ type: "response.progress", metadata: { code: 292 } }) },
    { ...common, line: 6, phase: "body-chunk", requestId: "handshake", transport: "websocket-handshake",
      direction: "response", dataBase64: encode({ type: "response.completed", response: { status: "completed" } }) },
    { ...common, line: 7, phase: "request", requestId: "request-b", transport: "http", method: "POST",
      threadId: "thread-1", turnId: "turn-2", model: "gpt-5.6-sol", headers: { "x-codex-turn-state": stateB },
      body: { model: "gpt-5.6-sol" } },
    { ...common, connectionId: null, line: 8, phase: "response-headers", requestId: "request-b", transport: "http",
      httpStatusCode: 312, headers: { current_turn_state: stateB } },
  ];
  const result = analyzeStateLifecycle(records, { threadId: "thread-1" });
  assert.deepEqual(result.httpStatuses, { 101: 1, 312: 1 });
  assert.equal(result.http292Count, 0);
  assert.equal(result.http312Count, 1);
  assert.deepEqual(result.protocol292Or312.map(item => item.value), [292]);
  assert.equal(result.requestCount, 2);
  assert.equal(result.requests[0].sourceFile, "part-1.jsonl");
  assert.equal(result.turns[0].replayObserved, false);
  assert.equal(result.turns[1].replayObserved, true);
  assert.equal(result.responseStateCount, 2);
  assert.doesNotMatch(JSON.stringify(result), /state-a|state-b/);
  assert.ok(result.distinctResponseStateHashes.every(hash => /^[a-f0-9]{64}$/.test(hash)));
});
