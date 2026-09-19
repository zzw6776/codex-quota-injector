import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { TokenUsageManager } from "../src/token-usage.mjs";
import { appendEvents, createManager, event, pricing, protocolUsage } from "./token-usage/support.mjs";

test("空刷新复用用量视图，追加真实用量后更新统计", async t => {
  const usage = protocolUsage({ input: 10, output: 5 });
  const { manager, dataDir } = await createManager(t, { events: [
    event("start", "turn-started", "thread-cache", "turn-cache", { model: "deepseek-v4-flash" }),
    event("usage-1", "usage", "thread-cache", "turn-cache", {
      responseId: "response-1", tokenUsage: { last: usage, total: usage },
    }),
  ] });
  const initial = await manager.refresh();
  assert.equal(initial.turns[0].totalTokens, 15);
  await manager.flush();
  const revision = manager.cacheRevision;
  assert.strictEqual(await manager.refresh(), initial, "无新数据不重新构造历史视图");
  assert.strictEqual(await manager.refresh({ forceDiscovery: true }), initial);
  assert.equal(manager.cacheRevision, revision, "空刷新不触发缓存持久化");
  await appendEvents(dataDir, [event("usage-2", "usage", "thread-cache", "turn-cache", {
    responseId: "response-2", tokenUsage: { last: usage, total: protocolUsage({ input: 20, output: 10 }) },
  })]);
  const next = await manager.refresh();
  assert.notStrictEqual(next, initial);
  assert.equal(next.turns[0].totalTokens, 30);
  assert.strictEqual(await manager.refresh(), next);
});

test("复用视图不能隐藏读取错误及恢复状态", async t => {
  const { manager, codexHome, dataDir } = await createManager(t);
  const ready = manager.getViewModel();
  const invalidHome = join(dataDir, "not-a-directory");
  await mkdir(invalidHome);
  // 直接读取文件路径在 Windows 与 Linux 均返回 ENOTDIR；Windows
  // 读取文件下不存在的子路径会返回 ENOENT，无法触发读取错误契约。
  await writeFile(join(invalidHome, "sessions"), "fixture");
  manager.codexHome = invalidHome;
  try {
    const failed = await manager.refresh({ forceDiscovery: true });
    assert.notStrictEqual(failed, ready);
    assert.match(failed.error, /ENOTDIR/);
  } finally {
    manager.codexHome = codexHome;
  }
  const recovered = await manager.refresh({ forceDiscovery: true });
  assert.equal(recovered.error, null);
  assert.equal(recovered.status, "ready");
  assert.strictEqual(await manager.refresh(), recovered);
});

test("Relay 的 turn state 长度事件按任务进入跨进程视图、缓存恢复且不保存原值", async t => {
  const observedAt = Date.now() - 1_000;
  const { manager, codexHome, dataDir } = await createManager(t, { events: [
    event("state-a", "turn-state-observed", "thread-a", null, {
      model: "gpt-5.6-sol", byteLength: 292, expectedByteLength: 292, recordedAt: observedAt,
    }),
    event("state-b", "turn-state-observed", "thread-b", null, {
      model: "gpt-6-astra", byteLength: 312, expectedByteLength: 292,
    }),
  ] });
  assert.deepEqual(manager.getTurnStateViewModel("thread-a"), {
    status: "match", expectedByteLength: 292, byteLength: 292,
    model: "gpt-5.6-sol", observedAt,
  });
  assert.equal(manager.getTurnStateViewModel("thread-b").status, "mismatch");
  assert.equal(manager.getTurnStateViewModel("missing").status, "unknown");

  await manager.flush();
  const cache = await readFile(join(dataDir, "token-usage-cache.json"), "utf8");
  assert.match(cache, /"turnStates"/);
  assert.doesNotMatch(cache, /x-codex-turn-state|current_turn_state/);

  const restored = new TokenUsageManager({
    codexHome,
    dataDir,
    discoveryIntervalMs: 0,
    pricingManager: pricing(dataDir),
  });
  t.after(() => restored.close());
  await restored.initialize();
  assert.deepEqual(restored.getTurnStateViewModel("thread-a"), {
    status: "match", expectedByteLength: 292, byteLength: 292,
    model: "gpt-5.6-sol", observedAt,
  });
  assert.equal(restored.getTurnStateViewModel("thread-b").status, "mismatch");
});
