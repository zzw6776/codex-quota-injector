import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ROOT, startRuntime } from "./support/offline-runtime.mjs";
import { waitFor } from "../test/helpers.mjs";
import { successfulHostToolResult } from "../test/host-tool-fixtures.mjs";
import { readInstanceJson } from "../test/relay-instance-fixtures.mjs";

// The MCP transport is a fixture; read_thread delegates to this same official
// app-server's real history API. It cannot invent a readable task or a success.
for (const profile of ["direct", "shim"]) {
  test(`[LCH-04 TOOL-04] ${profile} 首条消息前真实历史不可读，用户消息后恢复`, { timeout: 30_000 }, async t => {
    let runtime;
    const reads = [];
    const bridge = createServer(async (request, response) => {
      const threadId = new URL(request.url, "http://localhost").searchParams.get("threadId");
      let result;
      try {
        const history = await runtime.rpc.request("thread/turns/list", { threadId, limit: 1 });
        result = { content: [{ type: "text", text: JSON.stringify({ thread: { id: threadId }, turns: history.data }) }] };
        reads.push({ passed: true, turns: history.data.length });
      } catch (error) {
        result = { isError: true, content: [{ type: "text", text: error.message }] };
        reads.push({ passed: false, detail: error.message });
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    });
    bridge.listen(0, "127.0.0.1"); await once(bridge, "listening");
    t.after(() => new Promise(resolve => { bridge.close(resolve); bridge.closeAllConnections(); }));
    const endpoint = `http://127.0.0.1:${bridge.address().port}/`;
    runtime = await startRuntime(t, { profile, prepare: async ({ directory, env }) => {
      const source = await readFile(join(ROOT, "runtime-tests/support/mcp-fixture.mjs"), "utf8");
      const fixture = source
        .replace('["record", "read", "fail", "ask"]', '["list_threads", "read_thread", "list_projects", "get_usage_limits"]')
        .replace('if (name === "record") {', `if (name === "read_thread") {
          const url = new URL(${JSON.stringify(endpoint)}); url.searchParams.set("threadId", args.threadId);
          return reply(value.id, await (await fetch(url)).json());
        }
        if (["list_threads", "list_projects", "get_usage_limits"].includes(name)) {
          return reply(value.id, (${successfulHostToolResult.toString()})(name, args.threadId));
        }
        if (name === "record") {`);
      const path = join(directory, "history-mcp.mjs");
      await writeFile(path, fixture);
      const config = join(env.CODEX_HOME, "config.toml");
      await writeFile(config, await readFile(config, "utf8") + `\n[mcp_servers.codex_app]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([path, directory])}\n`);
    } });
    const { thread } = await runtime.thread();
    await runtime.rpc.event("mcpServer/startupStatus/updated", p => p.name === "codex_app" && p.status === "ready" && p.threadId === thread.id);
    const readTool = () => runtime.rpc.request("mcpServer/tool/call", {
      threadId: thread.id, server: "codex_app", tool: "read_thread", arguments: { threadId: thread.id },
    });
    const health = () => readInstanceJson(join(runtime.directory, "host-health.json"));
    if (profile === "direct") assert.equal((await readTool()).isError, true);
    else await waitFor(async () => (await health()).code === "awaiting-first-user-message");
    assert.equal(reads.length, 1);
    assert.match(reads[0].detail, /is not materialized yet/);

    // Hold the assistant response until history has recovered. Recovery must
    // follow the user message and must not depend on turn/completed.
    let release;
    const responseGate = new Promise(resolve => { release = resolve; });
    runtime.enqueue(async () => { await responseGate; return "OFFLINE_MATERIALIZATION_OK"; });
    const started = await runtime.rpc.request("turn/start", { threadId: thread.id,
      input: [{ type: "text", text: "offline materialization check" }] });
    try {
      await runtime.rpc.event("item/completed", p => p.threadId === thread.id && p.item?.type === "userMessage");
      if (profile === "direct") assert.notEqual((await readTool()).isError, true);
      else {
        const recovered = await waitFor(async () => {
          const value = await health(); return value.toolsVerified ? value : null;
        });
        assert.equal(recovered.checks.read_thread.status, "passed");
        assert.equal(recovered.threadId, thread.id);
      }
      assert.ok(reads.at(-1).passed);
      assert.ok(reads.at(-1).turns >= 1);
      assert.ok(!runtime.rpc.events.some(e => e.method === "turn/completed" && e.params.threadId === thread.id));
    } finally { release(); }
    const completed = await runtime.rpc.event("turn/completed", p => p.threadId === thread.id && p.turn.id === started.turn.id);
    assert.equal(completed.turn.status, "completed");
    assert.equal(runtime.requests.filter(r => r.method !== "HEAD" && r.body.generate !== false).length, 1);
    t.diagnostic(`real history reads: ${JSON.stringify(reads.map(({ passed, turns }) => ({ passed, turns })))}`);
  });
}
