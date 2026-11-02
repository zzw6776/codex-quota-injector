import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { TokenUsageManager } from "../src/token-usage.mjs";
import { useTempDir } from "./helpers.mjs";
import { event, protocolUsage, pricing, createManager } from "./token-usage/support.mjs";

for (const [model, expectedTotal] of [["gpt-6.1-sol", 0.42], ["gpt-6.1-terra", 0.21]]) {
test(`原先无 ${model} 价格的持久化用量重新加载后重算费用，多个短请求不合并计长价`, async t => {
  const dataDir = await useTempDir(t);
  const codexHome = join(dataDir, "codex-home");
  await mkdir(codexHome);
  const usage = protocolUsage({ input:150000,cached:100000,output:10000 });
  const events = [
    event("start", "turn-started", "thread-sol", "turn-sol", { model }),
    event("usage-1", "usage", "thread-sol", "turn-sol", { responseId:"response-1", tokenUsage:{last:usage,total:usage} }),
    event("usage-2", "usage", "thread-sol", "turn-sol", { responseId:"response-2", tokenUsage:{last:usage,
      total:protocolUsage({input:300000,cached:200000,output:20000})} }),
  ];
  await writeFile(join(dataDir, "token-usage-events.jsonl"), events.map(item=>JSON.stringify(item)).join("\n")+"\n");
  const oldPricing = pricing(dataDir);
  oldPricing.calculate = model => ({ available:false,requestedModel:model,reason:"当前模型没有对应的官方价格配置" });
  const oldManager = new TokenUsageManager({dataDir,codexHome,pricingManager:oldPricing,discoveryIntervalMs:0});
  t.after(()=>oldManager.close());
  await oldManager.initialize();
  assert.equal(oldManager.getViewModel().turns[0].cost.available, false);
  await oldManager.flush();
  const originalCache = JSON.parse(await readFile(oldManager.cachePath, "utf8"));
  oldManager.close();

  const restored = new TokenUsageManager({dataDir,codexHome,pricingManager:pricing(dataDir),discoveryIntervalMs:0});
  t.after(()=>restored.close());
  await restored.initialize();
  const turn = restored.getViewModel().turns[0];
  assert.equal(turn.model, model);
  assert.equal(turn.totalTokens, 320000);
  assert.equal(turn.cost.available, true);
  assert.deepEqual(turn.cost.contextTiers, ["short"]);
  assert.ok(Math.abs(turn.cost.total - expectedTotal) < 1e-10);
  assert.equal(turn.cost.cumulativeAvailable, true);
  assert.ok(Math.abs(turn.cost.cumulativeCny - turn.cost.totalCny) < 1e-10);
  const loadedCache = JSON.parse(await readFile(restored.cachePath, "utf8"));
  assert.equal(loadedCache.version, originalCache.version, "价格更新不改变已兼容的 Token 缓存结构");
  await restored.flush();
});
}

test("峰谷费用区间跨归档历史与不同供应商回合累计，缓存恢复不改变 Token", async t => {
  const events = [];
  const usage = protocolUsage({ input: 100, output: 20 });
  for (const [index, model] of ["deepseek-flash", "gpt-6.1-terra"].entries()) {
    const turnId = `range-turn-${index}`;
    events.push(
      event(`range-start-${index}`, "turn-started", "range-thread", turnId, { model, recordedAt: 1000 + index * 3 }),
      event(`range-usage-${index}`, "usage", "range-thread", turnId, {
        responseId: `range-response-${index}`,
        tokenUsage: { last: usage, total: usage }, recordedAt: 1001 + index * 3,
      }),
      event(`range-end-${index}`, "turn-completed", "range-thread", turnId, {
        status: "completed", recordedAt: 1002 + index * 3,
      }),
    );
  }
  const { manager, codexHome, dataDir } = await createManager(t, {
    events, managerOptions: { maxStoredTurnSummaries: 1 },
  });
  const verify = manager => {
    const turn = manager.getViewModel().turns.find(value => value.turnId === "range-turn-1");
    const openaiCost = 0.0002 * manager.pricingManager.exchangeRate.rate;
    assert.equal(turn.totalTokens, 120);
    assert.equal(turn.cost.cumulativeAvailable, true);
    assert.equal(turn.cost.rangeCny, undefined);
    assert.ok(Math.abs(turn.cost.cumulativeRangeCny.min - (openaiCost + 0.00018)) < 1e-10);
    assert.ok(Math.abs(turn.cost.cumulativeRangeCny.max - (openaiCost + 0.00036)) < 1e-10);
  };
  verify(manager);
  await manager.flush();
  manager.close();
  const restored = new TokenUsageManager({
    dataDir, codexHome, pricingManager: pricing(dataDir), discoveryIntervalMs: 0,
    maxStoredTurnSummaries: 1,
  });
  t.after(() => restored.close());
  await restored.initialize({ forceDiscovery: false });
  verify(restored);
});
