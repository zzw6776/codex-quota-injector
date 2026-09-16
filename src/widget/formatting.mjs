// Browser-serializable factory: all external values arrive through this explicit boundary.
function createFormatting() {
  function formatContextTier(value) {
    return value === "short" ? "短" : value === "long" ? "长" : "标准";
  }

  function formatUnitPrice(cost, component) {
    if (!cost?.available) return "未知";
    if (cost.normalizedModel === "multiple" ||
      (Array.isArray(cost.contextTiers) && cost.contextTiers.length > 1)) {
      return "未知";
    }
    const rate = Number(cost.rates?.[component]);
    const exchangeRate = cost.currency === "USD"
      ? Number(cost.exchangeRate?.rate)
      : 1;
    if (!Number.isFinite(rate) || rate < 0 || !Number.isFinite(exchangeRate) || exchangeRate <= 0) {
      return "未知";
    }
    return `${formatCny(rate * exchangeRate)}/M`;
  }

  function isLightTheme() {
    return document.documentElement.classList.contains("electron-light") ||
      (!document.documentElement.classList.contains("electron-dark") &&
        window.matchMedia?.("(prefers-color-scheme: light)").matches);
  }

  function formatReset(seconds) {
    if (!Number.isFinite(Number(seconds))) return "未知";
    const date = new Date(Number(seconds) * 1000);
    if (Number.isNaN(date.getTime())) return "未知";
    const diffMinutes = Math.floor((date.getTime() - Date.now()) / 60_000);
    const relative = diffMinutes <= 0 ? "已重置" : diffMinutes >= 1_440 ? `${Math.floor(diffMinutes / 1_440)}天${Math.floor((diffMinutes % 1_440) / 60)}小时` : diffMinutes >= 60 ? `${Math.floor(diffMinutes / 60)}小时${diffMinutes % 60}分` : `${Math.max(1, diffMinutes)}分`;
    return `${relative}（${new Intl.DateTimeFormat(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date)}）`;
  }

  function formatExpiry(value) {
    if (!value) return "未获取";
    const raw = String(value).trim();
    const numeric = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    const date = Number.isFinite(numeric)
      ? new Date(numeric > 1_000_000_000_000 ? numeric : numeric * 1000)
      : new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const days = Math.ceil((date.getTime() - Date.now()) / 86_400_000);
    const prefix = days < 0 ? "已到期" : days === 0 ? "今天到期" : `${days} 天后`;
    return `${prefix}（${new Intl.DateTimeFormat(undefined, { year: "numeric", month: "2-digit", day: "2-digit" }).format(date)}）`;
  }

  function formatUpdatedAt(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return "从未成功刷新";
    const date = new Date(numeric > 1_000_000_000_000 ? numeric : numeric * 1000);
    if (Number.isNaN(date.getTime())) return "从未成功刷新";
    return new Intl.DateTimeFormat(undefined, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(date);
  }

  function formatPlan(value) {
    const raw = String(value ?? "未知").trim();
    const normalized = raw.toLowerCase().replaceAll(/[_\s-]/g, "");
    const names = {
      chatgptplusplan: "Plus", plus: "Plus",
      chatgptpro: "Pro", chatgptproplan: "Pro", pro: "Pro",
      chatgptteamplan: "Team", team: "Team",
      business: "Business", enterprise: "Enterprise",
      free: "Free", apikey: "API Key", oauth: "OAuth",
    };
    return names[normalized] ?? raw;
  }

  function levelClass(remaining) {
    if (Number(remaining) < 10) return "is-critical";
    if (Number(remaining) < 20) return "is-warning";
    return "";
  }

  function formatContextValue(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return "未声明";
    if (number >= 1_000_000) {
      return `${(number / 1_000_000).toFixed(2).replace(/\.00$/, "")}M`;
    }
    if (number >= 1_000) return `${Math.round(number / 1_000)}K`;
    return String(Math.round(number));
  }

  function contextTokensToK(value) {
    const tokens = Number(value);
    if (!Number.isFinite(tokens) || tokens <= 0) return "";
    return String(Number((tokens / 1_000).toFixed(3)));
  }

  function contextKToTokens(value) {
    const kiloTokens = Number(value);
    if (!Number.isFinite(kiloTokens) || kiloTokens <= 0) return 0;
    return Math.round(kiloTokens * 1_000);
  }

  function formatTokenCount(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return "0.00M";
    return `${(number / 1_000_000).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 3,
    })}M`;
  }

  function formatGenerationRate(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return "—";
    const digits = number >= 100 ? 0 : number >= 10 ? 1 : 2;
    return `${number.toLocaleString(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })} tok/s`;
  }

  function formatFirstTokenLatency(value) {
    const milliseconds = Number(value);
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "—";
    if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
    const seconds = milliseconds / 1_000;
    const digits = seconds >= 100 ? 0 : 1;
    return `${seconds.toLocaleString(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })}s`;
  }

  function formatMetricDuration(value) {
    const milliseconds = Number(value);
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
    if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
    const seconds = milliseconds / 1_000;
    const digits = seconds >= 100 ? 0 : 1;
    return `${seconds.toLocaleString(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })}s`;
  }

  function formatCny(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return "¥0.000000";
    const digits = number >= 1 ? 2 : number >= 0.01 ? 4 : 6;
    return `¥${number.toLocaleString(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })}`;
  }

  function formatTooltipPercent(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    return `${number.toLocaleString(undefined, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    })}%`;
  }

  function formatExchangeRate(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number.toFixed(4) : "未知";
  }

  function number(value) {
    return Math.min(100, Math.max(0, Math.round(Number(value) || 0)));
  }

  function escapeHtml(value) {
    return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }

  return { formatContextTier, formatUnitPrice, isLightTheme, formatReset, formatExpiry, formatUpdatedAt, formatPlan, levelClass, formatContextValue, contextTokensToK, contextKToTokens, formatTokenCount, formatGenerationRate, formatFirstTokenLatency, formatMetricDuration, formatCny, formatTooltipPercent, formatExchangeRate, number, escapeHtml };
}

export { createFormatting };
