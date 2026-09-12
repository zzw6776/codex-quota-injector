import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { customCall, message, startRuntime } from "./support/offline-runtime.mjs";
import { waitFor } from "../test/helpers.mjs";

test("[A SES-06 NET-06 OBS-01] 官方远程压缩协议返回状态，压缩后仍可继续", { timeout: 30_000 }, async t => {
  const r = await startRuntime(t, { profile: "router" });
  const { thread } = await r.thread();
  r.enqueue("原始内容 KEEP_BEFORE_COMPACTION");
  await r.turn(thread.id, "保留标记 KEEP_BEFORE_COMPACTION");
  r.enqueue((body, request, response) => {
    assert.match(request.url, /responses$/);
    assert.ok(body.input.some(i => i.type === "compaction_trigger"));
    return [{ type: "compaction", id: "cmp_offline", encrypted_content: "opaque-offline-compaction" }, message("摘要 COMPACTED_KEEP_MARKER")];
  });
  const after = r.rpc.events.length;
  await r.rpc.request("thread/compact/start", { threadId: thread.id });
  await r.rpc.event("item/completed", p => p.threadId === thread.id && p.item.type === "contextCompaction", { after });
  const compacted = await r.rpc.event("turn/completed", p => p.threadId === thread.id, { after });
  r.enqueue(body => {
    assert.match(JSON.stringify(body.input), /opaque-offline-compaction/);
    return "压缩后续接完成";
  });
  const turn = await r.turn(thread.id, "使用刚才的摘要继续");
  assert.ok(turn.items.some(i => i.type === "agentMessage" && i.text === "压缩后续接完成"));
  const usage = await waitFor(async () => {
    const entries = (await readFile(r.usagePath, "utf8")).trim().split("\n").map(JSON.parse).filter(e => e.type === "usage");
    return entries.length === 3 ? entries : null;
  });
  assert.equal(usage.length, 3);
  assert.ok(usage.some(e => e.turnId === compacted.turn.id));
  assert.ok(usage.every(e => e.tokenUsage.last.totalTokens > 0));
  assert.deepEqual(usage.map(e => e.tokenUsage.total.totalTokens), [25, 25, 50],
    "累计用量必须避免把远程压缩的完整上下文重复相加");
});

test("[A IO-01 IO-03 MOD-04] 官方读取图片附件和动态工具产物，字节到模型输入完整", { timeout: 30_000 }, async t => {
  const r = await startRuntime(t, { profile: "custom" });
  const chunk = (name, data) => {
    const payload = Buffer.concat([Buffer.from(name), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(payload));
    return Buffer.concat([length, payload, checksum]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(8, 4); ihdr[8] = 8; ihdr[9] = 6;
  const pixels = Buffer.concat(Array.from({ length: 8 }, () => Buffer.from([0, ...Array.from({ length: 8 }, () => [255, 0, 0, 255]).flat()])));
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
  const path = join(r.cwd, "图片 附件.png");
  await writeFile(path, png);
  const { thread } = await r.thread();
  r.enqueue(body => {
    const data = JSON.stringify(body.input.filter(i => i.type !== "additional_tools"));
    assert.match(data, /data:image\/(?:png|jpeg);base64,/);
    const images = body.input.flatMap(i => i.content ?? []).filter(i => i.type === "input_image");
    assert.ok(images.length);
    const bytes = Buffer.from(images[0].image_url.split(",")[1], "base64");
    assert.ok(bytes.subarray(1, 4).toString() === "PNG" || bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])), "官方可压缩图片，但必须保留有效图片输入");
    return [customCall("exec", `text(await tools.exec_command({cmd:"cp '图片 附件.png' artifact.png",login:false}));`)];
  }, async body => { assert.deepEqual(await readFile(join(r.cwd, "artifact.png")), png, JSON.stringify(body.input.filter(i => /call_output/.test(i.type)))); return [message("产物 artifact.png 已生成")]; });
  await r.turn(thread.id, "读取附件并复制成产物", { input: [{ type: "text", text: "读取附件并复制成产物" }, { type: "localImage", path }] });
  assert.deepEqual(await readFile(join(r.cwd, "artifact.png")), png);
});

