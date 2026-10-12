import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  accumulateTokenCost,
  getOpenAIShortContextRates,
  resolveContextTier,
  TokenPricingManager,
} from "../src/token-pricing.mjs";
import { useTempDir } from "./helpers.mjs";

test("OpenAI 计价正确拆分普通输入、缓存命中、缓存写入和输出", () => {
  const pricing = new TokenPricingManager({ fetchImpl: null });
  const cost = pricing.calculate("gpt-5.6-sol", {
    input_tokens: 200_000,
    cached_input_tokens: 200_000,
    output_tokens: 50_000,
    reasoning_output_tokens: 10_000,
    total_tokens: 250_000,
  });

  assert.equal(cost.contextTier, "short");
  assert.equal(cost.components.ordinaryInput, 0);
  assert.ok(Math.abs(cost.components.cachedInput - 0.08) < Number.EPSILON);
  assert.equal(cost.components.cacheWriteInput, 0);
  assert.equal(cost.components.output, 1);
  assert.ok(Math.abs(cost.total - 1.08) < Number.EPSILON);
  assert.equal(cost.components.reasoningOutput, 0.2);
});

test("长上下文按单次请求分层，显式短上下文可以覆盖自动判断", () => {
  const pricing = new TokenPricingManager({ fetchImpl: null });
  assert.equal(resolveContextTier("gpt-6-astra", 272_001), "long");
  assert.equal(resolveContextTier("deepseek-flash", 999_999), "standard");
  assert.equal(resolveContextTier("deepseek-v4-flash", 999_999), "standard");
  assert.equal(pricing.calculate("gpt-6-astra", { input_tokens: 300_000 }).contextTier, "long");
  assert.equal(
    pricing.calculate("gpt-6-astra", { input_tokens: 300_000 }, { contextTier: "short" }).contextTier,
    "short",
  );
});

test("GPT-6.1 Sol、GPT-6 Sol 和 Luna 按官方 Standard 短、长上下文价格计算缓存写入", () => {
  const pricing = new TokenPricingManager({ fetchImpl: null });
  for (const [model, shortRates, longRates] of [
    ["gpt-6.1-sol", [2, 0.1, 2.5, 10], [4, 0.2, 5, 15]],
    ["gpt-6-sol", [2, 0.2, 2.5, 10], [4, 0.4, 5, 15]],
    ["gpt-6-luna", [0.1, 0.01, 0.125, 0.5], [0.2, 0.02, 0.25, 0.75]],
  ]) {
    for (const [contextTier, expected] of [["short", shortRates], ["long", longRates]]) {
      const cost = pricing.calculate(model, {
        input_tokens: 3_000_000,
        cached_input_tokens: 1_000_000,
        cache_write_input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      }, { contextTier });
      assert.equal(cost.available, true);
      assert.equal(cost.contextTier, contextTier);
      assert.deepEqual(Object.values(cost.rates), expected);
      assert.equal(cost.total, expected[0] + expected[1] + expected[2] + expected[3]);
    }
  }
});

test("GPT-6.1 Sol 按请求输入跨过 272K 后全请求计长价，缓存价不借用旧 Sol", () => {
  const pricing = new TokenPricingManager({ fetchImpl: null });
  const usage = { input_tokens: 272_000, cached_input_tokens: 100_000,
    cache_write_input_tokens: 50_000, output_tokens: 10_000, reasoning_output_tokens: 5_000 };
  const short = pricing.calculate("gpt-6.1-sol", usage);
  const long = pricing.calculate("gpt-6.1-sol", { ...usage, input_tokens: 272_001 });
  assert.equal(short.contextTier, "short");
  assert.equal(long.contextTier, "long");
  assert.ok(Math.abs(short.total - 0.479) < 1e-10);
  assert.ok(Math.abs(long.total - 0.908004) < 1e-10);
  assert.equal(short.components.reasoningOutput, 0.05);
  assert.equal(getOpenAIShortContextRates("gpt-6.1-sol").cachedInput, 0.1);
  assert.equal(getOpenAIShortContextRates("gpt-6-sol").cachedInput, 0.2);
  const repeated = accumulateTokenCost(short, short);
  assert.deepEqual(repeated.contextTiers, ["short"]);
  assert.ok(Math.abs(repeated.total - short.total * 2) < 1e-10);
});

test("未知模型、缺失缓存写入价格和跨供应商聚合不会显示不完整费用", () => {
  const pricing = new TokenPricingManager({ fetchImpl: null });
  assert.equal(pricing.calculate("unknown", {}).available, false);
  assert.match(
    pricing.calculate("gpt-5.5", { input_tokens: 10, cache_write_input_tokens: 5 }).reason,
    /缓存写入/,
  );
  const openai = pricing.calculate("gpt-5.6-luna", { input_tokens: 1_000 });
  const deepseek = pricing.calculate("deepseek-flash", { input_tokens: 1_000 });
  assert.equal(accumulateTokenCost(openai, deepseek).available, false);
  assert.equal(accumulateTokenCost(openai, pricing.calculate("unknown", {})).available, false);
});

test("同供应商分段费用可累计，模型别名使用对应价格", () => {
  const pricing = new TokenPricingManager({ fetchImpl: null });
  assert.deepEqual(getOpenAIShortContextRates("gpt-5.6"), getOpenAIShortContextRates("gpt-5.6-sol"));
  const first = pricing.calculate("gpt-5.6-sol", { input_tokens: 100, output_tokens: 20 });
  const second = pricing.calculate("gpt-5.6-terra", { input_tokens: 50, output_tokens: 10 });
  const total = accumulateTokenCost(first, second);
  assert.equal(total.available, true);
  assert.equal(total.normalizedModel, "multiple");
  assert.equal(total.tokenUsage.input_tokens, 150);
  assert.equal(total.tokenUsage.output_tokens, 30);
});

test("汇率读取、抓取、缓存和人民币视图使用可控数据源", async (t) => {
  const dataDir = await useTempDir(t);
  await writeFile(join(dataDir, "usd-cny-exchange-rate.json"), JSON.stringify({
    rate: 7,
    date: "2026-09-01",
    fetchedAt: 1,
  }));
  let requests = 0;
  const pricing = new TokenPricingManager({
    dataDir,
    fetchImpl: async () => {
      requests += 1;
      return new Response(
        '<table><tr class="first"><td>2026-09-11</td><td>688.88</td></tr></table>',
      );
    },
  });
  await pricing.initialize();
  const refreshed = await pricing.refreshExchangeRate({ force: true });
  assert.equal(refreshed.rate, 6.8888);
  assert.ok(requests >= 1);
  const view = pricing.toViewModel(pricing.calculate("gpt-5.6-luna", { input_tokens: 1_000_000 }));
  assert.equal(view.totalCny, 0.4 * 6.8888);
  assert.equal(JSON.parse(await readFile(pricing.cachePath, "utf8")).date, "2026-09-11");
});
