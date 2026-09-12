import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { call, customCall, message, startRuntime } from "./support/offline-runtime.mjs";
import { waitFor } from "../test/helpers.mjs";

const execFileAsync = promisify(execFile);
const outputs = body => (body.input ?? []).filter(i => /tool_call_output|function_call_output/.test(i.type));
const toolResults = (body, count = 1) => JSON.stringify(body.messages ? body.messages.filter(m => m.role === "tool").slice(-count) : outputs(body));
const completedItems = r => r.rpc.events.filter(e => e.method === "item/completed").map(e => e.params.item);
const gitExecutable = process.platform === "win32" ? "git.exe" : "/usr/bin/git";
const readInputCommand = process.platform === "win32"
  ? "Get-Content -Raw -LiteralPath input.txt"
  : "cat input.txt";

test("[A HAR-01 LCH-02 RPC-01 MOD-06] 官方运行时临时配置、本地端点和初始化协商", { timeout: 30_000 }, async t => {
  const r = await startRuntime(t, { initialize: false });
  await assert.rejects(r.rpc.request("model/list", {}), /initializ/i);
  const hello = await r.rpc.request("initialize", { clientInfo: { name: "offline_contract", version: "1" }, capabilities: { experimentalApi: true } });
  assert.ok(hello.userAgent);
  r.rpc.send({ method: "initialized", params: {} });
  await assert.rejects(r.rpc.request("initialize", { clientInfo: { name: "again", version: "1" } }), /initializ/i);
  const config = await r.rpc.request("config/read", { includeLayers: true });
  assert.equal(config.config.model, r.model);
  assert.equal(config.config.sandbox_mode, "danger-full-access");
  assert.equal(config.config.model_catalog_json, r.catalogPath);
  assert.ok(JSON.stringify(config.layers).includes(r.env.CODEX_HOME));
  assert.equal(r.requests.length, 0, "初始化与配置读取不发送模型请求");
});

for (const profile of ["direct", "shim", "router", "custom", "chat", "configured-responses", "configured-chat"]) {
  test(`[A TOOL-01 TOOL-04 TOOL-07 ENV-01 NET-03 NET-04 IO-02 OBS-01] ${profile} 官方工具执行文件读取、补丁、命令与续接`, { timeout: 40_000 }, async t => {
    const r = await startRuntime(t, { profile });
    await writeFile(join(r.cwd, "input.txt"), "BEFORE 中文\n");
    await execFileAsync(gitExecutable, ["init", "-q", r.cwd]);
    const classic = profile.startsWith("configured-");
    const { thread } = await r.thread();
    const command = text => call("exec_command", { cmd: text, workdir: r.cwd, login: false });
    r.enqueue(
      [message("检查测试文件", "commentary"), classic ? command(readInputCommand) : customCall("exec", `text(await tools.exec_command({cmd:${JSON.stringify(readInputCommand)},login:false}));`)],
      body => {
        assert.match(toolResults(body), /BEFORE 中文/);
        const patch = "*** Begin Patch\n*** Update File: input.txt\n-BEFORE 中文\n+AFTER 已验证\n*** End Patch";
        return [classic ? customCall("apply_patch", patch) : customCall("exec", `text(await tools.apply_patch(${JSON.stringify(patch)}));`)];
      },
      async body => {
        assert.equal(await readFile(join(r.cwd, "input.txt"), "utf8"), "AFTER 已验证\n");
        return classic ? [command(readInputCommand), command("exit 7")] : [customCall("exec", `const results = await Promise.allSettled([tools.exec_command({cmd:${JSON.stringify(readInputCommand)},login:false}), tools.exec_command({cmd:"exit 7",login:false})]); for (const result of results) text(result);`)];
      },
      body => {
        const result = toolResults(body, classic ? 2 : 1);
        assert.match(result, /AFTER 已验证/);
        assert.match(result, /exit_code|exited with code/);
        assert.match(result, /7/);
        return [message("文件修改和失败命令均已核对", "final_answer")];
      },
    );
    const turn = await r.turn(thread.id, "仅操作当前临时测试项目");
    assert.equal(await readFile(join(r.cwd, "input.txt"), "utf8"), "AFTER 已验证\n");
    const items = completedItems(r);
    assert.ok(items.some(i => i.type === "fileChange" && i.status === "completed"));
    assert.ok(items.some(i => i.type === "commandExecution" && i.exitCode === 7));
    assert.ok(items.some(i => i.type === "agentMessage" && i.text.includes("检查测试文件")));
    assert.equal(turn.items.filter(i => i.type === "agentMessage" && i.text.includes("文件修改和失败命令均已核对")).length, 1);
    assert.ok(r.requests.some(q => q.method === "WS" || q.method === "POST"));
    if (r.router) {
      const usage = (await readFile(r.usagePath, "utf8")).trim().split("\n").map(JSON.parse);
      assert.ok(usage.some(event => JSON.stringify(event).includes(thread.id)));
      assert.ok(r.requests.filter(q => q.body.generate !== false && q.method !== "HEAD").every(q =>
        q.headers.authorization === `Bearer ${profile === "router" ? "sk-offline-fixture-no-account" : "sk-fixture-platform"}`));
    }
  });
}

