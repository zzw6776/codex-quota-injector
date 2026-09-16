function selectConversationNetworkLatency(usage, liveNetwork) {
  const saved = usage?.networkLatency && typeof usage.networkLatency === "object"
    ? usage.networkLatency
    : null;
  if (usage?.completed || !usage?.networkLatencySupported) return saved;
  const live = liveNetwork && typeof liveNetwork === "object" ? liveNetwork : null;
  if (!live) return saved;
  const turnConnectionId = String(usage?.networkConnectionId ?? saved?.connectionId ?? "");
  const liveConnectionId = String(live.connectionId ?? "");
  return turnConnectionId && turnConnectionId === liveConnectionId ? live : saved;
}

function formatNetworkLatencyText(network) {
  const latency = network?.latencyMs == null ? Number.NaN : Number(network.latencyMs);
  const value = Number.isFinite(latency) && latency >= 0
    ? `${Math.round(latency)}ms`
    : "—";
  if (network?.status === "fluctuating") return `延时 ${value}（网络波动）`;
  if (["reconnecting", "reconnected"].includes(network?.status)) {
    return `延时 ${value}（连接重建）`;
  }
  return `延时 ${value}`;
}

function formatConversationUsageSummary(usage, network, subagentLabel = "") {
  const formatTokenCount = (value) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return "0.00M";
    return `${(number / 1_000_000).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 3,
    })}M`;
  };
  const formatDuration = (value) => {
    const milliseconds = Number(value);
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return null;
    if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
    const seconds = milliseconds / 1_000;
    const digits = seconds >= 100 ? 0 : 1;
    return `${seconds.toLocaleString(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })}s`;
  };
  const formatRate = (value) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return null;
    const digits = number >= 100 ? 0 : number >= 10 ? 1 : 2;
    return `${number.toLocaleString(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })} tok/s`;
  };
  const formatCny = (value) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return "¥0.000000";
    const digits = number >= 1 ? 2 : number >= 0.01 ? 4 : 6;
    return `¥${number.toLocaleString(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })}`;
  };
  const inputTokens = Number(usage?.inputTokens);
  const cachedInputTokens = Number(usage?.cachedInputTokens);
  const cacheHitRate = Number.isFinite(inputTokens) && inputTokens > 0 &&
    Number.isFinite(cachedInputTokens)
    ? `${(cachedInputTokens / inputTokens * 100).toLocaleString(undefined, {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      })}%`
    : "—";
  const firstToken = formatDuration(usage?.firstTokenLatencyMs);
  const speed = formatRate(usage?.outputSpeed);
  const cost = usage?.cost ?? {};
  const latency = network?.latencyMs == null ? Number.NaN : Number(network.latencyMs);
  const latencyValue = Number.isFinite(latency) && latency >= 0
    ? `${Math.round(latency)}ms`
    : "—";
  const networkLatencyText = network?.status === "fluctuating"
    ? `延时 ${latencyValue}（网络波动）`
    : ["reconnecting", "reconnected"].includes(network?.status)
      ? `延时 ${latencyValue}（连接重建）`
      : `延时 ${latencyValue}`;
  return [
    ...(subagentLabel ? [subagentLabel] : []),
    `本轮 Token ${formatTokenCount(usage?.totalTokens)}`,
    `缓存命中率 ${cacheHitRate}`,
    `累计 ${formatTokenCount(usage?.cumulativeTotalTokens)}`,
    ...(firstToken ? [`首字 ${firstToken}`] : []),
    ...(speed ? [`速率 ${speed}`] : []),
    networkLatencyText,
    cost.available ? `价格 ${formatCny(cost.totalCny)}` : "价格暂不可算",
  ].join(" · ");
}

export { formatNetworkLatencyText, selectConversationNetworkLatency, formatConversationUsageSummary };
