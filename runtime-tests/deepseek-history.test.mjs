import assert from "node:assert/strict";
import test from "node:test";

import { customCall, message, reasoning, startRuntime } from "./support/offline-runtime.mjs";

function inputShape(body) {
  return (Array.isArray(body.input) ? body.input : []).map(item => ({
    type: item?.type ?? null,
    role: item?.role ?? null,
    phase: item?.phase ?? null,
    keys: Object.keys(item ?? {}).sort(),
    metadata: item?.internal_chat_message_metadata_passthrough == null
      ? null
      : Object.fromEntries(Object.entries(item.internal_chat_message_metadata_passthrough)
          .map(([key, value]) => [key, Array.isArray(value) ? `array:${value.length}` : typeof value])),
    content: Array.isArray(item?.content)
      ? item.content.map(part => part?.type ?? typeof part)
      : typeof item?.content,
  }));
}

function assertDeepSeekReasoningHistory(body) {
  const reasoningItems = body.input.filter(item => item?.type === "reasoning");
  assert.ok(reasoningItems.length > 0, "测试历史必须包含 DeepSeek reasoning 项");
  for (const item of reasoningItems) {
    assert.equal(item.summary, undefined, "DeepSeek 历史不支持 reasoning.summary");
    assert.equal(item.encrypted_content, undefined, "DeepSeek 历史不支持 reasoning.encrypted_content");
    assert.ok(item.content?.every(part => part.type === "reasoning_text"),
      "DeepSeek 支持的 reasoning_text 正文必须保留");
  }
}

test("[A MOD-03 SES-01 SES-02 SES-06] DeepSeek Responses 的恢复、分叉和压缩保留兼容历史", { timeout: 30_000 }, async t => {
  const r = await startRuntime(t, { profile: "deepseek" });
  r.enqueue(
    [reasoning("FIRST_PRIVATE_REASONING"),
      customCall("exec", 'text(await tools.exec_command({cmd:"/bin/echo FIRST_TOOL",login:false}));')],
    body => {
      assert.match(JSON.stringify(body.input), /FIRST_TOOL/);
      assertDeepSeekReasoningHistory(body);
      return [reasoning("TOOL_PRIVATE_REASONING"), message("FIRST_REPLY")];
    },
  );
  const { thread } = await r.thread();
  await r.turn(thread.id, "FIRST_INPUT");
  await r.rpc.request("thread/resume", { threadId: thread.id });
  await r.rpc.request("thread/settings/update", { threadId: thread.id, effort: "low", approvalPolicy: "never" });
  r.enqueue([reasoning("RESUME_PRIVATE_REASONING"), message("RESUMED_REPLY")]);
  await r.turn(thread.id, "RESUME_INPUT");
  const fork = await r.rpc.request("thread/fork", { threadId: thread.id, cwd: r.cwd });
  let forkRequest;
  r.enqueue(body => {
    forkRequest = structuredClone(body);
    assert.doesNotMatch(JSON.stringify(body.input), /internal_chat_message_metadata_passthrough/,
      "第三方 Responses 请求不能携带 Codex 私有历史元数据");
    assertDeepSeekReasoningHistory(body);
    return "FORK_REPLY";
  });
  await r.turn(fork.thread.id, "FORK_INPUT");
  t.diagnostic(`分叉请求结构 ${JSON.stringify(inputShape(forkRequest))}`);
  assert.ok(Array.isArray(forkRequest.input));
  assert.ok(forkRequest.input.some(item => item.role === "assistant"));
  assert.match(JSON.stringify(forkRequest.input), /FIRST_REPLY/);
  assert.match(JSON.stringify(forkRequest.input), /RESUMED_REPLY/);
  const toolCall = forkRequest.input.find(item => item.type === "custom_tool_call");
  const toolOutput = forkRequest.input.find(item => item.type === "custom_tool_call_output");
  assert.ok(toolCall, "分叉历史必须保留已执行的自定义工具调用");
  assert.ok(toolOutput, "分叉历史必须保留对应工具结果");
  assert.equal(toolOutput.call_id, toolCall.call_id, "工具结果必须仍能关联原调用");

  const compactAfter = r.rpc.events.length;
  r.enqueue(body => {
    const serialized = JSON.stringify(body.input);
    assert.doesNotMatch(serialized, /internal_chat_message_metadata_passthrough/,
      "压缩请求也不能携带 Codex 私有历史元数据");
    assertDeepSeekReasoningHistory(body);
    assert.match(serialized, /FORK_REPLY/);
    assert.equal(body.input.some(item => item.type === "compaction_trigger"), false,
      "第三方供应商必须使用本地摘要压缩，不能调用 OpenAI 私有压缩协议");
    return "DEEPSEEK_HISTORY_SUMMARY";
  });
  await r.rpc.request("thread/compact/start", { threadId: fork.thread.id });
  await r.rpc.event("turn/completed", params => params.threadId === fork.thread.id, { after: compactAfter });

  r.enqueue(body => {
    const serialized = JSON.stringify(body.input);
    assert.doesNotMatch(serialized, /internal_chat_message_metadata_passthrough/);
    assert.match(serialized, /DEEPSEEK_HISTORY_SUMMARY/);
    assert.doesNotMatch(serialized, /FIRST_PRIVATE_REASONING|TOOL_PRIVATE_REASONING|RESUME_PRIVATE_REASONING/,
      "本地压缩后不应再次发送已被摘要替代的推理正文");
    return "POST_COMPACT_REPLY";
  });
  const postCompact = await r.turn(fork.thread.id, "POST_COMPACT_INPUT");
  assert.ok(postCompact.items.some(item => item.type === "agentMessage" && item.text === "POST_COMPACT_REPLY"));
});