test("[A TOOL-01 ENV-03 IO-01 RPC-05 OBS-03] 官方 fs 接口读取、复制、监听、删除大文件与 UTF-8 二进制内容", { timeout: 30_000 }, async t => {
  const r = await startRuntime(t, { profile: "shim" });
  const directory = join(r.cwd, "附件 中文");
  await r.rpc.request("fs/createDirectory", { path: directory, recursive: true });
  const path = join(directory, "fixture.txt");
  const bytes = Buffer.concat([Buffer.alloc(2 * 1024 * 1024, 65), Buffer.from("文件与二进制\0\xff\n")]);
  await r.rpc.request("fs/writeFile", { path, dataBase64: bytes.toString("base64") });
  const file = await r.rpc.request("fs/readFile", { path });
  assert.deepEqual(Buffer.from(file.dataBase64, "base64"), bytes);
  assert.deepEqual(await readFile(path), bytes);
  const copy = join(directory, "copy.txt");
  await r.rpc.request("fs/copy", { sourcePath: path, destinationPath: copy, recursive: false });
  assert.deepEqual(await readFile(copy), bytes);
  const listing = await r.rpc.request("fs/readDirectory", { path: directory });
  assert.match(JSON.stringify(listing), /fixture.txt/);
  assert.match(JSON.stringify(await r.rpc.request("fs/getMetadata", { path })), /file/i);
  const watchId = "offline-watch";
  await r.rpc.request("fs/watch", { path: directory, watchId });
  const after = r.rpc.events.length;
  await writeFile(path, "CHANGED");
  const changed = await r.rpc.event("fs/changed", p => p.watchId === watchId, { after });
  assert.match(JSON.stringify(changed), /fixture.txt|附件/);
  await r.rpc.request("fs/unwatch", { watchId });
  await r.rpc.request("fs/remove", { path: copy });
  await assert.rejects(readFile(copy), { code: "ENOENT" });
  await assert.rejects(r.rpc.request("fs/readFile", { path: copy }), /No such file|not found|不存在/i);
});

