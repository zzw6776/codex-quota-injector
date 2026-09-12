import assert from "node:assert/strict";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { call, customCall, message, ROOT, startRuntime } from "./support/offline-runtime.mjs";
import { waitFor } from "../test/helpers.mjs";

test("[A TOOL-03 EXT-02] 官方 MCP 发现、调用、资源、工具失败和 never 策略下的 elicitation 终结", { timeout: 30_000 }, async t => {
  const r = await startRuntime(t, { profile: "shim", prepare: async ({ directory, env }) => {
    const path = join(env.CODEX_HOME, "config.toml");
    await writeFile(path, (await readFile(path, "utf8")) + `\n[mcp_servers.fixture]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([join(ROOT, "runtime-tests/support/mcp-fixture.mjs"), directory])}\n`);
  } });
  const { thread } = await r.thread({ approvalPolicy: "never" });
  const status = await r.rpc.request("mcpServerStatus/list", { threadId: thread.id });
  assert.match(JSON.stringify(status), /record/);
  const result = await r.rpc.request("mcpServer/tool/call", { threadId: thread.id, server: "fixture", tool: "record", arguments: { text: "MCP_独立证据" }, _meta: { progressToken: "fixture-progress" } });
  assert.match(JSON.stringify(result), /MCP_独立证据/);
  assert.equal(await readFile(join(r.directory, "mcp-marker.txt"), "utf8"), "MCP_独立证据");
  const resource = await r.rpc.request("mcpServer/resource/read", { threadId: thread.id, server: "fixture", uri: "fixture://marker" });
  assert.match(JSON.stringify(resource), /MCP_独立证据/);
  const failed = await r.rpc.request("mcpServer/tool/call", { threadId: thread.id, server: "fixture", tool: "fail", arguments: {} });
  assert.match(JSON.stringify(failed), /EXPECTED_TOOL_ERROR/);
  assert.match(JSON.stringify(failed), /true/);
  let unexpectedElicitation = 0;
  r.rpc.onRequest = async request => {
    unexpectedElicitation++;
    throw new Error(`never 策略不应转交 MCP elicitation：${request.method}`);
  };
  const answered = await r.rpc.request("mcpServer/tool/call", { threadId: thread.id, server: "fixture", tool: "ask", arguments: {} });
  assert.equal(unexpectedElicitation, 0, JSON.stringify(answered));
  assert.match(JSON.stringify(answered), /decline/);
  await unlink(join(r.directory, "mcp-marker.txt"));
  const deniedThread = (await r.thread({ approvalPolicy: "never", sandbox: "workspace-write" })).thread;
  r.enqueue([customCall("exec", 'text(await tools.mcp__fixture__record({text:"MCP_MUST_NOT_WRITE"}));')], body => {
    assert.match(JSON.stringify(body.input), /requires approval, but approval policy is never/);
    return "MCP_DENIAL_OBSERVED";
  });
  const beforeDeniedMcp = r.rpc.events.length;
  await r.turn(deniedThread.id);
  const deniedMcp = r.rpc.events.slice(beforeDeniedMcp).find(event => event.method === "item/completed" &&
    event.params?.item?.type === "mcpToolCall")?.params.item;
  assert.equal(deniedMcp?.status, "failed");
  assert.match(deniedMcp?.error?.message ?? "", /requires approval/);
  await assert.rejects(readFile(join(r.directory, "mcp-marker.txt")), { code: "ENOENT" });

  const events = (await readFile(join(r.directory, "mcp-events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(events.some(e => e.method === "resources/read"));
  assert.equal(events.filter(e => e.method === "tools/call" && e.params.name === "record").length, 1);
  await r.rpc.request("config/mcpServer/reload", {});
});

test("[A TOOL-04 INT-02 RPC-03] 动态宿主工具及用户补充输入按当前任务往返并续接", { timeout: 30_000 }, async t => {
  const r = await startRuntime(t, { profile: "router" });
  const { thread } = await r.thread({ dynamicTools: [{ type: "function", name: "fixture_read", description: "Read isolated test marker", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] });
  const marker = join(r.cwd, "dynamic-host.txt");
  await writeFile(marker, "DYNAMIC_HOST_MARKER");
  let calls = 0;
  r.rpc.onRequest = async request => {
    assert.equal(request.method, "item/tool/call");
    assert.equal(request.params.threadId, thread.id);
    assert.equal(request.params.tool, "fixture_read");
    calls++;
    return { contentItems: [{ type: "inputText", text: await readFile(marker, "utf8") }], success: true };
  };
  r.enqueue([call("fixture_read", {})], body => { assert.match(JSON.stringify(body.input), /DYNAMIC_HOST_MARKER/); return "DYNAMIC_CONTINUED"; });
  await r.turn(thread.id);
  assert.equal(calls, 1);
  r.rpc.onRequest = async request => {
    assert.equal(request.method, "item/tool/requestUserInput");
    return { answers: { fixture_answer: { answers: ["继续"] } } };
  };
  r.enqueue([call("request_user_input", { questions: [{ header: "测试", id: "fixture_answer", question: "测试选择", options: [{ label: "继续", description: "继续临时测试" }, { label: "停止", description: "停止临时测试" }] }] })], body => {
    assert.match(JSON.stringify(body.input), /继续/); return "INPUT_CONTINUED";
  });
  await r.turn(thread.id, "收集测试选择", { collaborationMode: { mode: "plan", settings: { model: r.model, reasoning_effort: "low", developer_instructions: "Only follow the isolated test fixture" } } });
});

test("[A SES-03 NET-05] 生成中断保留中断终态，之后可发新轮次且旧结果不能串入", { timeout: 30_000 }, async t => {
  const r = await startRuntime(t, { profile: "router" });
  const { thread } = await r.thread();
  let started;
  const reached = new Promise(resolve => { started = resolve; });
  r.enqueue((_body, _request, response) => { started(response); return null; });
  const { turn } = await r.rpc.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "will interrupt" }] });
  await reached;
  const after = r.rpc.events.length;
  await r.rpc.request("turn/interrupt", { threadId: thread.id, turnId: turn.id });
  const interrupted = await r.rpc.event("turn/completed", p => p.turn.id === turn.id, { after });
  assert.equal(interrupted.turn.status, "interrupted");
  r.enqueue("AFTER_INTERRUPT");
  const next = await r.turn(thread.id, "new turn");
  assert.notEqual(next.id, turn.id);
  assert.match(JSON.stringify(next), /AFTER_INTERRUPT/);
});

