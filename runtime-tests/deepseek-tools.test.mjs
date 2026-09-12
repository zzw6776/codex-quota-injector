import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { call, message, ROOT, startRuntime } from "./support/offline-runtime.mjs";

test("[A MOD-03 TOOL-03 INT-02] DeepSeek 直接工具模式向模型暴露并执行 MCP 命名空间", { timeout: 30_000 }, async t => {
  const r = await startRuntime(t, {
    profile: "deepseek",
    prepare: async ({ directory, env }) => {
      const configPath = join(env.CODEX_HOME, "config.toml");
      await writeFile(configPath, `${await readFile(configPath, "utf8")}
[mcp_servers.fixture]
command=${JSON.stringify(process.execPath)}
args=${JSON.stringify([join(ROOT, "runtime-tests/support/mcp-fixture.mjs"), directory])}
`);
    },
  });
  const marker = "DEEPSEEK_DIRECT_MCP";
  await writeFile(join(r.directory, "mcp-marker.txt"), marker);
  r.enqueue(
    body => {
      assert.equal(body.tools?.some(tool => tool.type === "tool_search"), false,
        "直接工具模式不能把 MCP 隐藏到延迟搜索后");
      const namespace = body.tools?.find(tool =>
        tool.type === "namespace" && tool.name === "mcp__fixture");
      assert.ok(namespace?.tools?.some(tool => tool.type === "function" && tool.name === "read"),
        "DeepSeek 首次请求必须直接包含 fixture.read 声明");
      return [{ ...call("read", {}), namespace: "mcp__fixture" }];
    },
    body => {
      assert.match(JSON.stringify(body.input), new RegExp(marker),
        "MCP 结果必须回灌给同一轮 DeepSeek 请求");
      return message(marker);
    },
  );

  const { thread } = await r.thread({ approvalPolicy: "never" });
  await r.turn(thread.id, "调用 fixture 的只读 read 工具一次");
  assert.equal(await readFile(join(r.directory, "mcp-marker.txt"), "utf8"), marker);
  assert.ok(r.rpc.events.some(event => event.method === "item/completed" &&
    event.params?.item?.type === "mcpToolCall" && event.params.item.server === "fixture" &&
    event.params.item.tool === "read" && event.params.item.status === "completed"));
});
