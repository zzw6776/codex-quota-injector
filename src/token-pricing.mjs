import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { defaultAccountDataDir } from "./platform.mjs";

const MILLION = 1_000_000;
const TOKEN_USAGE_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
];
const LONG_CONTEXT_THRESHOLD = 272_000;
const EXCHANGE_RATE_REFRESH_MS = 6 * 60 * 60 * 1000;
const EXCHANGE_RATE_RETRY_MS = 30 * 60 * 1000;
const EXCHANGE_RATE_URL = "https://www.safe.gov.cn/AppStructured/hlw/RMBQuery.do";
const EXCHANGE_RATE_SOURCE = "国家外汇管理局人民币汇率中间价";
const FALLBACK_EXCHANGE_RATE = Object.freeze({
  rate: 6.7884,
  date: "2026-08-10",
  fetchedAt: 0,
  source: EXCHANGE_RATE_SOURCE,
  sourceUrl: EXCHANGE_RATE_URL,
  fallback: true,
});

const DEEPSEEK_PRICES = Object.freeze({
  "deepseek-v4-flash": priceTier(1, 0.02, 1, 2),
  "deepseek-v4-pro": priceTier(3, 0.025, 3, 6),
});

const OPENAI_PRICES = Object.freeze({
  "gpt-5.6-sol": modelPrice(
    priceTier(5, 0.5, 6.25, 30),
    priceTier(10, 1, 12.5, 45),
  ),
  "gpt-5.6-terra": modelPrice(
    priceTier(2, 0.2, 2.5, 12),
    priceTier(4, 0.4, 5, 18),
  ),
  "gpt-5.6-luna": modelPrice(
    priceTier(0.2, 0.02, 0.25, 1.2),
    priceTier(0.4, 0.04, 0.5, 1.8),
  ),
  "gpt-5.5": modelPrice(
    priceTier(5, 0.5, null, 30),
    priceTier(10, 1, null, 45),
  ),
  "gpt-5.4": modelPrice(
    priceTier(2.5, 0.25, null, 15),
    priceTier(5, 0.5, null, 22.5),
  ),
  "gpt-5.4-mini": modelPrice(priceTier(0.75, 0.075, null, 4.5)),
});

const MODEL_ALIASES = Object.freeze({
  "gpt-5.6": "gpt-5.6-sol",
  "gpt-5.6-sol-wm": "gpt-5.6-sol",
});

