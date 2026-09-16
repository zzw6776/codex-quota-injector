function createUsageTooltip(dependencies) {
  const { state } = dependencies;
  const conversationTooltipPointer = (...args) => dependencies.conversationTooltipPointer(...args);
  const appendGenerationDetails = (...args) => dependencies.appendGenerationDetails(...args);
  const syncConversationScrollbarPadding = (...args) => dependencies.syncConversationScrollbarPadding(...args);
  const conversationSubagentLabel = (...args) => dependencies.conversationSubagentLabel(...args);
  const formatContextTier = (...args) => dependencies.formatContextTier(...args);
  const formatUnitPrice = (...args) => dependencies.formatUnitPrice(...args);
  const ensureConversationTokenTooltip = (...args) => dependencies.ensureConversationTokenTooltip(...args);
  const positionConversationTokenTooltip = (...args) => dependencies.positionConversationTokenTooltip(...args);
  const clearConversationTooltipTimer = (...args) => dependencies.clearConversationTooltipTimer(...args);
  const isLightTheme = (...args) => dependencies.isLightTheme(...args);
  const formatTokenCount = (...args) => dependencies.formatTokenCount(...args);
  const formatCny = (...args) => dependencies.formatCny(...args);
  const formatTooltipPercent = (...args) => dependencies.formatTooltipPercent(...args);
  const formatExchangeRate = (...args) => dependencies.formatExchangeRate(...args);

function showConversationTokenTooltip(line, event = null) {
    clearConversationTooltipTimer();
    const usage = line?.__codexTokenUsage;
    if (!usage) return;
    const tooltip = ensureConversationTokenTooltip();
    const lightTheme = isLightTheme();
    tooltip.style.background = lightTheme ? "#fff" : "#24242d";
    tooltip.style.color = lightTheme ? "#202124" : "#f4f4f7";
    tooltip.style.boxShadow = lightTheme
      ? "0 10px 28px rgba(0,0,0,.18)"
      : "0 10px 28px rgba(0,0,0,.38)";
    const cost = usage.cost ?? {};
    const subagentLabel = conversationSubagentLabel(usage);
    tooltip.replaceChildren();

    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin-bottom:8px;font-weight:650";
    const title = document.createElement("span");
    const modelLabel = cost.normalizedModel || cost.requestedModel || usage.model || "Token 费用明细";
    title.textContent = subagentLabel ? `${subagentLabel} · ${modelLabel}` : modelLabel;
    const total = document.createElement("strong");
    total.style.cssText = "font-variant-numeric:tabular-nums;white-space:nowrap";
    const totalLabel = usage.completed ? (cost.label ?? "本轮费用") : "实时估算";
    total.textContent = cost.available
      ? `${totalLabel} ${formatCny(cost.totalCny)}`
      : "费用暂不可算";
    header.append(title, total);
    tooltip.append(header);

    const rows = document.createElement("div");
    rows.style.cssText = "display:grid;gap:5px;padding:7px 0;border-top:1px solid rgba(127,127,127,.2);border-bottom:1px solid rgba(127,127,127,.2)";
    const tiers = getConversationTooltipTiers(cost, usage);
    const inputSummary = summarizeConversationTooltipInput(tiers);
    appendConversationTooltipSummaryRow(
      rows,
      "输入总量",
      inputSummary.inputTokens,
      cost.available && inputSummary.available ? inputSummary.costCny : null,
    );
    const appendTierRows = (label, component, tokenCount) => {
      for (const tier of tiers) {
        appendConversationTooltipRow(
          rows,
          `${label}${tier.labelSuffix}`,
          tokenCount(tier.usage),
          tier.cost,
          component,
        );
      }
    };
    appendTierRows(
      "未缓存输入",
      "ordinaryInput",
      (tierUsage) => tierUsage.input_tokens - tierUsage.cached_input_tokens - tierUsage.cache_write_input_tokens,
    );
    appendTierRows("缓存输入", "cachedInput", (tierUsage) => tierUsage.cached_input_tokens);
    appendTierRows("缓存写入", "cacheWriteInput", (tierUsage) => tierUsage.cache_write_input_tokens);
    appendConversationTooltipMetricRow(
      rows,
      "缓存命中率",
      formatTooltipPercent(inputSummary.inputTokens > 0
        ? inputSummary.cachedInputTokens / inputSummary.inputTokens * 100
        : null),
      `${formatTokenCount(inputSummary.cachedInputTokens)} / ${formatTokenCount(inputSummary.inputTokens)}`,
    );
    appendTierRows("输出", "output", (tierUsage) => tierUsage.output_tokens);

    appendGenerationDetails(rows, usage);

    const reasoningTiers = tiers.filter((tier) => tier.usage.reasoning_output_tokens > 0);
    if (reasoningTiers.length > 0) {
      const details = document.createElement("details");
      details.style.cssText = "margin-top:2px;padding-top:5px;border-top:1px solid rgba(127,127,127,.14)";
      const summary = document.createElement("summary");
      const reasoningTokens = reasoningTiers.reduce(
        (totalTokens, tier) => totalTokens + tier.usage.reasoning_output_tokens,
        0,
      );
      summary.textContent = `显示推理输出 ${formatTokenCount(reasoningTokens)}（已计入输出）`;
      summary.style.cssText = "cursor:pointer;color:var(--color-token-text-tertiary,#9a9aa4);font-size:10px;user-select:none";
      const reasoningRows = document.createElement("div");
      reasoningRows.style.cssText = "display:grid;gap:5px;margin-top:5px";
      for (const tier of reasoningTiers) {
        appendConversationTooltipRow(
          reasoningRows,
          `推理输出${tier.labelSuffix}`,
          tier.usage.reasoning_output_tokens,
          tier.cost,
          "reasoningOutput",
          "已包含在输出费用中",
          "output",
        );
      }
      details.append(summary, reasoningRows);
      rows.append(details);
    }
    tooltip.append(rows);

    const cumulative = document.createElement("div");
    cumulative.style.cssText = "display:flex;align-items:baseline;justify-content:space-between;gap:16px;padding-top:7px;font-weight:650";
    const cumulativeLabel = document.createElement("span");
    cumulativeLabel.textContent = "累计费用";
    const cumulativeAmount = document.createElement("strong");
    cumulativeAmount.style.cssText = "font-variant-numeric:tabular-nums;white-space:nowrap";
    cumulativeAmount.textContent = cost.cumulativeAvailable
      ? formatCny(cost.cumulativeCny)
      : Number(cost.cumulativeCny) > 0
        ? `已确认 ${formatCny(cost.cumulativeCny)} · 待确认 ${Number(cost.cumulativePendingTurns) || 1} 轮`
        : "待确认";
    cumulative.append(cumulativeLabel, cumulativeAmount);
    tooltip.append(cumulative);

    const footer = document.createElement("div");
    footer.style.cssText = "display:grid;gap:2px;margin-top:7px;color:var(--color-token-text-tertiary,#9a9aa4);font-size:10px;line-height:15px";
    const pricing = document.createElement("span");
    if (cost.provider === "openai") {
      const hasShort = Array.isArray(cost.contextTiers) && cost.contextTiers.includes("short");
      const hasLong = Array.isArray(cost.contextTiers) && cost.contextTiers.includes("long");
      let tiersText = "短上下文";
      if (hasShort && hasLong) {
        tiersText = "混合上下文";
      } else if (hasLong) {
        tiersText = "长上下文";
      }
      pricing.textContent = `OpenAI 标准 API 价格 · ${tiersText}`;
    } else if (cost.provider === "deepseek") {
      pricing.textContent = "DeepSeek API 官方价格";
    } else {
      pricing.textContent = cost.reason || "当前模型没有可用价格";
    }
    footer.append(pricing);
    if (usage.isSubagent) {
      const scope = document.createElement("span");
      scope.textContent = usage.isSubagentSummary
        ? "该行仅汇总此子智能体，未并入主智能体本轮数据"
        : "该行是子智能体本轮数据；父任务页面另有独立汇总行";
      footer.append(scope);
    }
    if (cost.exchangeRate) {
      const exchange = document.createElement("span");
      exchange.textContent = `汇率 1 USD = ${formatExchangeRate(cost.exchangeRate.rate)} CNY · ${cost.exchangeRate.date} · ${cost.exchangeRate.source}${cost.exchangeRate.fallback ? "（内置备用值）" : ""}`;
      footer.append(exchange);
    }
    tooltip.append(footer);

    state.conversationTooltipTarget = line;
    state.conversationTooltipPointer = conversationTooltipPointer(event, line);
    tooltip.hidden = false;
    tooltip.style.visibility = "hidden";
    syncConversationScrollbarPadding(tooltip);
    positionConversationTokenTooltip(line, tooltip);
    tooltip.style.visibility = "visible";
  }

function appendConversationTooltipRow(
    container,
    label,
    tokens,
    cost,
    component,
    note = "",
    unitComponent = component,
  ) {
    const row = document.createElement("div");
    row.style.cssText = "display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:baseline;gap:16px";
    const name = document.createElement("span");
    name.style.cssText = "color:var(--color-token-text-secondary,#b2b2bc)";
    const unitPrice = cost.available ? formatUnitPrice(cost, unitComponent) : "未知";
    name.textContent = `${label} ${formatTokenCount(tokens)} · ${unitPrice}`;
    const amount = document.createElement("span");
    amount.style.cssText = "font-variant-numeric:tabular-nums;white-space:nowrap";
    amount.textContent = cost.available
      ? `${formatCny(cost.componentsCny?.[component])}${note ? `（${note}）` : ""}`
      : "暂不可算";
    row.append(name, amount);
    container.append(row);
  }

function appendConversationTooltipSummaryRow(container, label, tokens, amount) {
    const row = document.createElement("div");
    row.style.cssText = "display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:baseline;gap:16px;font-weight:650";
    const name = document.createElement("span");
    name.textContent = `${label} ${formatTokenCount(tokens)}`;
    const total = document.createElement("span");
    total.style.cssText = "font-variant-numeric:tabular-nums;white-space:nowrap";
    total.textContent = amount == null ? "暂不可算" : formatCny(amount);
    row.append(name, total);
    container.append(row);
  }

function appendConversationTooltipMetricRow(container, label, value, detail) {
    const row = document.createElement("div");
    row.style.cssText = "display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:baseline;gap:16px;color:var(--color-token-text-tertiary,#9a9aa4);font-size:10px";
    const name = document.createElement("span");
    name.textContent = `${label} ${value}`;
    const denominator = document.createElement("span");
    denominator.style.cssText = "font-variant-numeric:tabular-nums;white-space:nowrap";
    denominator.textContent = detail;
    row.append(name, denominator);
    container.append(row);
  }

function summarizeConversationTooltipInput(tiers) {
    return tiers.reduce((summary, tier) => {
      const usage = tier.usage;
      summary.inputTokens += usage.input_tokens;
      summary.cachedInputTokens += usage.cached_input_tokens;
      summary.cacheWriteInputTokens += usage.cache_write_input_tokens;
      if (!tier.cost?.available) {
        summary.available = false;
        return summary;
      }
      summary.costCny += ["ordinaryInput", "cachedInput", "cacheWriteInput"]
        .reduce((total, component) => total + (Number(tier.cost.componentsCny?.[component]) || 0), 0);
      return summary;
    }, {
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      costCny: 0,
      available: true,
    });
  }

function getConversationTooltipTiers(cost, usage) {
    const fallbackUsage = {
      input_tokens: Number(usage.inputTokens || 0),
      cached_input_tokens: Number(usage.cachedInputTokens || 0),
      cache_write_input_tokens: Number(usage.cacheWriteInputTokens || 0),
      output_tokens: Number(usage.outputTokens || 0),
      reasoning_output_tokens: Number(usage.reasoningOutputTokens || 0),
      total_tokens: Number(usage.totalTokens || 0),
    };
    const tiers = Array.isArray(cost?.tiers) && cost.tiers.length > 0
      ? cost.tiers.map((tier) => ({ cost: tier, usage: tier.tokenUsage ?? {} }))
      : [{ cost, usage: fallbackUsage }];
    const models = new Set(tiers.map((tier) => tier.cost?.normalizedModel).filter(Boolean));
    const contextTiers = new Set(tiers.map((tier) => tier.cost?.contextTier).filter(Boolean));
    const showModel = models.size > 1;
    const isMixed = contextTiers.has("short") && contextTiers.has("long");
    const isPureLong = contextTiers.has("long") && !contextTiers.has("short");
    return tiers.map((tier) => {
      const tierName = tier.cost?.contextTier;
      let contextLabel = "";
      if (isMixed) {
        contextLabel = formatContextTier(tierName);
      } else if (isPureLong && tierName === "long") {
        contextLabel = "长";
      }
      const labels = [
        showModel ? tier.cost?.normalizedModel : "",
        contextLabel,
      ].filter(Boolean);
      return {
        ...tier,
        usage: normalizeTooltipUsage(tier.usage),
        labelSuffix: labels.length > 0 ? `（${labels.join(" · ")}）` : "",
      };
    });
  }

function normalizeTooltipUsage(usage) {
    return {
      input_tokens: Math.max(0, Number(usage?.input_tokens) || 0),
      cached_input_tokens: Math.max(0, Number(usage?.cached_input_tokens) || 0),
      cache_write_input_tokens: Math.max(0, Number(usage?.cache_write_input_tokens) || 0),
      output_tokens: Math.max(0, Number(usage?.output_tokens) || 0),
      reasoning_output_tokens: Math.max(0, Number(usage?.reasoning_output_tokens) || 0),
      total_tokens: Math.max(0, Number(usage?.total_tokens) || 0),
    };
  }

  return { showConversationTokenTooltip, appendConversationTooltipRow, appendConversationTooltipSummaryRow, appendConversationTooltipMetricRow, summarizeConversationTooltipInput, getConversationTooltipTiers, normalizeTooltipUsage };
}

export { createUsageTooltip };
