import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { waitFor } from "./helpers.mjs";
import { startTestRelay } from "./relay-helper.mjs";

const catalogResponse = (id, cursor = null) => ({
  id, result: { data: [{ id: "official", model: "official", futureCapability: { enabled: true } }], nextCursor: cursor },
});
const modelIds = (message) => message.result.data.map((model) => model.id);

// RPC-02: Enumeration covers forwarding envelopes, not execution of every named feature.
test("协议清单中未改写的方法和通知保留双向外壳、未知字段与工具数据", async (t) => {
  const inventory = JSON.parse(await readFile(new URL("../docs/testing-protocol-inventory.json", import.meta.url), "utf8"));
  const relay = await startTestRelay(t);
  const observed = new Set(["model/list", "thread/start", "thread/resume", "thread/fork",
    "thread/read", "thread/list", "thread/settings/update", "turn/start", "turn/steer"]);
  const future = { nested: [null, false, 0, "中文 🧪", { result: { id: "embedded" } }] };
  let id = 100;
  for (const method of [...inventory.modes.experimental.ClientRequest.methods, "future/client/capability"]) {
    if (observed.has(method)) continue;
    const message = { jsonrpc: "2.0", id: id++, method, params: { future }, extension: future };
    await relay.send(message);
    assert.deepEqual(await relay.received(message.id), message, method);
  }
  for (const method of inventory.modes.experimental.ClientNotification.methods) {
    const message = { method, params: { future } };
    await relay.send(message);
    assert.deepEqual((await relay.take((entry) => entry.method === "fixture/received")).message.params.message, message);
  }
  for (const category of ["ServerRequest", "ServerNotification"]) {
    for (const method of [...inventory.modes.experimental[category].methods, `future/${category}`]) {
      const message = { ...(category === "ServerRequest" ? { id: `host-${id++}` } : {}), method, params: { future } };
      await relay.emit(message);
      assert.deepEqual((await relay.take((entry) => entry.method === method)).message, message, method);
    }
  }
});

test("RPC-03 宿主审批或工具回调与客户端请求使用相同 ID 时不吞掉模型列表响应", async (t) => {
  const relay = await startTestRelay(t);
  for (const [index, method] of ["item/tool/call", "item/commandExecution/requestApproval", "item/tool/requestUserInput"].entries()) {
    const id = index + 1;
    await relay.send({ id, method: "model/list", params: {} });
    await relay.received(id);
    const callback = { id, method, params: { threadId: "task", turnId: "turn", future: true } };
    await relay.emit(callback);
    assert.deepEqual((await relay.take((entry) => entry.method === method)).message, callback);
    const answer = { id, result: { decision: "decline", content: [{ type: "text", text: "tool-result" }] } };
    await relay.send(answer);
    assert.deepEqual(await relay.received(id), answer);
    await relay.emit(catalogResponse(id));
    const result = (await relay.take((entry) => entry.id === id && entry.result?.data)).message;
    assert.deepEqual(modelIds(result), ["official", "custom-a", "custom-b", "custom-c"]);
    assert.deepEqual(result.result.data[0].futureCapability, { enabled: true });
  }
});

test("RPC-02 RPC-03 INT-03 新增账号能力参数与设备验证往返保持完整", async (t) => {
  const relay = await startTestRelay(t);
  const usage = {
    id: "usage-capabilities",
    method: "account/rateLimits/read",
    params: { supportsLunaReserve: true, excludeResetCreditDetails: true },
  };
  await relay.send(usage);
  assert.deepEqual(await relay.received(usage.id), usage);

  const verification = {
    id: "verification-request",
    method: "mcpServer/elicitation/request",
    params: {
      threadId: "thread-verification",
      turnId: "turn-verification",
      serverName: "fixture",
      request: {
        mode: "openai/userVerification",
        title: "确认测试操作",
        description: "隔离协议材料",
        challenge: "dGVzdC1jaGFsbGVuZ2U",
      },
    },
  };
  await relay.emit(verification);
  assert.deepEqual((await relay.take(entry => entry.id === verification.id)).message, verification);
  const answer = {
    id: verification.id,
    result: { action: "accept", content: { credentialId: "fixture", signature: "fixture-signature" } },
  };
  await relay.send(answer);
  assert.deepEqual(await relay.received(answer.id), answer);
});

test("RPC-03 数字 ID 与同文本的字符串 ID 并发返回时分别匹配原请求", async (t) => {
  const relay = await startTestRelay(t);
  await relay.send({ id: 7, method: "model/list", params: {} });
  await relay.received(7);
  await relay.send({ id: "7", method: "model/list", params: { cursor: "page-2" } });
  await relay.received("7");
  await relay.emit(catalogResponse("7"));
  assert.deepEqual(modelIds((await relay.take((entry) => entry.id === "7")).message), ["official"]);
  await relay.emit(catalogResponse(7, "page-2"));
  const first = (await relay.take((entry) => entry.id === 7)).message;
  assert.deepEqual(modelIds(first), ["official", "custom-a", "custom-b", "custom-c"]);
  assert.equal(first.result.nextCursor, "page-2");
});