export class TokenPricingManager {
  constructor({
    dataDir = defaultAccountDataDir(),
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.cachePath = join(dataDir, "usd-cny-exchange-rate.json");
    this.fetchImpl = fetchImpl;
    this.exchangeRate = { ...FALLBACK_EXCHANGE_RATE };
    this.lastRefreshAttemptAt = 0;
    this.refreshPromise = null;
    this.changeListeners = new Set();
  }

  onChange(listener) {
    if (typeof listener !== "function") return () => {};
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  async initialize() {
    const cached = normalizeExchangeRate(await readJson(this.cachePath));
    if (cached) this.exchangeRate = cached;
    // A stale exchange rate is acceptable for the first paint. Refresh in the
    // background so Token usage and rollout parsing are not gated by network
    // latency or the six-second request timeout.
    void this.refreshExchangeRate({ force: true }).catch((error) => {
      console.error(`[exchange-rate] ${error.message}`);
    });
    return this.exchangeRate;
  }

  async refreshExchangeRate({ force = false } = {}) {
    if (this.refreshPromise) return this.refreshPromise;
    const now = Date.now();
    const retryAfter = this.exchangeRate.fallback
      ? EXCHANGE_RATE_RETRY_MS
      : EXCHANGE_RATE_REFRESH_MS;
    if (!force && now - this.lastRefreshAttemptAt < retryAfter) return this.exchangeRate;
    this.lastRefreshAttemptAt = now;
    const task = this.#fetchExchangeRate()
      .catch((error) => {
        console.error(`[exchange-rate] ${error.message}`);
        return this.exchangeRate;
      })
      .finally(() => {
        if (this.refreshPromise === task) this.refreshPromise = null;
      });
    this.refreshPromise = task;
    return task;
  }

  calculate(model, usage) {
    const requestedModel = String(model ?? "").trim();
    const normalizedModel = MODEL_ALIASES[requestedModel] ?? requestedModel;
    if (DEEPSEEK_PRICES[normalizedModel]) {
      return calculateWithTier({
        requestedModel,
        normalizedModel,
        provider: "deepseek",
        currency: "CNY",
        label: "本轮预估费用",
        contextTier: "standard",
        rates: DEEPSEEK_PRICES[normalizedModel],
        usage,
      });
    }

    const modelPricing = OPENAI_PRICES[normalizedModel];
    if (!modelPricing) {
      return unavailableCost(requestedModel, "当前模型没有对应的官方价格配置");
    }
    const inputTokens = positiveNumber(usage?.input_tokens);
    const longContext = inputTokens > LONG_CONTEXT_THRESHOLD;
    const rates = longContext ? modelPricing.long : modelPricing.short;
    if (!rates) {
      return unavailableCost(requestedModel, "当前模型没有长上下文价格");
    }
    return calculateWithTier({
      requestedModel,
      normalizedModel,
      provider: "openai",
      currency: "USD",
      label: "API参考价",
      contextTier: longContext ? "long" : "short",
      rates,
      usage,
    });
  }

  toViewModel(cost) {
    if (!cost) return unavailableCost("", "没有获取到本轮模型价格信息");
    if (!cost.available) return { ...cost };
    const exchangeRate = cost.currency === "USD" ? this.exchangeRate.rate : 1;
    const convert = (value) => positiveNumber(value) * exchangeRate;
    const viewModel = {
      ...cost,
      totalCny: convert(cost.total),
      componentsCny: {
        ordinaryInput: convert(cost.components?.ordinaryInput),
        cachedInput: convert(cost.components?.cachedInput),
        cacheWriteInput: convert(cost.components?.cacheWriteInput),
        output: convert(cost.components?.output),
        reasoningOutput: convert(cost.components?.reasoningOutput),
      },
      exchangeRate: cost.currency === "USD" ? { ...this.exchangeRate } : null,
    };
    if (Array.isArray(cost.tiers)) {
      viewModel.tiers = cost.tiers.map((tier) => this.toViewModel(tier));
    }
    return viewModel;
  }

  async #fetchExchangeRate() {
    if (typeof this.fetchImpl !== "function") throw new Error("当前 Node.js 环境不支持获取汇率");
    const response = await this.fetchImpl(EXCHANGE_RATE_URL, {
      headers: { "User-Agent": "Codex-Quota-Injector/1.0" },
      signal: AbortSignal.timeout(6_000),
    });
    if (!response.ok) throw new Error(`汇率请求失败：HTTP ${response.status}`);
    const html = await response.text();
    const match = html.match(
      /<tr\s+class=["']first["'][^>]*>[\s\S]*?<td[^>]*>\s*(\d{4}-\d{2}-\d{2})\s*<\/td>\s*<td[^>]*>\s*([\d.]+)\s*<\/td>/i,
    );
    if (!match) throw new Error("无法从国家外汇管理局页面识别最新美元汇率");
    const rate = Number(match[2]) / 100;
    if (!Number.isFinite(rate) || rate <= 0) throw new Error("国家外汇管理局返回了无效美元汇率");
    const next = {
      rate,
      date: match[1],
      fetchedAt: Date.now(),
      source: EXCHANGE_RATE_SOURCE,
      sourceUrl: EXCHANGE_RATE_URL,
      fallback: false,
    };
    this.exchangeRate = next;
    for (const listener of this.changeListeners) {
      try {
        listener(next);
      } catch (error) {
        console.error(`[exchange-rate] 汇率变更监听器失败: ${error.message}`);
      }
    }
    await writeJsonAtomic(this.cachePath, next).catch((error) => {
      console.error(`[exchange-rate] 无法保存汇率缓存: ${error.message}`);
    });
    return next;
  }
}

export function accumulateTokenCost(current, next) {
  if (!next?.available) {
    if (current?.available) {
      return unavailableCost(
        current.requestedModel || next?.requestedModel,
        next?.reason || "本轮部分请求无法计算费用",
      );
    }
    return current ? { ...current } : { ...next };
  }
  // Once a segment is unknown or otherwise unavailable, do not revive the
  // aggregate with later known segments. Reviving would display a partial
  // cost while silently dropping the unknown tokens.
  if (current && !current.available) return { ...current };
  if (!current) return cloneCost(next);
  if (current.currency !== next.currency || current.provider !== next.provider) {
    return unavailableCost(next.requestedModel, "同一轮包含不同的模型供应商，无法合并费用");
  }
  const contextTiers = new Set([...(current.contextTiers ?? []), next.contextTier]);
  return {
    ...current,
    normalizedModel: current.normalizedModel === next.normalizedModel
      ? current.normalizedModel
      : "multiple",
    total: current.total + next.total,
    components: addComponents(current.components, next.components),
    tokenUsage: addTokenUsage(current.tokenUsage, next.tokenUsage),
    contextTiers: [...contextTiers],
  };
}

function calculateWithTier({
  requestedModel,
  normalizedModel,
  provider,
  currency,
  label,
  contextTier,
  rates,
  usage,
}) {
  const inputTokens = positiveNumber(usage?.input_tokens);
  const cachedInputTokens = Math.min(inputTokens, positiveNumber(usage?.cached_input_tokens));
  const cacheWriteInputTokens = Math.min(
    Math.max(0, inputTokens - cachedInputTokens),
    positiveNumber(usage?.cache_write_input_tokens),
  );
  const ordinaryInputTokens = Math.max(
    0,
    inputTokens - cachedInputTokens - cacheWriteInputTokens,
  );
  const outputTokens = positiveNumber(usage?.output_tokens);
  const reasoningOutputTokens = Math.min(
    outputTokens,
    positiveNumber(usage?.reasoning_output_tokens),
  );
  if (cacheWriteInputTokens > 0 && rates.cacheWriteInput == null) {
    return unavailableCost(requestedModel, "本轮包含缓存写入，但官方价格没有对应单价");
  }
  const cacheWriteRate = rates.cacheWriteInput ?? rates.ordinaryInput;
  const components = {
    ordinaryInput: ordinaryInputTokens / MILLION * rates.ordinaryInput,
    cachedInput: cachedInputTokens / MILLION * rates.cachedInput,
    cacheWriteInput: cacheWriteInputTokens / MILLION * cacheWriteRate,
    output: outputTokens / MILLION * rates.output,
    reasoningOutput: reasoningOutputTokens / MILLION * rates.output,
  };
  return {
    available: true,
    requestedModel,
    normalizedModel,
    provider,
    currency,
    label,
    pricingMode: provider === "openai" ? "standard-api" : "api",
    contextTier,
    contextTiers: [contextTier],
    rates: { ...rates, cacheWriteInput: cacheWriteRate },
    tokenUsage: Object.fromEntries(
      TOKEN_USAGE_FIELDS.map((field) => [field, positiveNumber(usage?.[field])]),
    ),
    components,
    total: components.ordinaryInput + components.cachedInput +
      components.cacheWriteInput + components.output,
  };
}

function unavailableCost(requestedModel, reason) {
  return {
    available: false,
    requestedModel: String(requestedModel ?? ""),
    reason,
  };
}

function cloneCost(cost) {
  return {
    ...cost,
    rates: { ...cost.rates },
    components: { ...cost.components },
    tokenUsage: { ...cost.tokenUsage },
    contextTiers: [...(cost.contextTiers ?? [])],
  };
}

function addTokenUsage(left = {}, right = {}) {
  return Object.fromEntries(
    TOKEN_USAGE_FIELDS.map((field) => [
      field,
      positiveNumber(left[field]) + positiveNumber(right[field]),
    ]),
  );
}

function addComponents(left = {}, right = {}) {
  return {
    ordinaryInput: positiveNumber(left.ordinaryInput) + positiveNumber(right.ordinaryInput),
    cachedInput: positiveNumber(left.cachedInput) + positiveNumber(right.cachedInput),
    cacheWriteInput: positiveNumber(left.cacheWriteInput) + positiveNumber(right.cacheWriteInput),
    output: positiveNumber(left.output) + positiveNumber(right.output),
    reasoningOutput: positiveNumber(left.reasoningOutput) + positiveNumber(right.reasoningOutput),
  };
}

function priceTier(ordinaryInput, cachedInput, cacheWriteInput, output) {
  return Object.freeze({ ordinaryInput, cachedInput, cacheWriteInput, output });
}

function modelPrice(short, long = null) {
  return Object.freeze({ short, long });
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function normalizeExchangeRate(value) {
  const rate = Number(value?.rate);
  const date = String(value?.date ?? "");
  if (!Number.isFinite(rate) || rate <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return {
    rate,
    date,
    fetchedAt: positiveNumber(value?.fetchedAt),
    source: EXCHANGE_RATE_SOURCE,
    sourceUrl: EXCHANGE_RATE_URL,
    fallback: false,
  };
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}
