import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { ModelRouterManager } from "../src/model-router.mjs";
import { GENERATION_METRICS_VERSION } from "../src/relay-contract.mjs";
import { readJsonRequest, startHttpServer, useTempDir } from "./helpers.mjs";
import { routerSettings, readEvents } from "./model-router/support.mjs";

test("Router 按请求 ID 聚合任意结构的非文字输出，并按引用关联每次工具耗时", async (t) => {
  let requestCount = 0;
  const upstream = await startHttpServer(t, async (request, response) => {
    const body = await readJsonRequest(request);
    requestCount += 1;
    if (requestCount === 1) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
      send({ type: "response.created", response: { id: "resp_tools" } });
      send({
        type: "response.in_progress",
        response: {
          id: "resp_tools",
          usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
        },
      });
      send({
        type: "response.output_item.done",
        item: { type: "future_action", id: "opaque_a", name: "first_tool" },
      });
      await new Promise((resolve) => setTimeout(resolve, 15));
      send({
        type: "response.output_item.done",
        item: { type: "another_action", id: "opaque_b", name: "second_tool" },
      });
      send({
        type: "response.completed",
        response: {
          id: "resp_tools",
          usage: { input_tokens: 5, output_tokens: 4, total_tokens: 9 },
        },
      });
      response.end();
      return;
    }
    assert.deepEqual(body.input, [
      { type: "opaque_result", call_id: "opaque_a", output: "a" },
      { type: "opaque_result", call_id: "opaque_b", output: "b" },
    ]);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "resp_final",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }],
      usage: { input_tokens: 6, output_tokens: 2, total_tokens: 8 },
    }));
  });
  const dataDir = await useTempDir(t);
  const usageEventPath = join(dataDir, "usage.jsonl");
  const manager = new ModelRouterManager();
  t.after(() => manager.close());
  const config = await manager.configure({
    ...routerSettings(upstream.origin),
    usageEventPath,
  });
  const post = (input) => fetch(new URL("responses", config.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "custom-model",
      input,
      client_metadata: { thread_id: "thread-tools", turn_id: "turn-tools" },
    }),
  });

  const toolResponse = await post("start");
  assert.equal(toolResponse.status, 200);
  await toolResponse.text();
  await new Promise((resolve) => setTimeout(resolve, 15));
  const finalResponse = await post([
    { type: "opaque_result", call_id: "opaque_a", output: "a" },
    { type: "opaque_result", call_id: "opaque_b", output: "b" },
  ]);
  assert.equal(finalResponse.status, 200);
  await finalResponse.text();

  await manager.close();
  const events = await readEvents(usageEventPath);
  const generations = events.filter((event) => event.type === "generation");
  const usageEvents = events.filter((event) => event.type === "usage");
  const timing = events.find((event) => event.type === "generation-tool-timing");
  assert.equal(generations.length, 2);
  assert.equal(usageEvents.length, 2);
  assert.deepEqual(usageEvents.map((event) => event.responseId), ["resp_tools", "resp_final"]);
  assert.equal(usageEvents[0].tokenUsage.last.totalTokens, 9);
  assert.equal(usageEvents[1].tokenUsage.total.totalTokens, 17);
  assert.equal(generations[0].generationMetricsVersion, GENERATION_METRICS_VERSION);
  assert.equal(generations[0].generation.responseId, "resp_tools");
  assert.equal(generations[1].generation.responseId, "resp_final");
  assert.equal(generations[0].generation.hasNonTextOutput, true);
  assert.deepEqual(generations[0].generation.toolNames, []);
  assert.equal(generations[1].generation.followsToolResult, true);
  assert.equal(generations[1].generation.hasVisibleText, true);
  assert.equal(timing.generationMetricsVersion, GENERATION_METRICS_VERSION);
  assert.equal(timing.requestId, generations[0].generation.requestId);
  assert.deepEqual(timing.toolTiming.toolNames, ["first_tool", "second_tool"]);
  assert.equal(timing.toolTiming.toolCount, 2);
  assert.ok(timing.toolTiming.readyLatencyMs >= 15);
  assert.equal(timing.toolTiming.calls.length, 2);
  assert.ok(timing.toolTiming.calls[0].durationMs > timing.toolTiming.calls[1].durationMs);
  assert.ok(timing.toolTiming.durationMs >= timing.toolTiming.calls[0].durationMs);
});