test("[A SES-03 MOD-05 SES-07] 官方 steer 保留追加指令，设置更新和注入历史影响下一轮", { timeout: 30_000 }, async t => {
  const r = await startRuntime(t, { profile: "custom" });
  const { thread } = await r.thread({ historyMode: "legacy" });
  let release;
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  r.enqueue(() => new Promise(resolve => { release = resolve; entered(); }));
  const holding = await r.rpc.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "FIRST_INPUT" }] });
  await waiting;
  await assert.rejects(r.rpc.request("turn/steer", { threadId: thread.id, expectedTurnId: "wrong-turn", input: [{ type: "text", text: "MUST_NOT_APPEAR" }] }), /turn|match/);
  await r.rpc.request("turn/steer", { threadId: thread.id, expectedTurnId: holding.turn.id, input: [{ type: "text", text: "STEER_MARKER" }] });
  r.enqueue(body => { assert.match(JSON.stringify(body.input), /STEER_MARKER/); assert.doesNotMatch(JSON.stringify(body.input), /MUST_NOT_APPEAR/); return "STEER_APPLIED"; });
  release("FIRST_REPLY");
  await r.rpc.event("turn/completed", p => p.turn.id === holding.turn.id);
  await r.rpc.request("thread/settings/update", { threadId: thread.id, effort: "low", approvalPolicy: "never" });
  await r.rpc.request("thread/memoryMode/set", { threadId: thread.id, mode: "disabled" });
  await r.rpc.request("thread/inject_items", { threadId: thread.id, items: [{ type: "message", role: "developer", content: [{ type: "input_text", text: "INJECTED_CONTEXT_MARKER" }] }] });
  r.enqueue(body => { assert.match(JSON.stringify(body.input), /INJECTED_CONTEXT_MARKER/); assert.equal(body.reasoning.effort, "low"); return "SETTINGS_APPLIED"; });
  await r.turn(thread.id, "确认新设置");
  await r.rpc.request("thread/unsubscribe", { threadId: thread.id });
  const resumed = await r.rpc.request("thread/resume", { threadId: thread.id });
  assert.equal(resumed.thread.id, thread.id);
});

test("[A EXT-01] 官方 Hooks 从隔离配置加载并执行，真实文件与开发者上下文可核对", { timeout: 30_000 }, async t => {
  const r = await startRuntime(t, { profile: "custom", prepare: async ({ env, cwd }) => {
    const script = join(env.CODEX_HOME, "hook.mjs");
    await writeFile(script, `import {appendFileSync} from "node:fs";let input="";for await(const chunk of process.stdin)input+=chunk;appendFileSync(${JSON.stringify(join(cwd,"hook-events.jsonl"))},input+"\\n");console.log("HOOK_CONTEXT_MARKER");`);
    await writeFile(join(env.CODEX_HOME, "hooks.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `'${process.execPath}' '${script}'`, timeout: 5 }] }] } }));
  } });
  const hooks = await r.rpc.request("hooks/list", { cwds: [r.cwd] });
  assert.match(JSON.stringify(hooks), /UserPromptSubmit|userPromptSubmit/);
  const hook = hooks.data[0].hooks[0];
  assert.equal(hook.trustStatus, "untrusted");
  await r.rpc.request("config/value/write", { keyPath: `hooks.state.${JSON.stringify(hook.key)}.trusted_hash`, value: hook.currentHash, mergeStrategy: "replace" });
  const { thread } = await r.thread();
  r.enqueue(body => { assert.match(JSON.stringify(body.input), /HOOK_CONTEXT_MARKER/); return "HOOK_APPLIED"; });
  await r.turn(thread.id, "HOOK_INPUT");
  const records = (await readFile(join(r.cwd, "hook-events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(records.filter(e => e.hook_event_name === "UserPromptSubmit").length, 1);
  assert.equal(records[0].prompt, "HOOK_INPUT");
});
