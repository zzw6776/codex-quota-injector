import assert from "node:assert/strict";
import test from "node:test";
import { ModelRouterManager } from "../src/model-router.mjs";
import { readJsonRequest, startHttpServer } from "./helpers.mjs";
import { routerSettings } from "./model-router/support.mjs";

for (const delegationTool of ["create_thread", "send_message_to_thread"]) {
test(`自定义模型把 Codex ${delegationTool} 跨任务委托还原为用户消息且不掩盖其他孤立工具输出`, async (t) => {
  const received = [];
  const upstream = await startHttpServer(t, async (request, response) => {
    received.push(await readJsonRequest(request));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "resp_delegation", status: "completed", output: [] }));
  });
  const manager = new ModelRouterManager();
  t.after(() => manager.close());
  const config = await manager.configure(routerSettings(upstream.origin));
  const delegatedPrompt = "继续执行 DeepSeek 桌面验收。\n保留完整换行。";
  const orphanOutput = { type: "function_call_output", name: "other_tool", output: "orphan" };

  const response = await fetch(new URL("responses", config.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "custom-model",
      input: [
        {
          type: "function_call_output",
          id: "fco_delegation",
          name: delegationTool,
          namespace: "codex_app",
          output: [
            "<codex_delegation>",
            "  <source_thread_id>01a00000-0000-7000-8000-000000000000</source_thread_id>",
            `  <input>${delegatedPrompt}</input>`,
            "</codex_delegation>",
          ].join("\n"),
          internal_chat_message_metadata_passthrough: { turn_id: "private-turn" },
        },
        orphanOutput,
      ],
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(received[0].input[0], {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: delegatedPrompt }],
  });
  assert.deepEqual(received[0].input[1], orphanOutput,
    "非 Codex 跨任务委托的孤立工具输出必须保留，让上游继续暴露协议错误");
});
}

test("新建桌面任务的委托通过严格 Responses call_id 校验并保留原始输入", async (t) => {
  let received;
  const upstream = await startHttpServer(t, async (request, response) => {
    received = await readJsonRequest(request);
    const invalid = received.input.some(item => item.type === "function_call_output" && !item.call_id);
    response.writeHead(invalid ? 400 : 200, { "content-type": "application/json" });
    response.end(JSON.stringify(invalid ? { error: "missing field call_id" }
      : { id: "resp_create", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "accepted" }] }] }));
  });
  const manager = new ModelRouterManager();
  t.after(() => manager.close());
  const config = await manager.configure(routerSettings(upstream.origin));
  const input = "  执行准备命令\n保留缩进和换行  ";
  const response = await fetch(new URL("responses", config.baseUrl), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "custom-model", input: [{
      type: "function_call_output", id: "fco_create", name: "create_thread", namespace: "codex_app",
      output: `<codex_delegation>\n<source_thread_id>source-task</source_thread_id>\n<input>${input}</input>\n</codex_delegation>`,
    }] }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(received.input, [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }]);
  assert.equal((await response.json()).output[0].content[0].text, "accepted");
});
