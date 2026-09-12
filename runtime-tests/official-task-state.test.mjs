import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { call, message, startRuntime } from "./support/offline-runtime.mjs";

test("[A SES-08 OBS-01] 官方目标实际执行文件任务并完成，完成后不继续生成", { timeout: 30_000 }, async t => {
  const r = await startRuntime(t, { profile: "configured-responses" });
  const { thread } = await r.thread();
  r.enqueue([call("create_goal", { objective: "在当前临时目录写入 GOAL_EXECUTED", token_budget: 1000 })],
    async () => {
      const { goal } = await r.rpc.request("thread/goal/get", { threadId: thread.id });
      assert.equal(goal.status, "active");
      const command = process.platform === "win32"
        ? "Set-Content -NoNewline -LiteralPath goal.txt -Value GOAL_EXECUTED"
        : "printf GOAL_EXECUTED > goal.txt";
      return [call("exec_command", { cmd: command, workdir: r.cwd, login: false })];
    }, async () => {
      assert.equal(await readFile(join(r.cwd, "goal.txt"), "utf8"), "GOAL_EXECUTED");
      return [call("update_goal", { status: "complete" })];
    }, "GOAL_FINISHED");
  await r.turn(thread.id, "请创建一个 1000 Token 预算的测试目标：在当前临时目录写入 goal.txt，内容为 GOAL_EXECUTED。验证文件后将目标设为完成。");
  const { goal } = await r.rpc.request("thread/goal/get", { threadId: thread.id });
  assert.equal(goal.status, "complete");
  assert.equal(await readFile(join(r.cwd, "goal.txt"), "utf8"), "GOAL_EXECUTED");
  assert.equal(r.requests.filter(q => q.method !== "HEAD" && q.body.generate !== false).length, 4);
});

test("[A SES-04 SES-07 ENV-03] 官方分页时间线、分组管理和删除只影响指定临时任务", { timeout: 30_000 }, async t => {
  const r = await startRuntime(t, { profile: "shim" });
  const { thread } = await r.thread();
  r.enqueue("TIMELINE_A", "TIMELINE_B");
  await r.turn(thread.id, "first"); await r.turn(thread.id, "second");
  const first = await r.rpc.request("thread/turns/list", { threadId: thread.id, limit: 1, sortDirection: "asc", itemsView: "full" });
  assert.equal(first.data.length, 1); assert.ok(first.nextCursor);
  const second = await r.rpc.request("thread/turns/list", { threadId: thread.id, limit: 1, cursor: first.nextCursor, sortDirection: "asc", itemsView: "full" });
  assert.equal(second.data.length, 1); assert.notEqual(second.data[0].id, first.data[0].id);
  assert.match(JSON.stringify(first), /TIMELINE_A/); assert.match(JSON.stringify(second), /TIMELINE_B/);
  const items = await r.rpc.request("thread/items/list", { threadId: thread.id, turnId: first.data[0].id, limit: 50 });
  assert.match(JSON.stringify(items), /TIMELINE_A/); assert.doesNotMatch(JSON.stringify(items), /TIMELINE_B/);
  const { section } = await r.rpc.request("threadSection/create", { name: "仅供回归" });
  await r.rpc.request("threadSection/update", { sectionId: section.id, name: "回归已改名" });
  await r.rpc.request("thread/section/move", { threadId: thread.id, sectionId: section.id });
  assert.match(JSON.stringify(await r.rpc.request("threadSection/list", {})), /回归已改名/);
  assert.equal((await r.rpc.request("thread/read", { threadId: thread.id })).thread.section?.id, section.id);
  await r.rpc.request("thread/section/move", { threadId: thread.id, sectionId: null });
  await r.rpc.request("threadSection/delete", { sectionId: section.id });
  assert.doesNotMatch(JSON.stringify(await r.rpc.request("threadSection/list", {})), /回归已改名/);
  const kept = (await r.thread()).thread;
  r.enqueue("KEPT_THREAD"); await r.turn(kept.id, "keep this thread");
  await r.rpc.request("thread/delete", { threadId: thread.id });
  await assert.rejects(r.rpc.request("thread/read", { threadId: thread.id, includeTurns: true }), /not found|not loaded|No such|deleted|does not exist/i);
  const surviving = await r.rpc.request("thread/list", { sourceKinds: ["vscode"], useStateDbOnly: true });
  assert.ok(!surviving.data.some(value => value.id === thread.id));
  assert.ok(surviving.data.some(value => value.id === kept.id));
  assert.equal((await r.rpc.request("thread/read", { threadId: kept.id })).thread.id, kept.id);

  await writeFile(join(r.cwd, "search-fixture-marker.txt"), "SEARCH_RESULT");
  const sessionId = "offline-search";
  await r.rpc.request("fuzzyFileSearch/sessionStart", { sessionId, roots: [r.cwd] });
  const after = r.rpc.events.length;
  await r.rpc.request("fuzzyFileSearch/sessionUpdate", { sessionId, query: "search-fixture-marker" });
  const result = await r.rpc.event("fuzzyFileSearch/sessionUpdated", p => p.sessionId === sessionId && JSON.stringify(p).includes("search-fixture-marker.txt"), { after });
  assert.match(JSON.stringify(result), /search-fixture-marker.txt/);
  await r.rpc.request("fuzzyFileSearch/sessionStop", { sessionId });
});

test("[A SES-06 NET-06] 官方自动压缩阈值触发后使用压缩状态继续下一轮", { timeout: 30_000 }, async t => {
  const r = await startRuntime(t, { profile: "router", config: "model_auto_compact_token_limit = 20" });
  const { thread } = await r.thread();
  let compactions = 0;
  let normal = 0;
  const reply = body => {
    if ((body.input ?? []).some(i => i.type === "compaction_trigger")) {
      assert.ok(++compactions <= 3, "自动压缩不能无限重试");
      r.enqueue(reply);
      return [{ type: "compaction", id: `auto_${compactions}`, encrypted_content: "AUTO_COMPACTION_STATE" }, message("AUTO_KEEP_MARKER")];
    }
    if (++normal === 2) assert.match(JSON.stringify(body.input), /AUTO_COMPACTION_STATE/);
    return `AUTO_TURN_${normal}`;
  };
  r.enqueue(reply);
  await r.turn(thread.id, "保留 AUTO_KEEP_MARKER");
  r.enqueue(reply);
  await r.turn(thread.id, "使用之前的记录继续");
  assert.ok(compactions > 0, "必须由官方阈值触发，测试不能调用 compact/start 代替");
  assert.ok(r.rpc.events.some(e => e.params?.item?.type === "contextCompaction"));
});
