import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { TokenUsageManager } from "../src/token-usage.mjs";
import { CACHE_VERSION } from "../src/token-usage/contract.mjs";
import { buildUsageViewModel } from "../src/token-usage/display.mjs";
import { emptyTurn } from "../src/token-usage/turns.mjs";
import { useTempDir } from "./helpers.mjs";
import { appendEvents, createManager, event, pricing, protocolUsage, turnContext } from "./token-usage/support.mjs";

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
  const sourceBeforeAppend = await manager.getSourceSnapshot();
  await appendEvents(dataDir, [event("usage-2", "usage", "thread-cache", "turn-cache", {
    responseId: "response-2", tokenUsage: { last: usage, total: protocolUsage({ input: 20, output: 10 }) },
  })]);
  const sourceDuringAppend = await manager.getSourceSnapshot();
  assert.equal(sourceDuringAppend.event.size, sourceBeforeAppend.event.size,
    "文件在读取后继续增长时，探针保留已处理偏移");
  assert.equal(sourceDuringAppend.event.mtimeMs, null);
  const next = await manager.refresh();
  assert.notStrictEqual(next, initial);
  assert.equal(next.turns[0].totalTokens, 30);
  assert.strictEqual(await manager.refresh(), next);
});

test("用量视图不展开窗口外回合的生成与工具明细", () => {
  const turns = new Map();
  for (let index = 0; index < 121; index += 1) {
    const turn = emptyTurn(`turn-${index}`, `thread-${index}`, "event");
    turn.completed = true;
    turn.status = "completed";
    turn.totalTokens = 1;
    turn.updatedAt = index + 1;
    turns.set(turn.turnId, turn);
  }
  Object.defineProperty(turns.get("turn-0"), "generationDetails", {
    enumerable: true,
    get() { throw new Error("窗口外明细不应被读取"); },
  });
  const view = buildUsageViewModel({
    historicalSegmentsByThread: new Map(),
    historicalCostCache: new Map(),
    turns,
    pricingManager: { toViewModel: () => ({ available: false, totalCny: 0 }) },
    rolloutMetadataByThread: new Map(),
    maxViewTurns: 120,
    initializing: false,
    error: null,
    getCachedTurnCost: () => null,
  });
  assert.equal(view.turns.length, 120);
  assert.equal(view.turns.some((turn) => turn.turnId === "turn-0"), false);
});

test("独立统计进程不重复刷新由父进程维护的汇率", async (t) => {
  const codexHome = await useTempDir(t);
  let refreshes = 0;
  const manager = new TokenUsageManager({
    codexHome,
    dataDir: codexHome,
    watchEvents: false,
    refreshPricing: false,
    pricingManager: {
      async initialize() {},
      async refreshExchangeRate() { refreshes += 1; },
      onChange() { return () => {}; },
      toViewModel() { return { available: false, totalCny: 0 }; },
    },
  });
  t.after(() => manager.close());
  await manager.initialize({ forceDiscovery: false });
  await manager.refresh();
  assert.equal(refreshes, 0);
});

test("flush 会处理延迟补全并清除补全期间重新安排的落盘计时器", async (t) => {
  const { manager } = await createManager(t, { rollouts: [{
    threadId: "33333333-3333-4333-8333-333333333333",
    records: [turnContext("turn-flush", "gpt-6-luna")],
  }] });
  await manager.refresh();
  assert.ok(manager.unknownRolloutCheckTimer);
  await manager.flush();
  assert.equal(manager.unknownRolloutCheckTimer, null);
  assert.equal(manager.cachePersistTimer, null);
});

test("完整回合工作集超过界面缓冲后压缩最旧历史", async t => {
  const { manager } = await createManager(t);
  for (let index = 0; index < 513; index += 1) {
    const turn = emptyTurn(`turn-${index}`, `thread-${index}`, "event");
    turn.completed = true;
    turn.status = "completed";
    turn.totalTokens = 1;
    turn.updatedAt = index + 1;
    manager.turns.set(turn.turnId, turn);
  }
  await manager.refresh();
  assert.equal(manager.turns.size, 512);
  assert.equal(manager.turns.has("turn-0"), false);
  assert.equal(manager.historicalSegmentsByThread.has("thread-0"), true);
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

test("Relay 的 turn state 长度按任务缓存，旧缓存判断字段被丢弃", async t => {
  const observedAt = Date.now() - 1_000;
  const { manager, codexHome, dataDir } = await createManager(t, { events: [
    event("state-a", "turn-state-observed", "thread-a", null, {
      model: "gpt-5.6-sol", byteLength: 292, recordedAt: observedAt,
    }),
    event("state-b", "turn-state-observed", "thread-b", null, {
      model: "gpt-6-astra", byteLength: 780,
    }),
  ] });
  assert.deepEqual(manager.getTurnStateViewModel("thread-a"), {
    byteLength: 292, model: "gpt-5.6-sol", observedAt,
  });
  assert.equal(manager.getTurnStateViewModel("thread-b").byteLength, 780);
  assert.deepEqual(manager.getTurnStatesViewModel()["thread-a"], {
    byteLength: 292, model: "gpt-5.6-sol", observedAt,
  });
  assert.deepEqual(manager.getTurnStateViewModel("missing"), {
    byteLength: null, model: null, observedAt: null,
  });

  await manager.flush();
  const cachePath = join(dataDir, "token-usage-cache.json");
  const cache = await readFile(cachePath, "utf8");
  assert.match(cache, /"turnStates"/);
  assert.doesNotMatch(cache, /x-codex-turn-state|current_turn_state|expectedByteLength|"status":"match"|"status":"mismatch"/);

  const legacyCache = JSON.parse(cache);
  legacyCache.version = 25;
  for (const state of legacyCache.turnStates) {
    state.status = state.byteLength === 292 ? "match" : "mismatch";
    state.expectedByteLength = 292;
  }
  await writeFile(cachePath, JSON.stringify(legacyCache));

  const restored = new TokenUsageManager({
    codexHome,
    dataDir,
    discoveryIntervalMs: 0,
    pricingManager: pricing(dataDir),
  });
  t.after(() => restored.close());
  await restored.initialize();
  assert.deepEqual(restored.getTurnStateViewModel("thread-a"), {
    byteLength: 292, model: "gpt-5.6-sol", observedAt,
  });
  assert.equal(restored.getTurnStateViewModel("thread-b").byteLength, 780);
  await restored.flush();
  const migrated = JSON.parse(await readFile(cachePath, "utf8"));
  assert.equal(migrated.version, CACHE_VERSION);
  assert.ok(migrated.turnStates.every(state =>
    !Object.hasOwn(state, "status") && !Object.hasOwn(state, "expectedByteLength")));
});