test("Router 按消息阶段记录文本耗时，并从输出项开始计算工具准备阶段", async (t) => {
  let requestCount = 0;
  const upstream = await startHttpServer(t, async (request, response) => {
    const body = await readJsonRequest(request);
    requestCount += 1;
    if (requestCount === 1) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
      send({ type: "response.created", response: { id: "resp_stages_tool" } });
      await new Promise((resolve) => setTimeout(resolve, 10));
      send({
        type: "response.output_item.added",
        item: { type: "message", id: "msg_commentary", role: "assistant", phase: "commentary", content: [] },
      });
      send({
        type: "response.output_text.delta",
        item_id: "msg_commentary",
        delta: "我先",
      });
      await new Promise((resolve) => setTimeout(resolve, 15));
      send({ type: "response.output_text.delta", item_id: "msg_commentary", delta: "检查。" });
      send({
        type: "response.output_text.done",
        item_id: "msg_commentary",
        text: "我先检查。",
      });
      send({
        type: "response.output_item.done",
        item: {
          type: "message",
          id: "msg_commentary",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "我先检查。" }],
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      send({
        type: "response.output_item.added",
        item: { type: "function_call", id: "fc_stage", call_id: "call_stage", name: "exec" },
      });
      await new Promise((resolve) => setTimeout(resolve, 15));
      send({
        type: "response.function_call_arguments.delta",
        item_id: "fc_stage",
        call_id: "call_stage",
        delta: "{\"cmd\":",
      });
      await new Promise((resolve) => setTimeout(resolve, 15));
      send({ type: "response.function_call_arguments.delta", item_id: "fc_stage", delta: "\"pwd\"}" });
      send({
        type: "response.output_item.done",
        item: {
          type: "function_call",
          id: "fc_stage",
          call_id: "call_stage",
          name: "exec",
          arguments: "{\"cmd\":\"pwd\"}",
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 15));
      send({
        type: "response.completed",
        response: {
          id: "resp_stages_tool",
          output: [
            {
              type: "message",
              id: "msg_commentary",
              role: "assistant",
              phase: "commentary",
              content: [{ type: "output_text", text: "我先检查。" }],
            },
            {
              type: "function_call",
              id: "fc_stage",
              call_id: "call_stage",
              name: "exec",
              arguments: "{\"cmd\":\"pwd\"}",
            },
          ],
          usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
        },
      });
      response.end();
      return;
    }
    assert.deepEqual(body.input, [
      { type: "function_call_output", call_id: "call_stage", output: "ok" },
    ]);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "resp_stages_final",
      status: "completed",
      output: [{
        type: "message",
        id: "msg_final",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "完成。" }],
      }],
      usage: { input_tokens: 6, output_tokens: 2, total_tokens: 8 },
    }));
  });
  const dataDir = await useTempDir(t);
  const usageEventPath = join(dataDir, "usage.jsonl");
  const manager = new ModelRouterManager();
  t.after(() => manager.close());
  const config = await manager.configure({ ...routerSettings(upstream.origin), usageEventPath });
  const post = (input) => fetch(new URL("responses", config.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "custom-model",
      input,
      client_metadata: { thread_id: "thread-stages", turn_id: "turn-stages" },
    }),
  });

  await (await post("start")).text();
  await new Promise((resolve) => setTimeout(resolve, 15));
  await (await post([
    { type: "function_call_output", call_id: "call_stage", output: "ok" },
  ])).text();
  await manager.close();

  const events = await readEvents(usageEventPath);
  const generations = events.filter((event) => event.type === "generation");
  assert.equal(generations.length, 2);
  assert.equal(generations[0].generation.textPhases.length, 1);
  assert.equal(generations[0].generation.textPhases[0].phase, "commentary");
  assert.ok(Number.isFinite(generations[0].generation.textPhases[0].startLatencyMs));
  assert.deepEqual(generations[1].generation.textPhases, [{
    phase: "final_answer",
    startLatencyMs: generations[1].generation.textPhases[0].startLatencyMs,
    durationMs: null,
  }]);

  const timing = events.find((event) => event.type === "generation-tool-timing");
  assert.ok(Number.isFinite(timing.toolTiming.preparationStartLatencyMs));
  assert.ok(Number.isFinite(timing.toolTiming.preparationDurationMs));
  assert.ok(
    generations[0].generation.textPhases[0].startLatencyMs +
      generations[0].generation.textPhases[0].durationMs <=
      timing.toolTiming.preparationStartLatencyMs,
  );
  assert.equal(
    timing.toolTiming.readyLatencyMs,
    timing.toolTiming.preparationStartLatencyMs + timing.toolTiming.preparationDurationMs,
  );
  assert.equal(
    timing.toolTiming.calls[0].preparationDurationMs,
    timing.toolTiming.preparationDurationMs,
  );
  assert.ok(Number.isFinite(timing.toolTiming.durationMs));
});
