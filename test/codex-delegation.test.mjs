import assert from "node:assert/strict";
import test from "node:test";
import { readCodexDelegationInput } from "../src/codex-delegation.mjs";

test("委托解析覆盖两种桌面入口，并保留正文空白和嵌套标记", () => {
  const input = "  第一行\n<input>正文中的标签</input>  ";
  for (const name of ["create_thread", "send_message_to_thread"]) {
    for (const type of ["function_call_output", "functionCallOutput"]) {
      const output = `<codex_delegation><source_thread_id>source</source_thread_id><input>${input}</input></codex_delegation>`;
      for (const value of [output, { text: output, truncated: false }]) {
        assert.equal(readCodexDelegationInput({ name, type, namespace: "codex_app", output: value }), input);
      }
    }
  }
});

test("真实工具结果、普通输出、残缺委托不转换成用户输入", () => {
  const output = "<codex_delegation><source_thread_id>source</source_thread_id><input>request</input></codex_delegation>";
  const item = { name: "create_thread", type: "function_call_output", namespace: "codex_app", output };
  for (const value of [null, { ...item, call_id: "actual-tool-call" },
    { ...item, name: "other_tool" }, { ...item, namespace: "other" },
    { ...item, type: "message" }, { ...item, output: "normal result" },
    { ...item, output: output.replace("request", " \n ") },
    { ...item, output: output.replace(">source<", "> <") },
    { ...item, output: output.replace("</codex_delegation>", "") },
    { ...item, output: { text: output, truncated: true } },
  ]) assert.equal(readCodexDelegationInput(value), null);
  assert.equal(item.output, output);
});