test("[A TOOL-02 ENV-01] 官方命令 PTY 的输入、调整尺寸、输出和受控终止", { timeout: 30_000 }, async t => {
  const r = await startRuntime(t, { profile: "shim" });
  const processId = "offline-terminal";
  const after = r.rpc.events.length;
  const interactiveCommand = process.platform === "win32"
    ? [process.execPath, "-e", "process.stdout.write('PTY_READY\\n');process.stdin.once('data',d=>{process.stdout.write('RESULT:'+d.toString().trim());process.exit(0)})"]
    : ["/bin/sh", "-c", "printf 'PTY_READY\\n'; read value; stty size; printf 'RESULT:%s' \"$value\""];
  const pending = r.rpc.request("command/exec", { processId, command: interactiveCommand,
    cwd: r.cwd, tty: true, size: { rows: 20, cols: 60 }, streamStdin: true, streamStdoutStderr: true, timeoutMs: 8000 });
  pending.catch(() => {});
  await r.rpc.event("command/exec/outputDelta", p => p.processId === processId && Buffer.from(p.deltaBase64, "base64").toString().includes("PTY_READY"), { after });
  await r.rpc.request("command/exec/resize", { processId, size: { rows: 24, cols: 90 } });
  await r.rpc.request("command/exec/write", { processId, deltaBase64: Buffer.from("交互验证\n").toString("base64") });
  const result = await pending;
  assert.equal(result.exitCode, 0);
  const stream = r.rpc.events.slice(after).filter(e => e.method === "command/exec/outputDelta")
    .map(e => Buffer.from(e.params.deltaBase64, "base64").toString()).join("");
  assert.match(stream + JSON.stringify(result), /RESULT:交互验证/);
  if (process.platform !== "win32") assert.match(stream + JSON.stringify(result), /24\s+90/);
  const killedCommand = process.platform === "win32"
    ? [process.execPath, "-e", "process.stdout.write('KILL_READY');setInterval(()=>{},1000)"]
    : ["/bin/sh", "-c", "printf KILL_READY; exec /bin/sleep 30"];
  const killed = r.rpc.request("command/exec", { processId: "offline-kill", command: killedCommand, cwd: r.cwd, streamStdoutStderr: true, timeoutMs: 10000 });
  killed.catch(() => {});
  await r.rpc.event("command/exec/outputDelta", p => p.processId === "offline-kill" && Buffer.from(p.deltaBase64, "base64").toString().includes("KILL_READY"));
  await r.rpc.request("command/exec/terminate", { processId: "offline-kill" });
  const end = await killed;
  assert.notEqual(end.exitCode, 0);
  await assert.rejects(r.rpc.request("command/exec/write", { processId: "offline-kill", deltaBase64: "Cg==" }), /not found|Unknown|not running|no active/i);
  const pwdCommand = process.platform === "win32"
    ? [process.execPath, "-e", "process.stdout.write(process.cwd())"]
    : ["/bin/pwd"];
  const actualCwd = (await r.rpc.request("command/exec", { command: pwdCommand, cwd: r.cwd })).stdout.trim();
  const expectedCwd = await realpath(r.cwd);
  assert.equal(
    process.platform === "win32" ? actualCwd.toLowerCase() : actualCwd,
    process.platform === "win32" ? expectedCwd.toLowerCase() : expectedCwd,
  );
});

test("[A SES-01 SES-02 SES-04 SES-07 ENV-03] 官方任务恢复、分叉、名称、列表、归档和历史回滚", { timeout: 30_000 }, async t => {
  const r = await startRuntime(t, { profile: "router" });
  const { thread } = await r.thread({ historyMode: "legacy" });
  r.enqueue("FIRST_MARKER", "SECOND_MARKER");
  await r.turn(thread.id, "first input");
  await r.turn(thread.id, "second input");
  await r.rpc.request("thread/name/set", { threadId: thread.id, name: "回归独立任务" });
  const loaded = await r.rpc.request("thread/read", { threadId: thread.id, includeTurns: true });
  assert.match(JSON.stringify(loaded), /FIRST_MARKER/);
  const fork = await r.rpc.request("thread/fork", { threadId: thread.id, cwd: r.cwd });
  assert.notEqual(fork.thread.id, thread.id);
  assert.equal(fork.thread.forkedFromId, thread.id);
  const restored = await r.rpc.request("thread/resume", { threadId: thread.id });
  assert.equal(restored.model, r.model);
  const rollback = await r.rpc.request("thread/rollback", { threadId: thread.id, numTurns: 1 });
  assert.match(JSON.stringify(rollback), /FIRST_MARKER/);
  assert.doesNotMatch(JSON.stringify(rollback), /SECOND_MARKER/);
  const listed = await waitFor(async () => {
    const result = await r.rpc.request("thread/list", { limit: 50, sourceKinds: ["vscode"], useStateDbOnly: true });
    return result.data.some(i => i.id === thread.id) ? result : null;
  });
  assert.ok(listed.data.some(i => i.id === thread.id));
  await r.rpc.request("thread/archive", { threadId: thread.id });
  const archived = await r.rpc.request("thread/list", { limit: 50, archived: true, sourceKinds: ["vscode"], useStateDbOnly: true });
  assert.ok(archived.data.some(i => i.id === thread.id));
  await r.rpc.request("thread/unarchive", { threadId: thread.id });
  await r.rpc.request("thread/resume", { threadId: thread.id });
  r.enqueue(body => { assert.match(JSON.stringify(body.input), /FIRST_MARKER|resume after archive/); return "RESUMED"; });
  await r.turn(thread.id, "resume after archive");
});

