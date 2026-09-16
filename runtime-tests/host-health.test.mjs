import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ROOT, startRuntime } from "./support/offline-runtime.mjs";
import { waitFor } from "../test/helpers.mjs";

for (const profile of ["direct", "shim"]) {
  test(`[LCH-04 TOOL-04] 官方 ${profile} 启动后全局 MCP 目录空 runtimeStatus 不造成健康误报`, {timeout: 30_000}, async t => {
    const r = await startRuntime(t, {profile, prepare: async ({directory, env}) => {
      const fixture = join(directory, "mcp.mjs");
      await writeFile(fixture, (await readFile(join(ROOT, "runtime-tests/support/mcp-fixture.mjs"), "utf8"))
        .replace('["record", "read", "fail", "ask"]', '["list_threads", "read_thread", "list_projects", "get_usage_limits"]'));
      const path = join(env.CODEX_HOME, "config.toml");
      await writeFile(path, await readFile(path, "utf8") + `\n[mcp_servers.codex_app]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([fixture, directory])}\n`);
    }});
    const {thread} = await r.thread();
    await r.rpc.event("mcpServer/startupStatus/updated", p => p.name === "codex_app" && p.status === "ready");
    const global = await r.rpc.request("mcpServerStatus/list", {});
    if (profile === "shim") {
      const health = await waitFor(async () => {
        const state = JSON.parse(await readFile(join(r.directory, "host-health.json"), "utf8"));
        return state.status === "ready" ? state : null;
      });
      assert.equal(health.toolsVerified, true);
      assert.deepEqual(health.missingTools, []);
    }
    const scoped = await r.rpc.request("mcpServerStatus/list", {threadId: thread.id});
    const inventory = result => result.data.find(entry => entry.name === "codex_app");
    assert.equal(inventory(global).runtimeStatus, null);
    assert.equal(inventory(scoped).runtimeStatus, "connected");
    assert.deepEqual(Object.keys(inventory(global).tools).sort(), Object.keys(inventory(scoped).tools).sort());
    // Replay the global refresh after the scoped ready response as the desktop does.
    await r.rpc.request("mcpServerStatus/list", {});
    assert.equal(r.requests.filter(request => request.method !== "HEAD" && request.body.generate !== false).length, 0,
      "健康检查只允许连通性探测，不得发送模型请求");
  });
}

test("[LCH-04 TOOL-04] 正式 Relay 的主页空目录超过启动宽限期仍按需加载，进入任务后核验真实目录", { timeout: 60_000 }, async t => {
  let server;
  const r = await startRuntime(t, { profile: "shim", prepare: async ({ directory }) => {
    const fixture = join(directory, "task-local-mcp.mjs");
    await writeFile(fixture, (await readFile(join(ROOT, "runtime-tests/support/mcp-fixture.mjs"), "utf8"))
      .replace('["record", "read", "fail", "ask"]', '["list_threads", "read_thread", "list_projects", "get_usage_limits"]'));
    server = { command: process.execPath, args: [fixture, directory], enabled: true };
  } });
  assert.deepEqual((await r.rpc.request("mcpServerStatus/list", {})).data, []);
  await new Promise(resolve => setTimeout(resolve, 31_000));
  const healthPath = join(r.directory, "host-health.json");
  const idle = JSON.parse(await readFile(healthPath, "utf8"));
  assert.equal(idle.status, "idle", "主页不能因没有任务工具启动通知而误报超时");
  assert.equal(idle.toolsVerified, false);
  const { thread } = await r.thread({ ephemeral: true, config: { "mcp_servers.codex_app": server } });
  await r.rpc.event("mcpServer/startupStatus/updated", p => p.name === "codex_app" && p.status === "ready" && p.threadId === thread.id);
  const health = await waitFor(async () => {
    const value = JSON.parse(await readFile(healthPath, "utf8"));
    return value.status === "ready" && value.threadId === thread.id ? value : null;
  });
  assert.equal(health.toolsVerified, true);
  assert.deepEqual(health.missingTools, []);
  assert.deepEqual((await r.rpc.request("mcpServerStatus/list", {})).data, []);
  assert.equal(JSON.parse(await readFile(healthPath, "utf8")).status, "ready");
  assert.equal(r.requests.filter(request => request.method !== "HEAD" && request.body.generate !== false).length, 0);
});