test("MOD-01 分页与错误响应不会注入重复模型，后续首屏仍可补齐目录", async (t) => {
  const relay = await startTestRelay(t);
  await relay.send({ id: "bad", method: "model/list", params: {} });
  await relay.received("bad");
  const failure = { id: "bad", error: { code: -32000, message: "temporary catalog failure", data: { retryable: true } } };
  await relay.emit(failure);
  assert.deepEqual((await relay.take((entry) => entry.id === "bad")).message, failure);
  for (const [id, cursor] of [["first", null], ["next", "page-2"]]) {
    await relay.send({ id, method: "model/list", params: { cursor } });
    await relay.received(id);
    await relay.emit(catalogResponse(id));
    assert.deepEqual(modelIds((await relay.take((entry) => entry.id === id)).message),
      cursor ? ["official"] : ["official", "custom-a", "custom-b", "custom-c"]);
  }
});

test("RPC-05 UTF-8 字节分片、CRLF 和大工具输出不损坏原文及未知字段", async (t) => {
  const relay = await startTestRelay(t);
  const input = { id: "中文", method: "future/read", params: { text: "中文 🧪" } };
  const bytes = Buffer.from(`${JSON.stringify(input)}\r\n`);
  for (const byte of bytes) await relay.sendRaw(Buffer.from([byte]));
  assert.deepEqual(await relay.received(input.id), input);
  const output = { method: "item/commandExecution/outputDelta", params: {
    threadId: "task", turnId: "turn", itemId: "command", delta: "中文 🧪\n".repeat(150_000), future: [1, null],
  } };
  const raw = JSON.stringify(output);
  await relay.emitRaw(`${raw}\r\n`, 8191);
  assert.equal((await relay.take((entry) => entry.method === output.method)).raw, raw);
});

test("RPC-04 大历史响应按顶层模型学习上下文，不把历史条目里的 model 当作当前设置", async (t) => {
  const relay = await startTestRelay(t);
  for (const [index, id] of ["plain", 'resume-"quoted"'].entries()) {
    const threadId = `history-${index}`;
    await relay.send({ id, method: "thread/resume", params: { threadId } });
    await relay.received(id);
    const response = { ...(index ? { jsonrpc: "2.0" } : {}), id, result: {
      thread: { id: threadId, turns: [{ model: "official", text: "旧历史".repeat(400_000) }] },
      model: "custom-b", modelProvider: "custom_fixture",
    } };
    await relay.emit(response);
    assert.deepEqual((await relay.take((entry) => entry.id === id)).message, response);
    await relay.send({ id: `after-${id}`, method: "turn/start", params: { threadId, input: [], effort: "low", summary: "detailed" } });
    const request = await relay.received(`after-${id}`);
    assert.equal(request.params.effort, "low");
    assert.equal("summary" in request.params, false, "后续请求按恢复出的自定义模型规则处理");
    await waitFor(async () => (await relay.events().catch(() => [])).some((event) =>
      event.type === "thread-active" && event.threadId === threadId && event.model === "custom-b"));
  }
});

test("SES-01 新建、恢复和分叉均从官方响应外层学习模型，保留原有权限和工作目录", async (t) => {
  const relay = await startTestRelay(t);
  for (const method of ["thread/start", "thread/resume", "thread/fork"]) {
    const params = { ...(method === "thread/start" ? {} : { threadId: "source" }),
      cwd: relay.directory, approvalPolicy: "never", sandbox: "read-only", future: { allowed: false } };
    await relay.send({ id: method, method, params });
    assert.deepEqual((await relay.received(method)).params, params);
    const threadId = `${method}-result`;
    const response = { id: method, result: { thread: { id: threadId, turns: [] },
      model: "custom-a", modelProvider: method === "thread/fork" ? "openai" : "custom_fixture",
      cwd: relay.directory, future: { keep: true } } };
    await relay.emit(response);
    assert.deepEqual((await relay.take((entry) => entry.id === method)).message, response);
    await relay.send({ id: `turn-${method}`, method: "turn/start", params: { threadId, input: [], summary: "detailed" } });
    const turn = await relay.received(`turn-${method}`);
    assert.equal(turn.params.effort, "low");
    assert.equal("summary" in turn.params, false);
  }
});