test("[A SES-05 SES-08] 官方任务目标和输入队列实际执行一次，顺序与修改一致", { timeout: 30_000 }, async t => {
  const r = await startRuntime(t, { profile: "shim" });
  const { thread } = await r.thread();
  await r.rpc.request("thread/goal/set", { threadId: thread.id, objective: "fixture goal", tokenBudget: 1000, status: "paused" });
  assert.match(JSON.stringify(await r.rpc.request("thread/goal/get", { threadId: thread.id })), /fixture goal/);
  await r.rpc.request("thread/goal/clear", { threadId: thread.id });
  let release;
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  r.enqueue(() => new Promise(resolve => { release = resolve; entered(); }));
  const holding = await r.rpc.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "HOLD_QUEUE" }] });
  await waiting;
  const add = async (id, text) => r.rpc.request("thread/queue/add", { threadId: thread.id, clientUserMessageId: id, input: [{ type: "text", text }] });
  const first = await add("queue-a", "QUEUE_A");
  const second = await add("queue-b", "QUEUE_B");
  await add("queue-c", "QUEUE_DELETED");
  const listing = await r.rpc.request("thread/queue/list", { threadId: thread.id });
  const data = listing.data ?? listing.items;
  assert.equal(data.length, 3, JSON.stringify({ first, second, listing }));
  const ids = data.map(i => i.id ?? i.queuedSubmissionId);
  await r.rpc.request("thread/queue/update", { threadId: thread.id, queuedSubmissionId: ids[0], input: [{ type: "text", text: "QUEUE_A_EDITED" }] });
  await r.rpc.request("thread/queue/reorder", { threadId: thread.id, queuedSubmissionIds: [ids[1], ids[0], ids[2]] });
  await r.rpc.request("thread/queue/delete", { threadId: thread.id, queuedSubmissionId: ids[2] });
  const after = r.rpc.events.length;
  const executed = [];
  r.enqueue(...["QUEUE_B", "QUEUE_A_EDITED"].map(marker => body => {
    const input = JSON.stringify(body.input);
    assert.match(input, new RegExp(marker));
    assert.doesNotMatch(input, /QUEUE_DELETED/);
    executed.push(marker);
    return `${marker}_RESULT`;
  }));
  await assert.rejects(r.rpc.request("thread/queue/start", { threadId: thread.id, queuedSubmissionId: ids[0] }), /active|pending/);
  release("HOLD_COMPLETE");
  const done = await r.rpc.event("turn/completed", p => p.threadId === thread.id &&
    p.turn.items.some(i => i.type === "agentMessage" && i.text === "QUEUE_A_EDITED_RESULT"), { after });
  assert.equal(done.turn.status, "completed");
  assert.deepEqual(executed, ["QUEUE_B", "QUEUE_A_EDITED"]);
  const remaining = await r.rpc.request("thread/queue/list", { threadId: thread.id });
  assert.equal((remaining.data ?? remaining.items).length, 0);
  await r.rpc.request("thread/goal/clear", { threadId: thread.id });
  assert.equal((await r.rpc.request("thread/goal/get", { threadId: thread.id })).goal, null);
});
