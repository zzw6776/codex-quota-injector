import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { TokenUsageManager } from "../src/token-usage.mjs";
import { useTempDir } from "./helpers.mjs";
import { event, protocolUsage, pricing } from "./token-usage/support.mjs";

test("原先无 GPT-6.1 价格的持久化用量重新加载后重算费用，多个短请求不合并计长价", async t => {
  const dataDir = await useTempDir(t);
  const codexHome = join(dataDir, "codex-home");
  await mkdir(codexHome);
  const usage = protocolUsage({ input:150000,cached:100000,output:10000 });
  const events = [
    event("start", "turn-started", "thread-sol", "turn-sol", { model:"gpt-6.1-sol" }),
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
  assert.equal(turn.model, "gpt-6.1-sol");
  assert.equal(turn.totalTokens, 320000);
  assert.equal(turn.cost.available, true);
  assert.deepEqual(turn.cost.contextTiers, ["short"]);
  assert.ok(Math.abs(turn.cost.total - 0.42) < 1e-10);
  assert.equal(turn.cost.cumulativeAvailable, true);
  assert.ok(Math.abs(turn.cost.cumulativeCny - turn.cost.totalCny) < 1e-10);
  const loadedCache = JSON.parse(await readFile(restored.cachePath, "utf8"));
  assert.equal(loadedCache.version, originalCache.version, "价格更新不改变已兼容的 Token 缓存结构");
  await restored.flush();
});