test("MOD-03 SES-01 重启后先恢复 DeepSeek 任务不会污染既有官方任务", async (t) => {
  const relay = await startTestRelay(t, { deepSeekEnabled: true });
  await relay.send({ id: "discover", method: "thread/list", params: {} });
  await relay.received("discover");
  await relay.emit({ id: "discover", result: { data: [
    { id: "deepseek-task", model: "deepseek-v4-flash", modelProvider: "deepseek" },
    { id: "sol-task", model: "official", modelProvider: "openai" },
  ] } });
  await relay.take((entry) => entry.id === "discover");

  await relay.send({ id: "resume-deepseek", method: "thread/resume", params: {
    threadId: "deepseek-task",
  } });
  const deepSeekResume = await relay.received("resume-deepseek");
  assert.equal(deepSeekResume.params.model, "deepseek-v4-flash");
  assert.equal(deepSeekResume.params.modelProvider, "deepseek");
  await relay.emit({ id: "resume-deepseek", result: {
    thread: { id: "deepseek-task", turns: [] },
    model: "deepseek-v4-flash",
    modelProvider: "deepseek",
  } });
  await relay.take((entry) => entry.id === "resume-deepseek");

  await relay.send({ id: "resume-sol", method: "thread/resume", params: {
    threadId: "sol-task",
  } });
  const solResume = await relay.received("resume-sol");
  assert.equal(solResume.params.model, "official");
  assert.equal(solResume.params.modelProvider, "openai");

  // 模拟旧 app-server 在恢复响应中回报了上一任务的模型；中继不能据此污染已钉住的任务。
  await relay.emit({ id: "resume-sol", result: {
    thread: { id: "sol-task", turns: [] },
    model: "deepseek-v4-flash",
    modelProvider: "deepseek",
  } });
  await relay.take((entry) => entry.id === "resume-sol");
  await relay.send({ id: "turn-sol", method: "turn/start", params: {
    threadId: "sol-task", input: [],
  } });
  const solTurn = await relay.received("turn-sol");
  assert.equal(solTurn.params.model, "official");
});

test("MOD-03 SES-02 分叉响应回报默认官方模型时仍继承已选第三方供应商", async (t) => {
  const relay = await startTestRelay(t);
  await relay.send({ id: "start-extension", method: "thread/start", params: { model: "custom-a" } });
  const start = await relay.received("start-extension");
  assert.equal(start.params.modelProvider, "custom_fixture");
  await relay.emit({ id: "start-extension", result: {
    thread: { id: "source-extension", turns: [] },
    model: "gpt-default", modelProvider: "openai",
  } });
  await relay.take((entry) => entry.id === "start-extension");

  await relay.send({ id: "fork-extension", method: "thread/fork", params: {
    threadId: "source-extension", cwd: relay.directory,
  } });
  const fork = await relay.received("fork-extension");
  assert.equal(fork.params.model, "custom-a");
  assert.equal(fork.params.modelProvider, "custom_fixture");
  await relay.emit({ id: "fork-extension", result: {
    thread: { id: "forked-extension", turns: [] },
    model: "gpt-default", modelProvider: "openai",
  } });
  await relay.take((entry) => entry.id === "fork-extension");

  await relay.send({ id: "fork-turn", method: "turn/start", params: {
    threadId: "forked-extension", input: [], summary: "detailed",
  } });
  const turn = await relay.received("fork-turn");
  assert.equal(turn.params.model, "custom-a");
  assert.equal(turn.params.effort, "low");
  assert.equal("summary" in turn.params, false);
});

test("MOD-05 设置更新的迟到失败不回滚较新模型，轮次仍使用各自模型", async (t) => {
  const relay = await startTestRelay(t);
  await relay.send({ id: "start", method: "thread/start", params: { model: "custom-a" } });
  await relay.received("start");
  await relay.emit({ id: "start", result: { thread: { id: "task" }, model: "custom-a", modelProvider: "custom_fixture" } });
  await relay.take((entry) => entry.id === "start");
  for (const [id, model] of [["old", "custom-b"], ["new", "custom-c"]]) {
    await relay.send({ id, method: "thread/settings/update", params: { threadId: "task", threadSettings: { model } } });
    await relay.received(id);
  }
  await relay.emit({ id: "new", result: {} });
  await relay.take((entry) => entry.id === "new");
  await relay.emit({ id: "old", error: { code: -32000, message: "late failure" } });
  await relay.take((entry) => entry.id === "old");
  await relay.send({ id: "turn", method: "turn/start", params: { threadId: "task", input: [] } });
  await relay.received("turn");
  await waitFor(async () => (await relay.events().catch(() => [])).some((event) =>
    event.type === "thread-active" && event.threadId === "task" && event.model === "custom-c"));
});

test("OBS-02 用量文件不可写时仍转发工具通知和后续请求，并留下写入错误", async (t) => {
  const relay = await startTestRelay(t, { usagePathIsDirectory: true });
  const usage = { method: "thread/tokenUsage/updated", params: {
    threadId: "task", turnId: "turn", tokenUsage: { inputTokens: 10, outputTokens: 2 },
  } };
  await relay.emit(usage);
  assert.deepEqual((await relay.take((entry) => entry.method === usage.method)).message, usage);
  await waitFor(() => relay.stderr().includes("记录 Token 用量事件失败"));
  const continuation = { id: "continue", method: "turn/steer", params: { threadId: "task", input: [{ type: "text", text: "continue" }] } };
  await relay.send(continuation);
  assert.deepEqual(await relay.received("continue"), continuation);
});
