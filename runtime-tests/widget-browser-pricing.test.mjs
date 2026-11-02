import assert from "node:assert/strict";
import test from "node:test";
import { TokenPricingManager } from "../src/token-pricing.mjs";
import { waitFor } from "../test/helpers.mjs";
import { fixtureData, startBrowser } from "./support/browser.mjs";

test("[UI-04] DeepSeek 峰谷区间在本轮、累计和费用提示中一致展示", { timeout: 30_000 }, async t => {
  const b = await startBrowser(t);
  const pricing = new TokenPricingManager({ fetchImpl: null });
  const cost = pricing.toViewModel(pricing.calculate("deepseek-flash", {
    input_tokens: 1_000_000, output_tokens: 1_000_000,
  }));
  await b.update(fixtureData({ tokenUsage: { status: "ready", turns: [{
    turnId: "turn-b", totalTokens: 2_000_000, inputTokens: 1_000_000, outputTokens: 1_000_000,
    cumulativeTotalTokens: 4_000_000, completed: true, updatedAt: 1,
    model: "deepseek-flash", generationDetails: [],
    cost: { ...cost, cumulativeAvailable: true, cumulativeCny: 24,
      cumulativeRangeCny: { min: 12, max: 24 } },
  }] } }));
  const line = '[data-codex-token-usage="turn-b"]';
  assert.match(await b.value(line, "textContent", false), /价格 ¥5\.00–¥10\.00/);
  const pointer = await b.client.evaluate(`(() => {
    const rect=document.querySelector(${JSON.stringify(line)}).getBoundingClientRect();
    return {x:rect.left+40,y:rect.top+rect.height/2};
  })()`);
  await b.client.request("Input.dispatchMouseEvent", { type: "mouseMoved", ...pointer });
  const text = await waitFor(() => b.client.evaluate(
    'document.querySelector("#codex-token-usage-tooltip:not([hidden])")?.textContent || null',
  ));
  assert.match(text, /Token 预估费用 ¥5\.00–¥10\.00/);
  assert.match(text, /累计 Token 估价¥12\.00–¥24\.00/);
  assert.match(text, /明细按高峰价，空闲半价/);
  assert.match(text, /未含搜索、抓取等按次费用/);
});