test("[A EXT-01 MOD-06 ENV-03] 官方运行时加载临时 skill、禁用与恢复，并定位含中文的项目文件", { timeout: 30_000 }, async t => {
  let skillPath;
  const r = await startRuntime(t, { profile: "shim", prepare: async ({ env, cwd }) => {
    const dir = join(env.CODEX_HOME, "skills", "offline-fixture");
    await mkdir(dir, { recursive: true });
    skillPath = join(dir, "SKILL.md");
    await writeFile(skillPath, "---\nname: offline-fixture\ndescription: Isolated regression fixture\n---\nSKILL_INDEPENDENT_MARKER\n");
    await writeFile(join(cwd, "search-中文-marker.txt"), "SEARCH_MARKER");
  } });
  const skills = await r.rpc.request("skills/list", { cwds: [r.cwd], forceReload: true });
  assert.match(JSON.stringify(skills), /offline-fixture/);
  await r.rpc.request("skills/config/write", { path: skillPath, enabled: false });
  const disabled = await r.rpc.request("skills/list", { cwds: [r.cwd], forceReload: true });
  const found = disabled.data.flatMap(d => d.skills).find(s => s.name === "offline-fixture");
  assert.equal(found.enabled, false);
  await r.rpc.request("skills/config/write", { path: skillPath, enabled: true });
  const { thread } = await r.thread();
  r.enqueue(body => {
    const all = r.requests.flatMap(q => q.body.input ?? []);
    assert.match(JSON.stringify(all), /offline-fixture/);
    const command = process.platform === "win32"
      ? `Get-Content -Raw -LiteralPath ${JSON.stringify(skillPath)}`
      : `cat ${JSON.stringify(skillPath)}`;
    return [call("exec_command", { cmd: command, login: false })];
  }, body => { assert.match(JSON.stringify(body.input), /SKILL_INDEPENDENT_MARKER/); return "SKILL_READ"; });
  await r.turn(thread.id);
  const results = await r.rpc.request("fuzzyFileSearch", { query: "search-中文", roots: [r.cwd] });
  assert.match(JSON.stringify(results), /search-中文-marker.txt/);
});

test("[A ENV-01 SES-04] 官方项目与任务分组 CRUD 只修改隔离数据库", { timeout: 30_000 }, async t => {
  const r = await startRuntime(t, { profile: "shim" });
  const project = await r.rpc.request("project/create", { idempotencyKey: "project-fixture", name: "项目 A", roots: [{ path: r.cwd }] });
  const id = project.project.id;
  await r.rpc.request("project/update", { projectId: id, name: "项目 已修改" });
  assert.match(JSON.stringify(await r.rpc.request("project/read", { projectId: id })), /项目 已修改/);
  assert.ok((await r.rpc.request("project/list", {})).data.some(p => p.id === id));
  const { thread } = await r.thread({ projectId: id });
  assert.equal(thread.projectId, id);
  await r.rpc.request("project/delete", { projectId: id });
  await assert.rejects(r.rpc.request("project/read", { projectId: id }), /not found|exist/i);
});
