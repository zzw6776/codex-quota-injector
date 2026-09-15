export const WIDGET_RUNTIME_VERSION = 156;

export function paginateGenerationDetails(details, visibleCount = 20) {
  const ordered = Array.isArray(details)
    ? [...details].sort((left, right) => Number(right?.sequence) - Number(left?.sequence))
    : [];
  const count = Math.max(0, Math.floor(Number(visibleCount) || 0));
  return {
    total: ordered.length,
    items: ordered.slice(0, count),
    remaining: Math.max(0, ordered.length - count),
  };
}

export function formatGenerationDetailTitle(detail, isLatestCompleted = false) {
  // Prefer the actual inner executions; do not prepend the exec wrapper.
  const calls = Array.isArray(detail?.toolExecutions?.calls) && detail.toolExecutions.calls.length
    ? detail.toolExecutions.calls
    : Array.isArray(detail?.toolTiming?.calls) && detail.toolTiming.calls.length
      ? detail.toolTiming.calls : null;
  const toolNames = calls
    ? calls.map((call) => String(call?.toolName ?? "").trim() || "工具调用")
    : [...new Set([
        ...(Array.isArray(detail?.toolNames) ? detail.toolNames : []),
        ...(Array.isArray(detail?.toolTiming?.toolNames) ? detail.toolTiming.toolNames : []),
      ].map((name) => String(name ?? "").trim()).filter(Boolean))];
  if (toolNames.length > 0) {
    const counts = new Map();
    for (const name of toolNames) counts.set(name, (counts.get(name) || 0) + 1);
    return [...counts].map(([name, count]) => count > 1 ? `${name} ×${count}` : name).join("、");
  }
  if (detail?.toolTiming) return "工具调用";
  if (isLatestCompleted && detail?.hasVisibleText) return "最终回复";
  if (detail?.followsToolResult) return "处理工具结果";
  return detail?.hasVisibleText ? "生成回复" : "模型请求";
}

export function formatGenerationPhaseText(detail) {
  const formatDuration = (value) => {
    if (value == null || value === "") return "—";
    const milliseconds = Number(value);
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
    if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
    const seconds = milliseconds / 1_000;
    const digits = seconds >= 100 ? 0 : 1;
    return `${seconds.toLocaleString(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })}s`;
  };
  const numberOrNull = (value) => {
    if (value == null || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  };
  const stages = [];
  const formatPhaseSpeed = (value) => {
    const speed = Number(value);
    if (!Number.isFinite(speed) || speed <= 0) return "";
    return `（${speed.toLocaleString(undefined, { maximumFractionDigits: speed >= 100 ? 0 : speed >= 10 ? 1 : 2 })} tok/s）`;
  };
  const outputPhases = Array.isArray(detail?.outputPhases) ? detail.outputPhases : [];
  const responseLatencyMs = numberOrNull(detail?.responseLatencyMs);
  let cursor = responseLatencyMs;
  let hasText = false;
  if (responseLatencyMs != null) stages.push(`响应 ${formatDuration(responseLatencyMs)}`);

  let textPhases = Array.isArray(detail?.textPhases)
    ? detail.textPhases.map((phase, index) => ({
        kind: "text",
        phase: phase?.phase,
        startLatencyMs: numberOrNull(phase?.startLatencyMs),
        durationMs: numberOrNull(phase?.durationMs),
        outputSpeed: outputPhases.find((value) => value.kind === "text" && value.textPhaseIndex === index)?.outputSpeed,
      })).filter((phase) => phase.startLatencyMs != null)
    : [];
  if (textPhases.length === 0 && detail?.hasVisibleText &&
    numberOrNull(detail?.firstTokenLatencyMs) != null) {
    textPhases = [{
      phase: "unknown",
      startLatencyMs: numberOrNull(detail.firstTokenLatencyMs),
      durationMs: numberOrNull(detail.generationDurationMs),
    }];
  }
  const measuredToolPhases = outputPhases.filter((phase) =>
    phase.kind === "tool" && numberOrNull(phase.startLatencyMs) != null &&
    numberOrNull(phase.durationMs) != null);
  const phases = [...textPhases, ...measuredToolPhases]
    .sort((left, right) => left.startLatencyMs - right.startLatencyMs);

  const appendGap = (nextStart, fallbackLabel = "继续处理") => {
    if (cursor == null || nextStart == null || nextStart < cursor) return;
    const duration = nextStart - cursor;
    if (duration > 0) stages.push(`${hasText ? fallbackLabel : "模型处理"} ${formatDuration(duration)}`);
  };
  for (const phase of phases) {
    appendGap(phase.startLatencyMs);
    const label = phase.kind === "tool" ? "生成调用" : phase.phase === "commentary"
      ? "中间说明"
      : phase.phase === "final_answer"
        ? "回复生成"
        : detail?.toolTiming ? "中间说明" : "回复生成";
    if (phase.durationMs != null) stages.push(`${label} ${formatDuration(phase.durationMs)}${formatPhaseSpeed(phase.outputSpeed)}`);
    hasText = true;
    cursor = phase.durationMs == null
      ? null
      : Math.max(cursor ?? 0, phase.startLatencyMs + phase.durationMs);
  }

  const toolTiming = detail?.toolTiming;
  if (toolTiming && measuredToolPhases.length === 0) {
    const preparationStart = numberOrNull(toolTiming.preparationStartLatencyMs);
    const readyLatency = numberOrNull(toolTiming.readyLatencyMs);
    let preparationDuration = numberOrNull(toolTiming.preparationDurationMs);
    if (preparationDuration == null && preparationStart != null &&
      readyLatency != null && readyLatency >= preparationStart) {
      preparationDuration = readyLatency - preparationStart;
    }
    if (preparationStart != null) {
      appendGap(preparationStart);
      if (preparationDuration != null) {
        stages.push(`生成调用 ${formatDuration(preparationDuration)}`);
      }
      cursor = preparationDuration == null
        ? null
        : preparationStart + preparationDuration;
    } else if (readyLatency != null) {
      appendGap(readyLatency, "调用前处理");
      cursor = readyLatency;
    }
  }
  const readyLatency = numberOrNull(toolTiming?.readyLatencyMs);
  if (measuredToolPhases.length > 0 && detail?.outputPhasesComplete &&
    cursor != null && readyLatency != null && readyLatency > cursor) {
    // The rate ends at the last input delta; stage accounting also includes
    // the remaining wait for the completed tool-call item.
    stages.push(`调用收尾 ${formatDuration(readyLatency - cursor)}`);
  }
  return stages.join(" · ");
}

export function generationToolRows(detail) {
  if (Array.isArray(detail?.toolExecutions?.calls)) return detail.toolExecutions.calls;
  // Older router records know only the outer call round trip. Preserve that
  // useful timing while labelling its source instead of presenting it as a
  // native child execution duration.
  const calls = Array.isArray(detail?.toolTiming?.calls) && detail.toolTiming.calls.length
    ? detail.toolTiming.calls
    : (Array.isArray(detail?.toolNames) ? detail.toolNames.map((toolName) => ({ toolName })) : []);
  return calls.map((call) => ({ toolName: call.toolName, description: "调用耗时",
    durationMs: call.durationMs ?? null, durationSource: call.toolName === "exec" ? "outer-exec" : "outer-call" }));
}

export function generationExecutionRemainder(detail) {
  const execution = detail?.toolExecutions;
  const calls = execution?.calls;
  const validDuration = (value) => value != null && value !== "" &&
    Number.isFinite(Number(value)) && Number(value) >= 0;
  if (!execution?.complete || !validDuration(execution.durationMs) ||
    !Array.isArray(calls) || calls.length === 0 ||
    calls.some((call) => !validDuration(call.durationMs))) return null;
  // Reported child durations are not additive when tools run concurrently.
  // Missing starts cannot establish overlaps, so do not invent a remainder.
  if (calls.length > 1 && calls.some((call) => !validDuration(call.startedAt))) return null;
  const origin = calls.length > 1 ? Math.min(...calls.map((call) => Number(call.startedAt))) : 0;
  const intervals = calls.map((call) => {
    const start = calls.length > 1 ? Number(call.startedAt) - origin : 0;
    return [start, start + Number(call.durationMs)];
  }).sort((left, right) => left[0] - right[0]);
  let covered = 0;
  let end = 0;
  for (const [start, nextEnd] of intervals) {
    covered += Math.max(0, nextEnd - Math.max(start, end));
    end = Math.max(end, nextEnd);
  }
  const remaining = Number(execution.durationMs) - covered;
  // This is only an accounting remainder, not an attribution to network or
  // dispatch. Conflicting measurements must not become a negative duration.
  return remaining > 0 ? remaining : null;
}

export function createGenerationToolRow(document, call, formatDuration) {
  const detailList = call?.detailList;
  const entries = ["commands", "files"].includes(detailList?.kind) && Array.isArray(detailList.items)
    ? detailList.items.filter((entry) => typeof entry === "string" && entry.trim()) : [];
  const description = entries.length
    ? `${entries.length} ${detailList.kind === "files" ? "个文件" : "条命令"}` : call?.description;
  const row = document.createElement("div");
  row.style.cssText = "display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;min-width:0;color:var(--color-token-text-tertiary,#9a9aa4);font-size:9px";
  const name = document.createElement("span");
  name.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
  name.textContent = [call?.toolName || "工具调用", description].filter(Boolean).join(" · ");
  name.title = name.textContent;
  const duration = document.createElement("span");
  duration.style.cssText = "font-variant-numeric:tabular-nums;white-space:nowrap";
  const durationText = call?.durationMs == null ? "未记录"
    : Number(call.durationMs) > 0 && Number(call.durationMs) < 1 ? "<1ms"
    : formatDuration(call.durationMs);
  duration.textContent = `${call?.approximate && call.durationMs != null ? "约" : ""}${durationText}`;
  duration.title = call?.durationMs == null
    ? "当前记录没有可确认的单项耗时，不拆分外层执行时间"
    : call?.durationSource === "outer-exec"
      ? "由外层 exec 计时：从调用发出到结果回传的往返耗时，包含嵌套工具、调度和结果处理，不等同于子工具自身执行耗时"
      : call?.durationSource === "outer-call"
        ? "由外层工具调用计时：从调用发出到结果回传的往返耗时，包含调度和结果处理，不等同于工具自身上报的执行耗时"
      : call?.approximate
        ? "整体调用耗时扣除子工具上报耗时覆盖区间后的剩余值，不能直接归因为网络或调度耗时"
        : "此工具自身上报的执行耗时；同组工具可能并行，耗时不能直接相加";
  row.append(name, duration);
  if (entries.length === 0) return row;

  const disclosure = document.createElement("details");
  disclosure.style.cssText = "min-width:0";
  const summary = document.createElement("summary");
  summary.style.cssText = "cursor:pointer;user-select:none;list-style-position:outside";
  summary.append(row);
  const list = document.createElement("div");
  // Use the existing request scroll container; no extra scrolling region.
  list.style.cssText = "display:grid;gap:2px;min-width:0;margin:3px 0 2px 13px;color:var(--color-token-text-tertiary,#9a9aa4);font-size:9px";
  for (const entry of entries) {
    const item = document.createElement("div");
    item.style.cssText = "min-width:0;white-space:normal;overflow-wrap:anywhere";
    item.textContent = entry;
    list.append(item);
  }
  disclosure.append(summary, list);
  return disclosure;
}

export function formatGenerationPrimaryText(
  detail,
  networkLatencyText = formatNetworkLatencyText,
) {
  const formatDuration = (value) => {
    const milliseconds = Number(value);
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
    if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
    const seconds = milliseconds / 1_000;
    const digits = seconds >= 100 ? 0 : 1;
    return `${seconds.toLocaleString(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })}s`;
  };
  const parts = [];
  const hasTools = Boolean(detail?.toolTiming || detail?.toolExecutions?.calls?.length || detail?.toolNames?.length);
  if ((!hasTools || detail?.hasVisibleText) && Number(detail?.firstTokenLatencyMs) > 0) {
    parts.push(`首字 ${formatDuration(detail.firstTokenLatencyMs)}`);
  }
  const speed = Number(detail?.outputSpeed);
  if (Number.isFinite(speed) && speed > 0) {
    const digits = speed >= 100 ? 0 : speed >= 10 ? 1 : 2;
    parts.push(`速率 ${speed.toLocaleString(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })} tok/s`);
  }
  parts.push(networkLatencyText(detail?.networkLatency));
  return parts.join(" · ");
}

export function averageGenerationNetworkLatency(details) {
  const values = (Array.isArray(details) ? details : [])
    .map((detail) => detail?.networkLatency?.latencyMs)
    .filter((value) => value != null && Number.isFinite(Number(value)) && Number(value) >= 0)
    .map(Number);
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function selectConversationNetworkLatency(usage, liveNetwork) {
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

export function formatNetworkLatencyText(network) {
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

export function formatConversationUsageSummary(usage, network, subagentLabel = "") {
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

export function calculatePopoverMaxHeight(chipTop) {
  const TITLE_BAR_SAFE_TOP = 44;
  const ANCHOR_GAP = 10;
  const MAX_HEIGHT = 720;
  const top = Number(chipTop);
  if (!Number.isFinite(top)) return 0;
  return Math.max(0, Math.min(MAX_HEIGHT, Math.floor(top - TITLE_BAR_SAFE_TOP - ANCHOR_GAP)));
}

export function calculateScrollbarEndPadding(
  offsetWidth,
  clientWidth,
  borderWidth = 0,
  targetClearance = 16,
) {
  const outer = Number(offsetWidth);
  const inner = Number(clientWidth);
  const borders = Math.max(0, Number(borderWidth) || 0);
  const fallback = Math.max(0, Number(targetClearance) || 0);
  if (!Number.isFinite(outer) || !Number.isFinite(inner)) return fallback;
  const scrollbarWidth = Math.max(0, outer - inner - borders);
  return Math.max(0, fallback - scrollbarWidth);
}

export function installQuotaWidget(
  calculateMaxHeight = (chipTop) => Math.max(0, Math.min(720, Math.floor(Number(chipTop) - 54))),
  runtimeVersion = WIDGET_RUNTIME_VERSION,
  paginateDetails = paginateGenerationDetails,
  detailTitle = formatGenerationDetailTitle,
  phaseText = formatGenerationPhaseText,
  primaryText = formatGenerationPrimaryText,
  usageSummaryText = formatConversationUsageSummary,
  selectNetworkLatency = selectConversationNetworkLatency,
  networkLatencyText = formatNetworkLatencyText,
  averageNetworkLatency = averageGenerationNetworkLatency,
  toolRows = generationToolRows,
  toolRowElement = createGenerationToolRow,
  executionRemainder = generationExecutionRemainder,
  scrollbarEndPadding = calculateScrollbarEndPadding,
) {
  const GLOBAL_KEY = "__codexQuotaWidget";
  const ROOT_ID = "codex-quota-injector-root";
  const GLOBAL_STYLE_ID = "codex-quota-injector-global-style";
  const VERSION = runtimeVersion;
  const MAX_CONVERSATION_USAGE_CACHE = 240;
  const CONVERSATION_TOOLTIP_DELAY_MS = 500;
  const ACCOUNT_TOOLTIP_DELAY_MS = 300;
  const CUSTOM_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
  if (window[GLOBAL_KEY]?.version === VERSION) return VERSION;
  try {
    window[GLOBAL_KEY]?.destroy?.();
  } catch {
    document.getElementById(ROOT_ID)?.remove();
    document.getElementById(GLOBAL_STYLE_ID)?.remove();
    delete window[GLOBAL_KEY];
  }

  const globalStyleText = `
    button[aria-label*="语音聊天"],
    button[aria-label*="語音聊天"],
    button[aria-label*="voice chat" i],
    button[aria-label*="chat de voz" i],
    button[aria-label*="Sprach-Chat" i],
    button[aria-label*="chat vocal" i],
    button[aria-label*="音声チャット"],
    button[aria-label*="开始新的语音"],
    button[aria-label*="開始新的語音"],
    button[aria-label*="Start a new voice" i],
    button[aria-label*="Start voice chat" i],
    div.flex.items-center.gap-1 > span.contents:has(> button) {
      display: none !important;
    }
  `;

  function ensureGlobalStyle() {
    let style = document.getElementById(GLOBAL_STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = GLOBAL_STYLE_ID;
      (document.head ?? document.documentElement).append(style);
    }
    if (style.textContent !== globalStyleText) {
      style.textContent = globalStyleText;
    }
  }

  function currentDeepSeekBalanceView() {
    const extraModels = state.data.extraModels ?? {};
    const managed = extraModels.platforms?.find?.((platform) =>
      platform?.preset === "deepseek" && platform?.apiKey);
    const balance = extraModels.deepSeekBalance ?? {};
    return {
      configured: Boolean(managed),
      balance: balance.balance ?? null,
      updatedAt: balance.updatedAt ?? null,
      error: balance.error ?? null,
      refreshing: Boolean(balance.refreshing),
    };
  }

  function renderPanelBalance() {
    const accounts = Array.isArray(state.data.accounts) ? state.data.accounts : [];
    const currentAccount = accounts.find((account) => account.current) ?? accounts[0] ?? null;
    const credits = currentAccount?.credits ?? state.data.credits ?? null;
    const codexBalance = !credits
      ? ""
      : credits.unlimited
        ? "无限"
        : credits.formattedUsd ||
          (Number.isFinite(credits.creditQuantity) ? `${credits.creditQuantity} 点` : "");
    const deepSeekBalance = (currentDeepSeekBalanceView().balance?.items ?? [])
      .map((item) => `${escapeHtml(item.currency)} ${escapeHtml(item.totalBalance)}`)
      .join(" · ");
    const items = [];
    if (codexBalance) items.push(`Codex 余额 ${escapeHtml(codexBalance)}`);
    if (deepSeekBalance) items.push(`DeepSeek 余额 ${deepSeekBalance}`);
    return items.length
      ? `<span class="panel-balance">${items.join(" · ")}</span>`
      : "";
  }

  function patchPanelBalance(wrap) {
    const current = wrap.querySelector(".panel-balance");
    const next = renderPanelBalance();
    if (current) {
      if (next) current.outerHTML = next;
      else current.remove();
    } else if (next) {
      wrap.querySelector(".panel-version-text")?.insertAdjacentHTML("beforebegin", next);
    }
  }

  const state = {
    data: {
      accounts: [],
      windows: [],
      injectionMode: null,
      currentAccountId: null,
      operation: null,
      context: { status: "unavailable", models: [], overriddenCount: 0 },
      extraModels: { platforms: [] },
      tokenUsage: { status: "ready", turns: [] },
      hostHealth: { required: false, status: "direct" },
    },
    dataJson: "",
    dataRevision: null,
    tokenUsageRevision: null,
    root: null,
    shadow: null,
    observer: null,
    resizeHandler: null,
    documentPointerHandler: null,
    pinned: false,
    dismissed: false,
    actions: [],
    page: "accounts",
    migrationMode: "temporary",
    migrationSelectedIds: new Set(),
    wakeupDrafts: new Map(),
    accountTooltipTimer: null,
    contextEditingSlug: null,
    extraPlatformDraft: null,
    extraModelDiscoveryRevision: 0,
    extraModelOperationDraft: null,
    detailPanelBaseSize: null,
    detailPanelSize: null,
    detailPanelResize: null,
    detailPanelResizeCleanup: null,
    conversationRenderFrame: null,
    conversationTooltip: null,
    conversationTooltipBridge: null,
    conversationTooltipTimer: null,
    conversationTooltipPendingLine: null,
    conversationTooltipPendingPointer: null,
    conversationTooltipTarget: null,
    conversationTooltipPointer: null,
    conversationUsageByTurn: new Map(),
    conversationTurnNodes: new Map(),
    conversationUsageLines: new Map(),
    conversationDomDirty: true,
    conversationObserverRoot: null,
    mountObserver: null,
    mountCheckFrame: null,
  };

  const styleText = `
    :host { display: inline-flex; flex: 0 0 auto; align-items: center; align-self: center; margin-left: auto; height: var(--height-token-row, 29px); }
    * { box-sizing: border-box; }
    button, input, textarea, select { font: inherit; }
    .quota-wrap { position: relative; display: inline-flex; align-items: center; align-self: center; height: var(--height-token-row, 29px); font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .quota-chip {
      appearance: none; border: 0; border-radius: var(--radius-lg, 12.5px); corner-shape: var(--codex-corner-shape, superellipse(1.5)); cursor: pointer;
      height: var(--height-token-row, 29px); min-width: 0; padding: 0; padding-inline: var(--padding-row-cell-x, var(--padding-row-x, 8px));
      display: inline-flex; align-items: center; justify-content: center; align-self: center;
      gap: 4px; background: transparent; color: var(--token-text-secondary, #777780);
      font: 500 12px/1 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-variant-numeric: tabular-nums; white-space: nowrap;
    }
    .quota-chip:hover, .quota-chip:focus-visible {
      color: inherit;
      background-color: var(--color-background-primary-ghost-hover, rgba(26, 28, 31, 0.053));
      outline: none;
    }
    .quota-divider { opacity: .42; font-weight: 400; }
    .quota-chip-item { display: inline-flex; align-items: baseline; }
    .host-health-dot { width: 7px; height: 7px; flex: 0 0 7px; border-radius: 999px; background: #d97706; box-shadow: 0 0 0 2px rgba(217,119,6,.13); }
    .host-health-dot.ready { background: #43a665; box-shadow: 0 0 0 2px rgba(67,166,101,.13); }
    .host-health-dot.degraded { background: #dc4c3f; box-shadow: 0 0 0 2px rgba(220,76,63,.14); }
    .host-health-dot.direct { background: #5b8fc9; box-shadow: 0 0 0 2px rgba(91,143,201,.13); }
    .host-health-dot.unknown { background: #8a8a95; box-shadow: 0 0 0 2px rgba(138,138,149,.13); }
    .is-warning { color: #d97706 !important; }
    .is-critical { color: #dc4c3f !important; }
    .quota-popover {
      position: fixed; inset: auto auto 58px 12px; margin: 0;
      width: min(430px, calc(100vw - 24px)); max-height: 720px; overflow: hidden;
      padding: 0; border-radius: 16px;
      color: var(--token-foreground, #f4f4f7); background: var(--token-main-surface-primary, #191923);
      background-clip: padding-box;
      border: 1px solid var(--token-border, rgba(255,255,255,.09));
      box-shadow: 0 16px 44px rgba(0,0,0,.38);
      opacity: 0; visibility: hidden; transform: translateY(5px) scale(.985);
      transform-origin: right bottom; pointer-events: none;
      transition: opacity 120ms ease, transform 120ms ease, visibility 120ms;
    }
    .panel-scroll {
      width: 100%; max-height: inherit; overflow: auto; overflow-anchor: none;
      padding: 14px; border-radius: inherit;
    }
    .detail-popover { padding: 6px 6px 0 0; }
    .detail-popover .panel-scroll {
      height: 100%; padding: 8px 8px 14px 14px;
    }
    .panel-scroll::-webkit-scrollbar { width: 10px; height: 10px; }
    .panel-scroll::-webkit-scrollbar-track { margin-block: 12px; background: transparent; }
    .panel-scroll::-webkit-scrollbar-thumb {
      border: 3px solid transparent; border-radius: 999px; background: rgba(127,127,137,.62);
      background-clip: content-box;
    }
    .quota-wrap.is-open .quota-popover {
      opacity: 1; visibility: visible; transform: translateY(0) scale(1); pointer-events: auto;
    }
    .quota-wrap.is-dismissed .quota-popover {
      opacity: 0; visibility: hidden; transform: translateY(5px) scale(.985); pointer-events: none;
    }
    .panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 1px 2px 10px; }
    .panel-title { font-size: 14px; font-weight: 700; }
    .panel-title-wrap { display: flex; align-items: baseline; min-width: 0; gap: 7px; }
    .panel-subtitle { margin-top: 3px; color: var(--token-text-secondary, #aaaab5); font-size: 10px; font-weight: 400; }
    .panel-count { margin-left: 6px; color: var(--token-text-secondary, #aaaab5); font-size: 12px; font-weight: 500; }
    .panel-controls { display: inline-flex; align-items: center; gap: 5px; flex: 0 0 auto; }
    .host-health-status {
      appearance: none; display: inline-flex; align-items: center; justify-content: center;
      width: 22px; height: 22px; padding: 0; border: 0; border-radius: 7px; cursor: default;
      color: inherit; background: transparent;
    }
    .host-health-status:hover, .host-health-status:focus-visible { background: rgba(255,255,255,.075); outline: none; }
    .host-health-status .host-health-dot { width: 8px; height: 8px; flex-basis: 8px; box-shadow: none; }
    .icon-btn { appearance: none; width: 26px; height: 26px; border: 0; border-radius: 8px; cursor: pointer; color: inherit; background: transparent; }
    .icon-btn:hover { background: rgba(255,255,255,.07); }
    .provider-icon-btn {
      display: inline-flex; align-items: center; justify-content: center;
      border: 0; color: var(--token-text-secondary, #777780);
      background: transparent;
      font: 650 11px/1 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: -.35px;
    }
    .provider-icon-btn:hover, .provider-icon-btn:focus-visible {
      color: inherit; background: rgba(255,255,255,.07); outline: none;
    }
    .accounts-head, .accounts-head .panel-title-wrap { align-items: center; }
    .accounts-head .icon-btn {
      display: inline-flex; align-items: center; justify-content: center;
      flex: 0 0 26px; width: 26px; height: 26px; padding: 0; line-height: 1;
    }
    .accounts-head .icon-btn svg { display: block; width: 12px; height: 12px; flex: 0 0 auto; }
    .account-list { display: grid; gap: 8px; }
    .account-card { padding: 11px 12px; border: 1px solid rgba(255,255,255,.07); border-radius: 12px; background: rgba(255,255,255,.025); }
    .account-card.current { border-color: rgba(217,184,255,.33); background: rgba(217,184,255,.055); }
    .account-card.transferred { opacity: .76; border-style: dashed; }
    .account-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .account-email { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 650; }
    .badges { display: flex; align-items: center; gap: 5px; flex: 0 0 auto; }
    .badge { padding: 2px 6px; border-radius: 999px; background: rgba(255,255,255,.07); color: var(--token-text-secondary, #aaaab5); font-size: 10px; line-height: 16px; }
    .badge.current { color: #d9b8ff; background: rgba(217,184,255,.12); }
    .badge.transferred { color: #e5b86a; background: rgba(229,184,106,.1); }
    button.badge { appearance: none; border: 0; cursor: pointer; font: inherit; }
    button.badge:hover { background: rgba(229,184,106,.18); }
    .expiry { margin-top: 5px; color: var(--token-text-secondary, #aaaab5); font-size: 10.5px; line-height: 15px; }
    .account-meta { display: flex; align-items: center; justify-content: space-between; gap: 10px; white-space: nowrap; }
    .window-list { display: grid; gap: 7px; margin-top: 9px; }
    .window-row { display: grid; grid-template-columns: 58px 42px minmax(70px, 1fr); align-items: center; gap: 5px 8px; font-size: 11px; }
    .window-label { color: var(--token-text-secondary, #aaaab5); }
    .window-left { text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; }
    .window-track { height: 4px; overflow: hidden; border-radius: 99px; background: rgba(255,255,255,.08); }
    .window-track i { display: block; height: 100%; border-radius: inherit; background: #d9b8ff; }
    .window-subline { grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; gap: 10px; color: var(--token-text-secondary, #aaaab5); font-size: 10.5px; line-height: 15px; }
    .window-credit { color: var(--token-text-secondary, #aaaab5); }
    .window-reset { margin-left: auto; text-align: right; white-space: nowrap; color: var(--token-text-secondary, #aaaab5); }
    .btn { appearance: none; border: 1px solid rgba(255,255,255,.11); border-radius: 8px; cursor: pointer; padding: 5px 9px; color: inherit; background: rgba(255,255,255,.045); font-size: 11px; }
    .btn:hover { background: rgba(255,255,255,.09); }
    .btn.primary { border-color: rgba(217,184,255,.24); color: #e5cdfd; background: rgba(217,184,255,.1); }
    .btn:disabled { cursor: default; opacity: .45; }
    .account-switch { padding: 2px 7px; border-radius: 999px; line-height: 16px; white-space: nowrap; }
    .account-remove { padding: 2px 7px; border-radius: 999px; line-height: 16px; white-space: nowrap; color: #ef8e86; border-color: rgba(220,76,63,.2); background: rgba(220,76,63,.06); }
    .account-remove:hover { background: rgba(220,76,63,.12); }
    .account-head .badges > .badge, .account-head .badges > .btn {
      display: inline-flex; align-items: center; justify-content: center;
      height: 22px; padding-top: 0; padding-bottom: 0;
      font-size: 10.5px; font-weight: 500; line-height: 16px;
    }
    .account-tooltip { position: fixed; inset: auto; margin: 0; width: max-content; max-width: min(320px, calc(100vw - 24px)); padding: 7px 10px; border: 1px solid rgba(255,255,255,.1); border-radius: 8px; color: #f4f4f7; background: #24242d; box-shadow: 0 6px 20px rgba(0,0,0,.25); font-size: 11px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; pointer-events: none; }
    .empty { padding: 18px 8px; text-align: center; color: var(--token-text-secondary, #aaaab5); font-size: 12px; }
    .operation { margin-top: 9px; padding: 8px 10px; border-radius: 9px; overflow-wrap: anywhere; background: rgba(255,255,255,.045); color: var(--token-text-secondary, #b5b5bf); font-size: 11px; }
    .operation.has-action { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .operation.has-action span { min-width: 0; }
    .operation .oauth-cancel { flex: 0 0 auto; padding: 3px 7px; }
    .operation.success { color: #7ecb9b; background: rgba(52,168,92,.09); }
    .operation.error { color: #ef8e86; background: rgba(220,76,63,.09); }
    .host-health-banner { display: grid; gap: 7px; margin-bottom: 11px; padding: 10px 11px; border: 1px solid rgba(229,184,106,.28); border-radius: 11px; color: #f2cf8e; background: rgba(229,184,106,.09); font-size: 10.5px; line-height: 15px; }
    .host-health-banner.degraded { border-color: rgba(220,76,63,.3); color: #f3a49e; background: rgba(220,76,63,.09); }
    .host-health-title { font-size: 11.5px; font-weight: 700; }
    .host-health-detail { color: var(--token-text-secondary, #b5b5bf); overflow-wrap: anywhere; }
    .host-health-missing { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
    .host-health-actions { display: flex; flex-wrap: wrap; gap: 6px; }
    .host-health-actions .btn { padding: 4px 8px; }
    .panel-version { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-top: 12px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,.07); color: var(--token-text-secondary, #aaaab5); font-size: 10px; font-weight: 400; }
    .panel-version-text { margin-left: auto; color: var(--token-text-secondary, #aaaab5); white-space: nowrap; }
    .panel-balance { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .add-panel { margin-top: 11px; padding-top: 11px; border-top: 1px solid rgba(255,255,255,.07); }
    .add-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .toolbar-actions { display: flex; align-items: center; gap: 7px; }
    .add-title { font-size: 12px; font-weight: 650; }
    .add-options { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-top: 9px; }
    .migration-form { display: grid; gap: 10px; padding: 0; }
    .migration-options { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .migration-option { display: grid; grid-template-columns: auto 1fr; align-items: start; gap: 8px; padding: 10px; border: 1px solid rgba(255,255,255,.08); border-radius: 11px; cursor: pointer; background: rgba(255,255,255,.025); }
    .migration-option.selected { border-color: rgba(217,184,255,.3); background: rgba(217,184,255,.055); }
    .migration-option input { width: auto; margin: 2px 0 0; }
    .migration-option-title { display: block; font-size: 12px; font-weight: 650; }
    .migration-option-note { display: block; margin-top: 4px; color: var(--token-text-secondary, #aaaab5); font-size: 10px; line-height: 15px; }
    .migration-account-list { display: grid; gap: 6px; }
    .migration-account-row { display: grid; grid-template-columns: auto minmax(0,1fr) auto; align-items: center; gap: 8px; padding: 8px 9px; border: 1px solid rgba(255,255,255,.07); border-radius: 9px; }
    .migration-account-row input { width: auto; margin: 0; }
    .migration-account-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
    .migration-account-state { color: var(--token-text-secondary, #aaaab5); font-size: 10px; white-space: nowrap; }
    .migration-current-note { padding: 8px 9px; border-radius: 9px; color: #e5b86a; background: rgba(229,184,106,.08); font-size: 10px; line-height: 15px; }
    .migration-actions { display: flex; justify-content: flex-end; }
    details { grid-column: 1 / -1; border: 1px solid rgba(255,255,255,.07); border-radius: 9px; }
    summary { cursor: pointer; padding: 7px 9px; color: var(--token-text-secondary, #aaaab5); font-size: 11px; }
    form { display: grid; gap: 7px; padding: 0 9px 9px; }
    input, textarea, select { width: 100%; border: 1px solid rgba(255,255,255,.1); border-radius: 7px; outline: none; padding: 7px 8px; color: inherit; background: rgba(0,0,0,.16); font-size: 11px; }
    textarea { min-height: 70px; resize: vertical; }
    input:focus, textarea:focus, select:focus { border-color: rgba(217,184,255,.4); }
    .quota-error { margin-top: 7px; color: #ef8e86; font-size: 10px; }
    .context-summary { display: grid; gap: 6px; margin-bottom: 10px; padding: 10px 11px; border: 1px solid rgba(255,255,255,.07); border-radius: 11px; background: rgba(255,255,255,.025); }
    .context-status { font-size: 12px; font-weight: 650; }
    .context-status.system-default { color: #7ecb9b; }
    .context-status.applied { color: #d9b8ff; }
    .context-status.pending { color: #e5b86a; }
    .context-status.external { color: #e5b86a; }
    .context-status.unavailable { color: #ef8e86; }
    .context-note { color: var(--token-text-secondary, #aaaab5); font-size: 10px; line-height: 15px; }
    .context-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; color: var(--token-text-secondary, #aaaab5); font-size: 11px; }
    .context-toolbar-actions { display: flex; align-items: center; gap: 6px; }
    .model-list { display: grid; gap: 7px; }
    .model-card { padding: 10px 11px; border: 1px solid rgba(255,255,255,.07); border-radius: 11px; background: rgba(255,255,255,.025); }
    .model-card.overridden { border-color: rgba(217,184,255,.3); background: rgba(217,184,255,.055); }
    .model-head { display: flex; align-items: center; justify-content: space-between; gap: 9px; }
    .model-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 650; }
    .model-slug { margin-top: 2px; color: var(--token-text-secondary, #aaaab5); font: 10px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .model-actions { display: flex; align-items: center; flex: 0 0 auto; gap: 5px; }
    .model-values { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-top: 9px; }
    .model-value { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 6px 8px; border-radius: 7px; background: rgba(0,0,0,.12); font-size: 10px; }
    .model-value span { color: var(--token-text-secondary, #aaaab5); }
    .model-value strong { font-variant-numeric: tabular-nums; }
    .model-max { margin-top: 5px; color: var(--token-text-secondary, #aaaab5); font-size: 10px; }
    .context-edit-form { display: grid; gap: 8px; margin-top: 9px; padding-top: 9px; border-top: 1px solid rgba(255,255,255,.07); }
    .context-edit-form[hidden] { display: none !important; }
    .context-field { display: grid; gap: 4px; }
    .context-field label { color: var(--token-text-secondary, #aaaab5); font-size: 10px; }
    .context-field input { font-variant-numeric: tabular-nums; }
    .context-advanced { border: 1px solid rgba(255,255,255,.07); border-radius: 8px; }
    .context-advanced summary { padding: 6px 8px; }
    .context-advanced .context-field { padding: 0 8px 8px; }
    .context-edit-actions { display: flex; justify-content: flex-end; gap: 6px; }
    .context-empty { padding: 22px 10px; text-align: center; color: var(--token-text-secondary, #aaaab5); font-size: 11px; }
    .provider-summary { display: grid; gap: 6px; margin-bottom: 10px; padding: 10px 11px; border: 1px solid rgba(255,255,255,.07); border-radius: 11px; background: rgba(255,255,255,.025); }
    .provider-status { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; font-weight: 650; }
    .provider-status .enabled { color: #7ecb9b; }
    .provider-status .disabled { color: var(--token-text-secondary, #aaaab5); }
    .provider-note { color: var(--token-text-secondary, #aaaab5); font-size: 10px; line-height: 15px; }
    .provider-form { display: grid; gap: 9px; padding: 11px; border: 1px solid rgba(255,255,255,.07); border-radius: 11px; background: rgba(255,255,255,.025); }
    .provider-field { display: grid; gap: 5px; }
    .provider-field label { color: var(--token-text-secondary, #aaaab5); font-size: 10px; }
    .provider-key { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .provider-toggle { display: flex; align-items: center; gap: 7px; font-size: 11px; }
    .provider-toggle input { width: auto; margin: 0; }
    .provider-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
    .provider-warning { color: #e5b86a; font-size: 10px; line-height: 15px; }
    .wakeup-times { display: grid; gap: 7px; }
    .wakeup-time-row { display: flex; align-items: center; gap: 8px; }
    .wakeup-time-row label { flex: 0 0 auto; font-size: 11px; }
    .wakeup-time-row input { min-width: 0; }
    .wakeup-time-row button { flex: 0 0 auto; }
    .wakeup-result { line-height: 1.6; }
    .btn.wakeup-status:not(.primary) { color: var(--token-text-secondary, #aaaab5); }
    .wakeup-status:focus-visible { outline: 1px solid currentColor; outline-offset: 3px; border-radius: 2px; }
    .wakeup-form { margin-top: 9px; padding: 0; }
    .extra-platform-list { display: grid; gap: 8px; }
    .extra-platform-card { padding: 10px 11px; border: 1px solid rgba(255,255,255,.07); border-radius: 11px; background: rgba(255,255,255,.025); }
    .extra-platform-card .btn { padding: 2px 7px; border-radius: 7px; font-size: 10px; line-height: 16px; }
    .extra-platform-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 8px; }
    .extra-platform-head .badges { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 5px; }
    .extra-platform-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 650; }
    .extra-platform-url { margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--token-text-secondary, #aaaab5); font: 10px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .extra-platform-meta { margin-top: 6px; color: var(--token-text-secondary, #aaaab5); font-size: 10px; }
    .extra-platform-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 9px; color: var(--token-text-secondary, #aaaab5); font-size: 10px; }
    .extra-platform-form { display: grid; gap: 9px; padding: 11px; border: 1px solid rgba(255,255,255,.07); border-radius: 11px; background: rgba(255,255,255,.025); }
    .extra-models-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 3px; font-size: 11px; font-weight: 650; }
    .extra-model-list { display: grid; gap: 7px; }
    .extra-model-row { display: grid; grid-template-columns: minmax(0,1fr); align-items: end; gap: 7px; padding: 8px; border: 1px solid rgba(255,255,255,.07); border-radius: 9px; }
    .extra-model-row .provider-field { min-width: 0; }
    .extra-model-row .provider-toggle { align-self: center; white-space: nowrap; }
    .extra-model-remove { justify-self: end; }
    .extra-model-capabilities { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 5px; color: var(--token-text-secondary, #aaaab5); font-size: 10px; }
    .extra-model-capabilities .model-label { margin-right: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 650; }
    .extra-model-capabilities .badge.pending { color: #e5b86a; }
    .extra-platform-model-status { display: grid; gap: 5px; margin-top: 7px; }
    .extra-platform-progress:empty, .extra-model-feedback:empty { display: none; }
    .extra-platform-progress .operation, .extra-model-feedback .operation { margin-top: 7px; white-space: normal; overflow-wrap: anywhere; }
    .extra-model-progress { display: flex; align-items: flex-start; gap: 7px; }
    .extra-model-progress::before { content: ""; width: 10px; height: 10px; flex: 0 0 auto; border: 1.5px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: extra-model-spin .8s linear infinite; }
    .extra-model-progress-body { display: grid; flex: 1 1 auto; min-width: 0; gap: 5px; }
    .extra-model-progress-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
    .extra-model-progress-title { min-width: 0; overflow-wrap: anywhere; }
    .extra-model-progress-percent { flex: 0 0 auto; font-variant-numeric: tabular-nums; }
    .extra-model-progress-track { height: 4px; overflow: hidden; border-radius: 999px; background: rgba(255,255,255,.09); }
    .extra-model-progress-track i { display: block; height: 100%; border-radius: inherit; background: currentColor; transition: width .18s ease; }
    .extra-model-progress-detail { color: var(--token-text-secondary, #aaaab5); font-size: 10px; }
    @keyframes extra-model-spin { to { transform: rotate(360deg); } }
    .extra-model-reasoning { grid-column: 1 / -1; display: grid; grid-template-columns: minmax(0, 1fr); align-items: end; gap: 8px; padding-top: 7px; border-top: 1px solid rgba(255,255,255,.07); }
    .extra-model-efforts { display: flex; flex-wrap: wrap; gap: 6px 10px; }
    .extra-model-efforts-label { width: 100%; color: var(--token-text-secondary, #aaaab5); font-size: 10px; }
    .extra-model-efforts .provider-toggle { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; }
    .preset-model-picker { border: 1px solid rgba(255,255,255,.07); border-radius: 9px; overflow: hidden; }
    .preset-model-picker summary { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 9px; cursor: pointer; color: inherit; }
    .preset-model-picker summary::marker { color: var(--token-text-secondary, #aaaab5); }
    .preset-model-options { display: grid; gap: 0; padding: 0 9px 7px; }
    .preset-model-option { display: grid; gap: 7px; padding: 7px 0; border-top: 1px solid rgba(255,255,255,.07); }
    .preset-model-option-select { display: grid; grid-template-columns: auto minmax(0,1fr); align-items: start; gap: 7px; }
    .preset-model-option-select > input { width: auto; margin: 2px 0 0; }
    .preset-model-option-main { min-width: 0; }
    .preset-model-option-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; font-weight: 650; }
    .preset-model-option-id { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--token-text-secondary, #aaaab5); font: 9px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .preset-model-context { display: grid; grid-template-columns: auto minmax(0,1fr) auto; align-items: center; gap: 6px; color: var(--token-text-secondary, #aaaab5); font-size: 10px; }
    .preset-model-context input { min-width: 0; margin: 0; }
    .preset-platform-note { display: grid; gap: 3px; padding: 8px 9px; border-radius: 8px; background: rgba(255,255,255,.035); color: var(--token-text-secondary, #aaaab5); font-size: 10px; line-height: 15px; }
    .balance-section { margin-top: 10px; }
    .balance-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 7px; font-size: 11px; }
    .balance-grid { display: grid; gap: 7px; }
    .balance-card { display: flex; align-items: baseline; gap: 8px; min-width: 0; padding: 9px 10px; border: 1px solid rgba(255,255,255,.07); border-radius: 10px; background: rgba(255,255,255,.025); font-size: 10px; white-space: nowrap; }
    .balance-currency { flex: 0 0 auto; color: var(--token-text-secondary, #aaaab5); font-size: inherit; }
    .balance-total { flex: 0 0 auto; font-size: inherit; font-weight: inherit; font-variant-numeric: tabular-nums; }
    .balance-detail { min-width: 0; margin-left: auto; overflow: hidden; color: var(--token-text-secondary, #aaaab5); font-size: inherit; text-overflow: ellipsis; }
    .quota-wrap.is-light .quota-popover { color: #202124; background: #fff; border-color: rgba(0,0,0,.12); box-shadow: 0 16px 44px rgba(0,0,0,.18); }
    .quota-wrap.is-light .account-card { border-color: rgba(0,0,0,.09); background: rgba(0,0,0,.018); }
    .quota-wrap.is-light .account-card.current { border-color: rgba(116,69,143,.35); background: rgba(116,69,143,.055); }
    .quota-wrap.is-light .badge { color: #676771; background: rgba(0,0,0,.055); }
    .quota-wrap.is-light .badge.current { color: #754694; background: rgba(116,69,143,.1); }
    .quota-wrap.is-light .badge.transferred { color: #9a6500; background: rgba(154,101,0,.09); }
    .quota-wrap.is-light .expiry, .quota-wrap.is-light .window-label, .quota-wrap.is-light .window-reset,
    .quota-wrap.is-light .window-credit, .quota-wrap.is-light .window-subline,
    .quota-wrap.is-light summary, .quota-wrap.is-light .empty { color: #6f6f79; }
    .quota-wrap.is-light .window-track { background: rgba(0,0,0,.08); }
    .quota-wrap.is-light .window-track i { background: #9b68bb; }
    .quota-wrap.is-light .btn { color: #2f3035; border-color: rgba(0,0,0,.12); background: rgba(0,0,0,.025); }
    .quota-wrap.is-light .btn:hover { background: rgba(0,0,0,.065); }
    .quota-wrap.is-light .btn.primary { color: #71438e; border-color: rgba(116,69,143,.28); background: rgba(116,69,143,.08); }
    .quota-wrap.is-light .host-health-banner { color: #8a5b00; border-color: rgba(154,101,0,.25); background: rgba(154,101,0,.07); }
    .quota-wrap.is-light .host-health-banner.degraded { color: #a7352e; border-color: rgba(181,61,53,.24); background: rgba(181,61,53,.06); }
    .quota-wrap.is-light .host-health-detail { color: #6f6f79; }
    .quota-wrap.is-light .host-health-status:hover, .quota-wrap.is-light .host-health-status:focus-visible { background: rgba(0,0,0,.065); }
    .quota-wrap.is-light .account-remove { color: #b53d35; border-color: rgba(181,61,53,.2); background: rgba(181,61,53,.045); }
    .quota-wrap.is-light .account-remove:hover { background: rgba(181,61,53,.09); }
    .quota-wrap.is-light .account-tooltip { color: #202124; background: #fff; border-color: rgba(0,0,0,.12); box-shadow: 0 6px 20px rgba(0,0,0,.12); }
    .quota-wrap.is-light .icon-btn:hover { background: rgba(0,0,0,.06); }
    .quota-wrap.is-light .provider-icon-btn {
      color: #70717c; background: transparent;
    }
    .quota-wrap.is-light .provider-icon-btn:hover, .quota-wrap.is-light .provider-icon-btn:focus-visible {
      color: #363740; background: rgba(0,0,0,.06);
    }
    .quota-wrap.is-light .wakeup-status:not(.primary) { color: #6f6f79; }
    .quota-wrap.is-light .add-panel, .quota-wrap.is-light .panel-version, .quota-wrap.is-light details { border-color: rgba(0,0,0,.09); }
    .quota-wrap.is-light input, .quota-wrap.is-light textarea, .quota-wrap.is-light select { color: #202124; border-color: rgba(0,0,0,.13); background: rgba(0,0,0,.025); }
    .quota-wrap.is-light .operation { color: #666670; background: rgba(0,0,0,.04); }
    .quota-wrap.is-light .extra-model-progress-track { background: rgba(0,0,0,.09); }
    .quota-wrap.is-light .context-summary, .quota-wrap.is-light .model-card,
    .quota-wrap.is-light .provider-summary, .quota-wrap.is-light .provider-form,
    .quota-wrap.is-light .balance-card, .quota-wrap.is-light .extra-platform-card,
    .quota-wrap.is-light .extra-platform-form, .quota-wrap.is-light .migration-option,
    .quota-wrap.is-light .migration-account-row { border-color: rgba(0,0,0,.09); background: rgba(0,0,0,.018); }
    .quota-wrap.is-light .migration-option.selected { border-color: rgba(116,69,143,.35); background: rgba(116,69,143,.055); }
    .quota-wrap.is-light .extra-model-row, .quota-wrap.is-light .extra-model-reasoning { border-color: rgba(0,0,0,.09); }
    .quota-wrap.is-light .model-card.overridden { border-color: rgba(116,69,143,.35); background: rgba(116,69,143,.055); }
    .quota-wrap.is-light .model-value { background: rgba(0,0,0,.04); }
    .quota-wrap.is-light .context-edit-form, .quota-wrap.is-light .context-advanced { border-color: rgba(0,0,0,.09); }
  `;

  function findProfileButton() {
    const buttons = document.querySelectorAll("button[aria-label]");
    for (const button of buttons) {
      const label = button.getAttribute("aria-label") ?? "";
      if (
        /open profile menu/i.test(label) || /打开.*个人.*菜单/.test(label) ||
        /開啟.*個人.*選單/.test(label) || /open settings/i.test(label) ||
        /打开设置/.test(label) || /開啟設定/.test(label)
      ) return button;
    }
    return null;
  }

  function ensureMounted() {
    ensureGlobalStyle();
    const profileButton = findProfileButton();
    const profileRow = profileButton?.parentElement;
    if (!profileRow) {
      detachRoot();
      return false;
    }
    if (state.root?.isConnected && state.root.parentElement === profileRow) {
      const wrap = state.shadow?.querySelector(".quota-wrap");
      wrap?.classList.toggle("is-light", isLightTheme());
      if (wrap) positionPopover(wrap);
      return true;
    }
    detachRoot();
    document.getElementById(ROOT_ID)?.remove();
    const root = document.createElement("span");
    root.id = ROOT_ID;
    root.style.marginLeft = "auto";
    root.setAttribute("data-codex-quota-injector", `v${VERSION}`);
    const shadow = root.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = styleText;
    const wrap = document.createElement("span");
    wrap.className = "quota-wrap";
    shadow.append(style, wrap);
    profileButton.after(root);
    state.root = root;
    state.shadow = shadow;
    render();
    return true;
  }

  function detachRoot() {
    if (!state.root) return;
    dismissPanel();
    state.root.remove();
    state.root = null;
    state.shadow = null;
  }

  function render() {
    const wrap = state.shadow?.querySelector(".quota-wrap");
    if (!wrap) return;
    cancelDetailPanelResize();
    hideAccountTooltip();
    const previousScroller = wrap.querySelector(".panel-scroll");
    const previousScrollTop = previousScroller?.scrollTop ?? 0;
    const previousScrollLeft = previousScroller?.scrollLeft ?? 0;
    const wakeupFocus = state.shadow.activeElement?.closest?.(".wakeup-popover")
      ? state.shadow.activeElement.id : null;
    wrap.classList.toggle("is-light", isLightTheme());
    wrap.classList.toggle("is-open", state.pinned);
    wrap.classList.toggle("is-dismissed", state.dismissed);
    const accounts = Array.isArray(state.data.accounts) ? state.data.accounts : [];
    const currentAccount = accounts.find((a) => a.current) ?? accounts[0] ?? null;
    const currentCredits = currentAccount?.credits ?? state.data.credits ?? null;
    const hasPositiveBalance = Boolean(
      currentCredits && (
        currentCredits.unlimited ||
        (Number(currentCredits.usdAmount) > 0) ||
        (Number(currentCredits.creditQuantity) > 0)
      )
    );
    const chipBalanceText = hasPositiveBalance
      ? (currentCredits.unlimited
          ? "无限"
          : (currentCredits.formattedUsd ?? (Number.isFinite(currentCredits.creditQuantity) ? `${currentCredits.creditQuantity} 点` : "")))
      : "";
    const windows = Array.isArray(state.data.windows) ? state.data.windows : [];
    const chipItems = [];
    if (windows.length) {
      chipItems.push(...windows.map((quota) => `<span class="quota-chip-item ${levelClass(quota.remainingPercent)}">${number(quota.remainingPercent)}%</span>`));
    } else {
      chipItems.push('<span class="quota-chip-item">--</span>');
    }
    if (chipBalanceText) {
      chipItems.push(`<span class="quota-chip-item quota-chip-balance">${escapeHtml(chipBalanceText)}</span>`);
    }
    const hostHealth = state.data.hostHealth ?? { required: false, status: "direct" };
    const healthIndicator = hostHealth.status === "degraded"
      ? '<span class="host-health-dot degraded" aria-hidden="true"></span>'
      : hostHealth.status === "starting"
        ? '<span class="host-health-dot" aria-hidden="true"></span>'
        : "";
    const chip = `${healthIndicator}${chipItems.join('<span class="quota-divider">·</span>')}`;
    const hostHealthBanner = renderHostHealthBanner(hostHealth);
    const accountHtml = accounts.length
      ? accounts.map(renderAccount).join("")
      : '<div class="empty">暂无账号，点击下方按钮添加</div>';
    const oauthCancellable =
      state.data.operation?.state === "loading" &&
      state.data.operation?.cancellable === "oauth";
    const operation = state.data.operation
      ? `<div class="operation ${escapeHtml(state.data.operation.state)} ${oauthCancellable ? "has-action" : ""}"><span>${escapeHtml(state.data.operation.message)}</span>${oauthCancellable ? '<button class="btn oauth-cancel" type="button">取消授权</button>' : ""}</div>`
      : "";
    const busy = state.data.operation?.state === "loading";
    const contextPage = state.page === "context";
    const extraModelsPage = state.page === "extra-models";
    const wakeupPage = state.page === "wakeup";
    const migrationPage = state.page === "migration";
    const appVersion = state.data.version ? escapeHtml(String(state.data.version)) : "";
    const injectionRuntime = state.data.injectionMode === "wsl"
      ? { label: "WSL", title: "注入运行时：WSL" }
      : state.data.injectionMode === "windows"
        ? { label: "Windows", title: "注入运行时：Windows" }
        : null;
    const balanceHtml = renderPanelBalance();
    const popoverClass = contextPage
      ? "quota-popover detail-popover context-popover"
      : wakeupPage
        ? "quota-popover detail-popover wakeup-popover"
      : migrationPage
        ? "quota-popover detail-popover migration-popover"
      : extraModelsPage
          ? "quota-popover detail-popover extra-models-popover"
        : "quota-popover";
    const popoverContent = contextPage
      ? renderContextPage(busy)
      : wakeupPage
        ? renderWakeupPage(busy)
      : migrationPage
        ? renderMigrationPage(accounts, busy, operation)
      : extraModelsPage
          ? renderExtraModelsPage()
        : `
        <header class="panel-head accounts-head">
          <div class="panel-title-wrap">
            <div class="panel-title">账号额度<span class="panel-count">${accounts.length} 个账号</span></div>
            <button class="icon-btn provider-icon-btn extra-models-open" type="button" aria-label="模型管理" title="模型管理"><span aria-hidden="true">M+</span></button>
            <button class="icon-btn provider-icon-btn context-open" type="button" aria-label="模型上下文" title="模型上下文"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M10.3 2.2h3.4l.5 2.6 3 1.7 2.5-.9 1.7 2.9-2 1.8v3.4l2 1.8-1.7 2.9-2.5-.9-3 1.7-.5 2.6h-3.4l-.5-2.6-3-1.7-2.5.9-1.7-2.9 2-1.8v-3.4l-2-1.8 1.7-2.9 2.5.9 3-1.7Z"/><circle cx="12" cy="12" r="3"/></svg></button>
            <button class="icon-btn provider-icon-btn wakeup-open" type="button" aria-label="定时任务" title="定时任务"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10"/><path d="M12 6v6h6"/></svg></button>
          </div>
          ${renderPanelControls(hostHealth)}
        </header>
        <div class="account-list">${accountHtml}</div>
        ${operation}
        <section class="add-panel">
          <div class="add-toolbar"><span class="add-title">账号管理</span><span class="toolbar-actions"><button class="btn migration-open" type="button" ${busy || accounts.length === 0 ? "disabled" : ""}>迁移账号</button><button class="btn refresh-all" type="button" ${busy ? "disabled" : ""}>刷新全部</button></span></div>
          <div class="add-options">
            <button class="btn primary oauth-add" type="button" ${busy ? "disabled" : ""}>OpenAI OAuth</button>
            <button class="btn local-import" type="button" ${busy ? "disabled" : ""}>导入本机登录</button>
            <details><summary>Token / JSON</summary><form class="token-form"><textarea name="token" autocomplete="off" placeholder="粘贴迁移 JSON、auth.json、access token 或 refresh token" required ${busy ? "disabled" : ""}></textarea><button class="btn primary" type="submit" ${busy ? "disabled" : ""}>解析并导入</button></form></details>
            <details><summary>API Key</summary><form class="api-key-form"><input name="name" placeholder="账号名称（可选）" ${busy ? "disabled" : ""}><input name="apiKey" type="password" autocomplete="off" placeholder="OpenAI API Key" required ${busy ? "disabled" : ""}><button class="btn primary" type="submit" ${busy ? "disabled" : ""}>添加 API Key</button></form></details>
          </div>
        </section>`;
    const footerMeta = [injectionRuntime?.label, appVersion ? `v${appVersion}` : ""]
      .filter(Boolean)
      .join(" · ");
    const footerTitle = injectionRuntime?.title ? ` title="${injectionRuntime.title}"` : "";
    const versionFooter = footerMeta
      ? `<div class="panel-version">${balanceHtml}<span class="panel-version-text"${footerTitle}>${footerMeta}</span></div>`
      : "";
    wrap.innerHTML = `
      <button class="quota-chip" type="button" aria-label="${hostHealth.status === "degraded" ? "Codex 任务工具异常；查看账号额度与诊断" : "查看账号额度"}">${chip}</button>
      <section class="${popoverClass}" popover="manual" aria-label="${contextPage ? "Codex 模型上下文" : wakeupPage ? "账号定时唤醒" : migrationPage ? "账号迁移" : extraModelsPage ? "模型管理" : "Codex 账号与额度"}"><div class="panel-scroll">${hostHealthBanner}${popoverContent}${versionFooter}</div></section>`;
    const nextPopover = wrap.querySelector(".quota-popover");
    if (nextPopover) {
      nextPopover.showPopover();
      const nextScroller = nextPopover.querySelector(".panel-scroll");
      nextScroller.scrollTop = previousScrollTop;
      nextScroller.scrollLeft = previousScrollLeft;
    }
    positionPopover(wrap);
    bindEvents(wrap);
    if (wakeupFocus) state.shadow.getElementById(wakeupFocus)?.focus({ preventScroll: true });
    scheduleConversationTokenUsageRender();
  }

  function renderHostHealthBanner(health) {
    if (!health?.required || !["starting", "degraded"].includes(health.status)) return "";
    const degraded = health.status === "degraded";
    const title = degraded ? "Codex 任务工具不可用" : "正在确认 Codex 任务工具";
    const detail = health.actionError || health.detail;
    const missing = Array.isArray(health.missingTools) && health.missingTools.length
      ? `<div class="host-health-missing">缺少：${health.missingTools.map(escapeHtml).join("、")}</div>`
      : "";
    const restart = health.canRestart
      ? '<button class="btn host-health-restart" type="button">重启 Codex</button>'
      : "";
    const logs = health.canOpenLogs
      ? '<button class="btn host-health-open-logs" type="button">打开日志</button>'
      : "";
    return `<aside class="host-health-banner ${degraded ? "degraded" : "starting"}" role="${degraded ? "alert" : "status"}" aria-live="polite">
      <div class="host-health-title">${title}</div>
      <div>${escapeHtml(health.message ?? title)}</div>
      ${detail ? `<div class="host-health-detail">${escapeHtml(detail)}</div>` : ""}
      ${missing}
      <div class="host-health-actions"><button class="btn host-health-recheck" type="button">重新加载并检查</button>${restart}${logs}</div>
    </aside>`;
  }

  function renderPanelControls(health = state.data.hostHealth) {
    return `<div class="panel-controls">${renderHostHealthStatus(health)}<button class="icon-btn close-panel" type="button" aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="m5 5 14 14M19 5 5 19"/></svg></button></div>`;
  }

  function renderHostHealthStatus(health) {
    const status = String(health?.status ?? "unknown");
    const view = {
      ready: { className: "ready" },
      starting: { className: "starting" },
      degraded: { className: "degraded" },
      direct: { className: "direct" },
    }[status] ?? { className: "unknown" };
    const requiredTools = Array.isArray(health?.requiredTools) ? health.requiredTools : [];
    const missingTools = Array.isArray(health?.missingTools) ? health.missingTools : [];
    const details = [];
    if (status === "ready") {
      details.push("任务功能正常");
      details.push(`${requiredTools.length} 项常用功能已加载`);
      details.push(...requiredTools.map((name) => `✓ ${hostToolLabel(name)}`));
    } else if (status === "starting") {
      details.push("正在检查任务功能");
      details.push("正在读取可用功能列表…");
    } else if (status === "direct") {
      details.push("官方直连");
      details.push("任务功能由 Codex 直接提供");
    } else {
      details.push(status === "degraded" ? "任务功能异常" : "任务功能状态未知");
      if (missingTools.length) {
        details.push(`缺少 ${missingTools.length} 项功能`);
        details.push(...missingTools.map((name) => `✕ ${hostToolLabel(name)}`));
      } else if (health?.message) {
        details.push(String(health.message));
      }
      details.push("建议：先重新加载并检查，仍异常则重启 Codex");
      if (missingTools.length) details.push(`诊断：${missingTools.join("、")} 未注册`);
      if (health?.detail) details.push(`详情：${health.detail}`);
      if (health?.actionError) details.push(`操作失败：${health.actionError}`);
      details.push(`状态码：${health?.code || status}`);
      if (health?.updatedAt) details.push(`状态更新：${formatUpdatedAt(health.updatedAt)}`);
    }
    const tooltip = escapeHtml(details.join("\n"));
    return `<button class="host-health-status status-${view.className}" type="button" data-account-tooltip="${tooltip}" aria-label="${escapeHtml(details.join("；"))}"><span class="host-health-dot ${view.className}" aria-hidden="true"></span></button>`;
  }

  function hostToolLabel(name) {
    const value = String(name ?? "");
    return {
      list_threads: "查看任务列表",
      read_thread: "读取会话内容",
      list_projects: "查看项目列表",
      get_usage_limits: "查看用量额度",
    }[value] ?? value;
  }

  function scheduleConversationTokenUsageRender() {
    if (state.conversationRenderFrame != null) return;
    state.conversationRenderFrame = window.requestAnimationFrame(() => {
      state.conversationRenderFrame = null;
      renderConversationTokenUsage();
    });
  }

  function placeConversationTokenUsageLine(line, host) {
    if (!line || !host) return;
    let footer = [...host.children].find((child) =>
      child.matches?.("[data-codex-token-usage-footer]"));
    if (!footer) {
      footer = document.createElement("div");
      footer.setAttribute("data-codex-token-usage-footer", "");
      footer.style.cssText = "display:block;width:100%;margin-top:2px";
    }
    if (footer.parentElement !== host || footer !== host.lastElementChild) host.append(footer);
    if (line.parentElement !== footer) footer.append(line);
  }

  function renderConversationTokenUsage() {
    const incomingUsageItems = Array.isArray(state.data.tokenUsage?.turns)
      ? state.data.tokenUsage.turns
      : [];
    const incomingIds = new Set();
    for (const usage of incomingUsageItems) {
      const turnId = String(usage?.turnId ?? "");
      if (turnId) {
        incomingIds.add(turnId);
        state.conversationUsageByTurn.set(turnId, usage);
      }
    }
    if (incomingIds.size > 0) {
      for (const turnId of state.conversationUsageByTurn.keys()) {
        if (!incomingIds.has(turnId)) state.conversationUsageByTurn.delete(turnId);
      }
    } else if (state.data.tokenUsage?.status === "ready") {
      state.conversationUsageByTurn.clear();
    }
    if (state.conversationUsageByTurn.size > MAX_CONVERSATION_USAGE_CACHE) {
      const retained = [...state.conversationUsageByTurn.values()]
        .sort((left, right) => Number(left.updatedAt) - Number(right.updatedAt))
        .slice(-MAX_CONVERSATION_USAGE_CACHE);
      state.conversationUsageByTurn = new Map(
        retained.map((usage) => [String(usage.turnId), usage]),
      );
    }
    const usageGroups = new Map();
    for (const usage of [...state.conversationUsageByTurn.values()]
      .sort((left, right) => Number(left?.updatedAt) - Number(right?.updatedAt))) {
      const hostTurnId = String(usage?.isSubagentSummary ? usage.parentTurnId : usage?.turnId ?? "");
      const group = usageGroups.get(hostTurnId) ?? [];
      group.push(usage);
      usageGroups.set(hostTurnId, group);
    }
    const usageItems = [...usageGroups.values()].flatMap((group) => group.sort((left, right) =>
      Number(Boolean(left?.completed)) - Number(Boolean(right?.completed)) ||
      Number(Boolean(left?.isSubagentSummary)) - Number(Boolean(right?.isSubagentSummary)) ||
      Number(left?.updatedAt) - Number(right?.updatedAt)));
    bindConversationObserver();
    if (state.conversationDomDirty) {
      state.conversationTurnNodes = new Map([...document.querySelectorAll("[data-content-search-turn-key]")]
        .map((node) => [node.getAttribute("data-content-search-turn-key"), node]));
      state.conversationDomDirty = false;
    }
    const turnNodes = state.conversationTurnNodes;
    const visibleTurnIds = new Set();

    for (const usage of usageItems) {
      const turnId = String(usage?.turnId ?? "");
      const hostTurnId = String(usage?.isSubagentSummary ? usage.parentTurnId : turnId);
      const turnNode = turnNodes.get(hostTurnId);
      if (!turnId || !turnNode) continue;
      visibleTurnIds.add(turnId);
      const host = turnNode.firstElementChild ?? turnNode;
      let line = state.conversationUsageLines.get(turnId);
      if (!line?.isConnected) {
        line = [...turnNode.querySelectorAll("[data-codex-token-usage]")]
          .find((candidate) => candidate.getAttribute("data-codex-token-usage") === turnId);
      }
      if (!line) {
        line = document.createElement("div");
        line.setAttribute("data-codex-token-usage", turnId);
        line.setAttribute("role", "status");
        line.setAttribute("tabindex", "0");
        line.style.cssText = [
          "align-self:flex-start",
          "margin-top:6px",
          "max-width:100%",
          "color:var(--color-token-text-tertiary, #777780)",
          "font:500 11px/16px ui-sans-serif,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
          "font-variant-numeric:tabular-nums",
          "white-space:normal",
          "overflow-wrap:anywhere",
          "opacity:.82",
          "user-select:text",
        ].join(";");
        line.addEventListener("pointerenter", (event) => scheduleConversationTokenTooltip(line, event));
        line.addEventListener("pointermove", (event) => moveConversationTokenTooltip(line, event));
        line.addEventListener("pointerleave", (event) => {
          if (!isConversationTooltipArea(event.relatedTarget)) hideConversationTokenTooltip(line);
        });
        line.addEventListener("focus", () => showConversationTokenTooltip(line));
        line.addEventListener("blur", () => hideConversationTokenTooltip(line));
      }
      state.conversationUsageLines.set(turnId, line);
      placeConversationTokenUsageLine(line, host);
      line.__codexTokenUsage = usage;
      line.style.marginLeft = "0";
      const subagentLabel = conversationSubagentLabel(usage);
      const hasUsage = Number(usage.totalTokens) > 0;
      if (!hasUsage) {
        const statusText = usage.completed
          ? "本轮未获取到 Token 数据 · 价格无法计算"
          : "等待 Token 数据 · 价格待计算";
        const summary = subagentLabel ? `${subagentLabel} · ${statusText}` : statusText;
        if (line.textContent !== summary) line.textContent = summary;
        line.removeAttribute("title");
        if (line.getAttribute("aria-label") !== summary) line.setAttribute("aria-label", summary);
        continue;
      }
      const networkLatency = selectNetworkLatency(usage, state.data.network);
      const summary = usageSummaryText(usage, networkLatency, subagentLabel);
      if (line.textContent !== summary) line.textContent = summary;
      line.removeAttribute("title");
      const accessibilitySummary = `${summary}；缓存写入 ${formatTokenCount(usage.cacheWriteInputTokens)}；推理输出 ${formatTokenCount(usage.reasoningOutputTokens)}`;
      if (line.getAttribute("aria-label") !== accessibilitySummary) {
        line.setAttribute("aria-label", accessibilitySummary);
      }
    }

    for (const [turnId, line] of state.conversationUsageLines) {
      if (!visibleTurnIds.has(turnId) || !line.isConnected) {
        hideConversationTokenTooltip(line);
        const footer = line.parentElement?.matches?.("[data-codex-token-usage-footer]")
          ? line.parentElement
          : null;
        line.remove();
        if (footer && footer.childElementCount === 0) footer.remove();
        state.conversationUsageLines.delete(turnId);
      }
    }
  }

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

  function scheduleConversationTokenTooltip(line, event) {
    clearConversationTooltipTimer();
    if (!line?.__codexTokenUsage) return;
    state.conversationTooltipPendingLine = line;
    state.conversationTooltipPendingPointer = conversationTooltipPointer(event, line);
    state.conversationTooltipTimer = window.setTimeout(() => {
      const pendingLine = state.conversationTooltipPendingLine;
      const pendingPointer = state.conversationTooltipPendingPointer;
      clearConversationTooltipTimer();
      if (!pendingLine?.isConnected || !pendingLine.__codexTokenUsage) return;
      showConversationTokenTooltip(
        pendingLine,
        pendingPointer ? { clientX: pendingPointer.x, clientY: pendingPointer.y } : null,
      );
    }, CONVERSATION_TOOLTIP_DELAY_MS);
  }

  function moveConversationTokenTooltip(line, event) {
    if (state.conversationTooltipPendingLine === line) {
      state.conversationTooltipPendingPointer = conversationTooltipPointer(event, line);
      return;
    }
    if (state.conversationTooltipTarget !== line || state.conversationTooltip?.hidden) return;
    state.conversationTooltipPointer = conversationTooltipPointer(event, line);
    positionConversationTokenTooltip(line);
  }

  function conversationTooltipPointer(event, line) {
    if (Number.isFinite(event?.clientX) && Number.isFinite(event?.clientY)) {
      return { x: event.clientX, y: event.clientY };
    }
    const rect = line.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
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

  function appendGenerationDetails(container, usage) {
    const details = Array.isArray(usage?.generationDetails) ? usage.generationDetails : [];
    const averageParts = [];
    if (Number(usage?.firstTokenLatencyMs) > 0) {
      averageParts.push(`平均首字 ${formatFirstTokenLatency(usage.firstTokenLatencyMs)}`);
    }
    if (Number(usage?.outputSpeed) > 0) {
      averageParts.push(`平均速率 ${formatGenerationRate(usage.outputSpeed)}`);
    }
    const averageLatencyMs = averageNetworkLatency(details);
    if (details.length > 0) {
      averageParts.push(`平均延时 ${averageLatencyMs == null
        ? "—"
        : formatMetricDuration(averageLatencyMs)}`);
    }
    const averageText = averageParts.join(" · ");
    if (details.length === 0) {
      const unavailable = document.createElement("div");
      unavailable.style.cssText = "margin-top:2px;padding-top:5px;border-top:1px solid rgba(127,127,127,.14);color:var(--color-token-text-tertiary,#9a9aa4);font-size:10px";
      unavailable.textContent = `请求明细不可用${averageText ? ` · ${averageText}` : ""}`;
      container.append(unavailable);
      return;
    }

    const detailSection = document.createElement("details");
    detailSection.style.cssText = "margin-top:2px;padding-top:5px;border-top:1px solid rgba(127,127,127,.14)";
    const summary = document.createElement("summary");
    summary.textContent = `请求明细 ${details.length} 次${averageText ? ` · ${averageText}` : ""}`;
    summary.style.cssText = "cursor:pointer;color:var(--color-token-text-tertiary,#9a9aa4);font-size:10px;user-select:none";
    const list = document.createElement("div");
    list.setAttribute("data-codex-scrollbar-container", "");
    list.style.cssText = "display:grid;gap:5px;max-height:240px;overflow-x:hidden;overflow-y:auto;scrollbar-gutter:stable;margin-top:5px;box-sizing:border-box";
    let visibleCount = 20;

    const renderDetails = () => {
      const page = paginateDetails(details, visibleCount);
      list.replaceChildren();
      for (const [index, detail] of page.items.entries()) {
        const title = detailTitle(
          detail,
          index === 0 && Boolean(usage?.completed),
        );
        const primaryMetrics = primaryText(detail, networkLatencyText);
        const diagnostics = phaseText(detail);

        const header = document.createElement("div");
        header.style.cssText = "display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr);align-items:baseline;gap:12px;font-size:10px";
        const name = document.createElement("span");
        name.style.cssText = "min-width:0;color:var(--color-token-text-tertiary,#9a9aa4);white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
        name.textContent = title;
        const metrics = document.createElement("span");
        metrics.style.cssText = "text-align:right;font-variant-numeric:tabular-nums";
        metrics.textContent = primaryMetrics;
        header.append(name, metrics);

        const calls = toolRows(detail);
        if (diagnostics || calls.length > 0) {
          const request = document.createElement("details");
          const requestSummary = document.createElement("summary");
          requestSummary.style.cssText = "cursor:pointer;user-select:none;list-style-position:outside";
          requestSummary.append(header);
          const expanded = document.createElement("div");
          expanded.setAttribute("data-codex-scrollbar-container", "");
          expanded.style.cssText = "display:grid;gap:4px;max-height:180px;overflow-x:hidden;overflow-y:auto;scrollbar-gutter:stable;margin:4px 0 1px 13px;padding:4px 0 4px 5px;box-sizing:border-box;border-left:1px solid rgba(127,127,127,.18)";
          if (diagnostics) {
            const phaseRow = document.createElement("div");
            phaseRow.style.cssText = "display:flex;flex-wrap:wrap;gap:2px 10px;min-width:0;color:var(--color-token-text-tertiary,#9a9aa4);font-size:9px;font-variant-numeric:tabular-nums";
            for (const stage of diagnostics.split(" · ")) {
              if (!stage) continue;
              const segment = document.createElement("span");
              segment.style.cssText = "max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
              segment.textContent = stage;
              segment.title = stage;
              phaseRow.append(segment);
            }
            expanded.append(phaseRow);
          }
          for (const call of calls) {
            expanded.append(toolRowElement(document, call, formatMetricDuration));
          }
          const remainingDuration = executionRemainder(detail);
          if (remainingDuration != null) {
            expanded.append(toolRowElement(document, {
              toolName: "其余调用耗时", durationMs: remainingDuration, approximate: true,
            }, formatMetricDuration));
          }
          request.append(requestSummary, expanded);
          request.addEventListener("toggle", () => {
            if (request.open) syncConversationScrollbarPadding(request);
          });
          list.append(request);
        } else {
          list.append(header);
        }
      }
      if (page.remaining > 0) {
        const more = document.createElement("button");
        more.type = "button";
        more.style.cssText = "border:0;padding:2px 0;background:transparent;color:var(--color-token-text-tertiary,#9a9aa4);font:inherit;text-align:left;cursor:pointer";
        more.textContent = `显示更早 ${Math.min(20, page.remaining)} 次`;
        more.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          visibleCount += 20;
          renderDetails();
        });
        list.append(more);
      }
    };

    renderDetails();
    detailSection.append(summary, list);
    detailSection.addEventListener("toggle", () => {
      if (detailSection.open) syncConversationScrollbarPadding(detailSection);
    });
    container.append(detailSection);
  }

  function syncConversationScrollbarPadding(root) {
    for (const container of root.querySelectorAll("[data-codex-scrollbar-container]")) {
      if (container.offsetWidth <= 0) continue;
      const style = getComputedStyle(container);
      const borderWidth = (Number.parseFloat(style.borderLeftWidth) || 0) +
        (Number.parseFloat(style.borderRightWidth) || 0);
      container.style.paddingRight = `${scrollbarEndPadding(
        container.offsetWidth,
        container.clientWidth,
        borderWidth,
      )}px`;
    }
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

  function conversationSubagentLabel(usage) {
    if (!usage?.isSubagent) return "";
    const nickname = String(usage.agentNickname ?? "").trim();
    const path = String(usage.agentPath ?? "").trim();
    const pathName = path.split("/").filter(Boolean).at(-1) ?? "";
    const identity = nickname || pathName;
    const depth = Math.max(1, Number(usage.agentDepth) || 1);
    return `${depth > 1 ? `子智能体 L${depth}` : "子智能体"}${identity ? ` ${identity}` : ""}`;
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

  function ensureConversationTokenTooltip() {
    if (state.conversationTooltip?.isConnected) return state.conversationTooltip;
    const tooltip = document.createElement("div");
    tooltip.id = "codex-token-usage-tooltip";
    tooltip.setAttribute("data-codex-token-usage-tooltip", "");
    tooltip.setAttribute("role", "tooltip");
    tooltip.hidden = true;
    tooltip.style.cssText = [
      "position:fixed",
      "z-index:2147483647",
      "box-sizing:border-box",
      "width:min(420px,calc(100vw - 24px))",
      "min-width:0",
      "max-width:calc(100vw - 24px)",
      "overflow-x:clip",
      "padding:10px 12px",
      "border:1px solid rgba(127,127,127,.25)",
      "border-radius:10px",
      "background:var(--color-token-bg-primary,var(--token-main-surface-primary,#24242d))",
      "color:var(--color-token-text-primary,var(--token-foreground,#f4f4f7))",
      "box-shadow:0 10px 28px rgba(0,0,0,.28)",
      "font:500 11px/16px ui-sans-serif,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
      "pointer-events:auto",
      "user-select:text",
      "-webkit-user-select:text",
      "cursor:text",
    ].join(";");
    tooltip.addEventListener("pointerleave", (event) => {
      if (!isConversationLineTarget(event.relatedTarget) && !isConversationBridgeTarget(event.relatedTarget)) {
        hideConversationTokenTooltip();
      }
    });
    document.body.append(tooltip);
    state.conversationTooltip = tooltip;
    const bridge = document.createElement("div");
    bridge.id = "codex-token-usage-tooltip-bridge";
    bridge.setAttribute("aria-hidden", "true");
    bridge.hidden = true;
    bridge.style.cssText = [
      "position:fixed",
      "z-index:2147483646",
      "pointer-events:auto",
      "background:transparent",
    ].join(";");
    bridge.addEventListener("pointerleave", (event) => {
      if (!isConversationTooltipTarget(event.relatedTarget) && !isConversationLineTarget(event.relatedTarget)) {
        hideConversationTokenTooltip();
      }
    });
    document.body.append(bridge);
    state.conversationTooltipBridge = bridge;
    return tooltip;
  }

  function positionConversationTokenTooltip(line, tooltip = state.conversationTooltip) {
    if (!line?.isConnected || !tooltip?.isConnected || tooltip.hidden) return;
    const lineRect = line.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const pointer = state.conversationTooltipPointer;
    const gap = 10;
    const preferredLeft = pointer
      ? pointer.x - tooltipRect.width / 2
      : lineRect.left <= window.innerWidth / 2
        ? lineRect.left
        : lineRect.right - tooltipRect.width;
    const left = Math.max(
      12,
      Math.min(window.innerWidth - tooltipRect.width - 12, preferredLeft),
    );
    const preferredTop = lineRect.top - tooltipRect.height - gap;
    const above = preferredTop;
    const top = above >= 12
      ? above
      : Math.min(window.innerHeight - tooltipRect.height - 12, lineRect.bottom + gap);
    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.max(12, Math.round(top))}px`;
    positionConversationTooltipBridge(lineRect, tooltipRect, left, top, gap);
  }

  function positionConversationTooltipBridge(lineRect, tooltipRect, tooltipLeft, tooltipTop, gap) {
    const bridge = state.conversationTooltipBridge;
    if (!bridge?.isConnected) return;
    const tooltipRight = tooltipLeft + tooltipRect.width;
    const lineRight = lineRect.right;
    const bridgeLeft = Math.max(lineRect.left, tooltipLeft);
    const bridgeRight = Math.min(lineRight, tooltipRight);
    const overlapLeft = bridgeRight > bridgeLeft ? bridgeLeft : Math.min(lineRect.left, tooltipLeft);
    const overlapRight = bridgeRight > bridgeLeft ? bridgeRight : Math.max(lineRight, tooltipRight);
    const above = tooltipTop < lineRect.top;
    const bridgeTop = above ? tooltipTop + tooltipRect.height : lineRect.bottom;
    const bridgeHeight = above ? lineRect.top - bridgeTop : tooltipTop - lineRect.bottom;
    if (bridgeHeight <= 0) {
      bridge.hidden = true;
      return;
    }
    bridge.style.left = `${Math.round(overlapLeft)}px`;
    bridge.style.top = `${Math.round(bridgeTop)}px`;
    bridge.style.width = `${Math.max(1, Math.round(overlapRight - overlapLeft))}px`;
    bridge.style.height = `${Math.max(gap, Math.round(bridgeHeight))}px`;
    bridge.hidden = false;
  }

  function isConversationTooltipTarget(value) {
    return Boolean(value && state.conversationTooltip &&
      (value === state.conversationTooltip || state.conversationTooltip.contains(value)));
  }

  function isConversationBridgeTarget(value) {
    return Boolean(value && state.conversationTooltipBridge &&
      (value === state.conversationTooltipBridge || state.conversationTooltipBridge.contains(value)));
  }

  function isConversationTooltipArea(value) {
    return isConversationTooltipTarget(value) || isConversationBridgeTarget(value);
  }

  function isConversationLineTarget(value) {
    const line = state.conversationTooltipTarget;
    return Boolean(value && line && (value === line || line.contains(value)));
  }

  function hideConversationTokenTooltip(line = null) {
    if (line && state.conversationTooltipTarget !== line && state.conversationTooltipPendingLine !== line) return;
    clearConversationTooltipTimer();
    if (state.conversationTooltip) state.conversationTooltip.hidden = true;
    if (state.conversationTooltipBridge) state.conversationTooltipBridge.hidden = true;
    state.conversationTooltipTarget = null;
    state.conversationTooltipPointer = null;
  }

  function clearConversationTooltipTimer() {
    if (state.conversationTooltipTimer != null) {
      window.clearTimeout(state.conversationTooltipTimer);
      state.conversationTooltipTimer = null;
    }
    state.conversationTooltipPendingLine = null;
    state.conversationTooltipPendingPointer = null;
  }

  function renderContextPage(busy) {
    const context = state.data.context ?? {};
    const models = Array.isArray(context.models) ? context.models : [];
    const orphanedCount = Number(context.orphanedCount) || 0;
    const status = String(context.status ?? "unavailable");
    const statusText = {
      "system-default": "使用系统默认值",
      applied: "注入模式已加载覆盖值",
      pending: "覆盖值待加载",
      external: "原有模型目录已保留",
      unavailable: "无法读取系统模型目录",
    }[status] ?? "状态未知";
    const contextNote = status === "external"
      ? `Codex 原有模型目录配置保持不变。注入器运行时会使用当前账号可用的官方目录并合并本工具配置的自定义模型；退出注入器后再次启动 Codex，则恢复使用原有目录。覆盖值仅对注入器启动的 Codex 生效。${orphanedCount ? `有 ${orphanedCount} 条覆盖记录对应的模型已不存在，可用“恢复全部默认”清理。` : ""}`
      : `默认值来自当前账号可用的 Codex 模型目录（OAuth 在线刷新；API Key 使用当前官方 CLI 内置目录；网络不可用时保留上次可用目录）。覆盖值仅对注入器启动的 Codex 生效，保存后会自动重启加载；退出注入器后再次启动 Codex 将恢复官方原生刷新。${orphanedCount ? `有 ${orphanedCount} 条覆盖记录对应的模型已不存在，可用“恢复全部默认”清理。` : ""}`;
    const statusMessage = context.message
      ? `<div class="operation ${context.messageState === "error" ? "error" : "success"}">${escapeHtml(context.message)}</div>`
      : "";
    const modelHtml = models.length
      ? models.map(renderContextModel).join("")
      : '<div class="context-empty">没有可展示的模型目录</div>';
    return `
      <header class="panel-head"><div class="panel-title-wrap"><button class="icon-btn context-back" type="button" aria-label="返回账号额度">←</button><div><div class="panel-title">模型上下文</div><div class="panel-subtitle">${models.length} 个模型 · 已覆盖 ${Number(context.overriddenCount) || 0} 个${orphanedCount ? ` · ${orphanedCount} 个模型已不存在` : ""}</div></div></div>${renderPanelControls()}</header>
      <section class="context-summary"><div class="context-status ${escapeHtml(status)}">${statusText}</div><div class="context-note">${contextNote}</div></section>
      <div class="context-toolbar"><span>系统默认值与当前配置值</span><span class="context-toolbar-actions"><button class="btn context-refresh" type="button" ${busy ? "disabled" : ""}>刷新</button><button class="btn context-reset-all" type="button" ${busy || !Number(context.overriddenCount) ? "disabled" : ""}>恢复全部默认</button></span></div>
      <div class="model-list">${modelHtml}</div>
      ${statusMessage}`;
  }

  function renderManagedDeepSeekBalance(data, platform) {
    const view = data?.deepSeekBalance ?? {};
    const configured = Boolean(platform?.apiKey);
    const items = Array.isArray(view.balance?.items) ? view.balance.items : [];
    const cards = items.length
      ? items.map((item) => `<div class="balance-card"><div class="balance-currency">${escapeHtml(item.currency)}</div><div class="balance-total">${escapeHtml(item.totalBalance)}</div><div class="balance-detail">赠送余额 ${escapeHtml(item.grantedBalance)} · 充值余额 ${escapeHtml(item.toppedUpBalance)}</div></div>`).join("")
      : `<div class="context-empty">${configured ? "暂无可用余额数据" : "保存 API Key 后可查询余额"}</div>`;
    const error = view.error
      ? `<div class="quota-error">${escapeHtml(view.error)}（保留上次成功余额）</div>`
      : "";
    const status = view.balance
      ? ` · ${view.balance.available ? "账户可用" : "账户不可用"}`
      : "";
    return `<section class="balance-section managed-deepseek-balance" data-platform-id="${escapeHtml(platform?.id ?? "")}"><div class="balance-head"><span>账户余额${status} · ${escapeHtml(formatUpdatedAt(view.updatedAt))}</span><button class="btn extra-deepseek-refresh-balance" type="button" ${!configured || view.refreshing ? "disabled" : ""}>${view.refreshing ? "查询中" : "查询余额"}</button></div><div class="balance-grid">${cards}</div>${error}</section>`;
  }

  function renderExtraModelsPage() {
    const data = state.data.extraModels ?? {};
    const platforms = Array.isArray(data.platforms) ? data.platforms : [];
    const supported = data.supported !== false;
    const pendingRestart = Boolean(data.pendingRestart);
    const modelOperation = data.operation ?? state.extraModelOperationDraft;
    const operationBusy = modelOperation?.state === "loading";
    const catalogConflicts = Array.isArray(data.catalogConflicts) ? data.catalogConflicts : [];
    const statusMessage = renderExtraModelFeedback(data, modelOperation);
    const catalogConflictMessage = catalogConflicts.length
      ? `<div class="quota-error">以下自定义模型 ID 已被新官方目录占用，本次注入优先使用官方模型，其他自定义模型不受影响：${catalogConflicts.map((item) => escapeHtml(item.modelId)).join("、")}</div>`
      : "";
    const content = state.extraPlatformDraft
      ? renderExtraPlatformForm(state.extraPlatformDraft, supported && !operationBusy)
      : `<div class="extra-platform-toolbar"><span>DeepSeek 已内置；其他兼容平台仍可手动添加</span><button class="btn primary extra-platform-add" type="button" ${supported && !operationBusy ? "" : "disabled"}>添加平台</button></div>
        <div class="extra-platform-list">${platforms.length
          ? platforms.map((platform) => `<article class="extra-platform-card" data-platform-id="${escapeHtml(platform.id)}">
              <div class="extra-platform-head"><div class="extra-platform-name">${escapeHtml(platform.name)}</div><div class="badges">${platform.preset === "deepseek" ? '<span class="badge">官方预设</span>' : ""}<span class="badge ${platform.enabled ? "current" : ""}">${platform.enabled ? "已启用" : "未启用"}</span><button class="btn extra-platform-detect" type="button" data-platform-id="${escapeHtml(platform.id)}" ${operationBusy || !platform.enabled ? "disabled" : ""}>${modelOperation?.platformId === platform.id && modelOperation?.phase === "detecting" ? "检测中…" : "重新检测"}</button><button class="btn extra-platform-edit" type="button" data-platform-id="${escapeHtml(platform.id)}" ${operationBusy ? "disabled" : ""}>${platform.preset === "deepseek" ? "设置" : "编辑"}</button></div></div>
              <div class="extra-platform-url">${escapeHtml(platform.baseUrl)}</div>
              <div class="extra-platform-meta">${platform.models.filter((model) => model.selected !== false).length} / ${platform.models.length} 个模型已选 · 自动检测连接方式和模型能力</div>
              <div class="extra-platform-progress">${modelOperation?.platformId === platform.id ? renderExtraModelProgress(modelOperation) : ""}</div>
              <div class="extra-platform-model-status">${platform.models.filter((model) => model.selected !== false).map((model) => renderExtraModelCompatibility(model, true)).join("")}</div>
              ${platform.preset === "deepseek" ? renderManagedDeepSeekBalance(data, platform) : ""}
            </article>`).join("")
          : '<div class="context-empty">尚未添加额外模型平台</div>'}</div>`;
    return `
      <header class="panel-head"><div class="panel-title-wrap"><button class="icon-btn extra-models-back" type="button" aria-label="返回账号额度">←</button><div><div class="panel-title">模型管理</div><div class="panel-subtitle">平台、模型与兼容能力</div></div></div>${renderPanelControls()}</header>
      <section class="provider-summary"><div class="provider-status"><span class="${platforms.some((platform) => platform.enabled) ? "enabled" : "disabled"}">${platforms.some((platform) => platform.enabled) ? "已配置启用平台" : "暂无启用平台"}</span><span class="badge">${platforms.length} 个平台</span>${pendingRestart ? '<span class="badge pending-restart">等待重启生效</span>' : ""}</div><div class="provider-note">启用平台时会发送少量真实模型请求，自动验证连接方式、流式输出、工具续接、推理与推理强度、模型内置联网和图片输入。上下文由你按 K 填写，不参与自动探测。检测和模型请求会产生少量 Token。</div></section>
      ${content}
      ${catalogConflictMessage}
      ${supported ? "" : '<div class="quota-error">额外模型共存当前仅支持 macOS 和 Windows。</div>'}
      <div class="extra-model-feedback" aria-live="polite">${statusMessage}</div>`;
  }

  function renderExtraModelFeedback(data, operation = data?.operation) {
    if (operation?.state === "loading") return renderExtraModelProgress(operation);
    return data?.message
      ? `<div class="operation ${data.messageState === "error" ? "error" : "success"}">${escapeHtml(data.message)}</div>`
      : "";
  }

  function renderExtraModelProgress(operation) {
    if (operation?.state !== "loading") return "";
    const current = Math.max(1, Math.floor(Number(operation.current) || 1));
    const total = Math.max(current, Math.floor(Number(operation.total) || current));
    const step = Math.max(0, Math.floor(Number(operation.step) || 0));
    const steps = Math.max(step, Math.floor(Number(operation.steps) || 0));
    if (operation.phase !== "detecting" || steps === 0) {
      return `<div class="operation extra-model-progress" role="status">${escapeHtml(operation.message || "正在处理模型配置")}</div>`;
    }
    const modelProgress = Math.min(1, step / steps);
    const percent = Math.max(1, Math.min(100, Math.round(
      ((current - 1 + modelProgress) / total) * 100,
    )));
    const detail = `${step}/${steps} · ${operation.detail || "正在检测模型能力"}${operation.retry ? " · 重试中" : ""}`;
    return `<div class="operation extra-model-progress" role="status" aria-live="polite">
      <div class="extra-model-progress-body">
        <div class="extra-model-progress-head"><span class="extra-model-progress-title">${escapeHtml(operation.message || "正在检测模型")}</span><span class="extra-model-progress-percent">${percent}%</span></div>
        <span class="extra-model-progress-track" aria-hidden="true"><i style="width:${percent}%"></i></span>
        <div class="extra-model-progress-detail">${escapeHtml(detail)}</div>
      </div>
    </div>`;
  }

  function applyExtraModelDiscovery(extraModels) {
    const discovery = extraModels?.modelDiscovery;
    if (state.extraPlatformDraft?.preset !== "deepseek" ||
      discovery?.platformId !== state.extraPlatformDraft.id ||
      Number(discovery.revision) <= state.extraModelDiscoveryRevision) return false;
    state.extraModelDiscoveryRevision = Number(discovery.revision);
    state.extraPlatformDraft = {
      ...state.extraPlatformDraft,
      models: Array.isArray(discovery.models)
        ? discovery.models.map((model) => ({
            ...model,
            compatibility: model.compatibility ? { ...model.compatibility } : { status: "pending" },
          }))
        : state.extraPlatformDraft.models,
      modelsUpdatedAt: discovery.modelsUpdatedAt ?? state.extraPlatformDraft.modelsUpdatedAt,
    };
    return true;
  }

  function patchExtraModelsDom(extraModels, { clearDraftOperation = false } = {}) {
    const discoveryChanged = applyExtraModelDiscovery(extraModels);
    state.data = { ...state.data, extraModels: extraModels ?? { platforms: [] } };
    if (clearDraftOperation) state.extraModelOperationDraft = null;
    const wrap = state.shadow?.querySelector(".quota-wrap");
    if (!wrap) return;
    patchPanelBalance(wrap);
    if (state.page !== "extra-models") return;
    const data = state.data.extraModels ?? {};
    const platforms = Array.isArray(data.platforms) ? data.platforms : [];
    const operation = data.operation ?? state.extraModelOperationDraft;
    const busy = operation?.state === "loading";
    const feedback = wrap.querySelector(".extra-model-feedback");
    if (feedback) feedback.innerHTML = renderExtraModelFeedback(data, operation);
    const pendingBadge = wrap.querySelector(".pending-restart");
    if (data.pendingRestart && !pendingBadge) {
      const status = wrap.querySelector(".provider-status");
      status?.insertAdjacentHTML("beforeend", '<span class="badge pending-restart">等待重启生效</span>');
    } else if (!data.pendingRestart) {
      pendingBadge?.remove();
    }
    wrap.querySelector(".extra-platform-add")?.toggleAttribute("disabled", busy);
    for (const card of wrap.querySelectorAll(".extra-platform-card")) {
      const platform = platforms.find((item) => item.id === card.dataset.platformId);
      if (!platform) continue;
      const progress = card.querySelector(".extra-platform-progress");
      if (progress) progress.innerHTML = operation?.platformId === platform.id
        ? renderExtraModelProgress(operation)
        : "";
      const status = card.querySelector(".extra-platform-model-status");
      if (status) status.innerHTML = platform.models
        .filter((model) => model.selected !== false)
        .map((model) => renderExtraModelCompatibility(model, true))
        .join("");
      if (platform.preset === "deepseek") {
        const balance = card.querySelector(".managed-deepseek-balance");
        if (balance) balance.outerHTML = renderManagedDeepSeekBalance(data, platform);
      }
      const meta = card.querySelector(".extra-platform-meta");
      if (meta) meta.textContent = `${platform.models.filter((model) => model.selected !== false).length} / ${platform.models.length} 个模型已选 · 自动检测连接方式和模型能力`;
      const detect = card.querySelector(".extra-platform-detect");
      if (detect) {
        detect.disabled = busy || !platform.enabled;
        detect.textContent = operation?.platformId === platform.id && operation?.phase === "detecting"
          ? "检测中…"
          : "重新检测";
      }
      const edit = card.querySelector(".extra-platform-edit");
      if (edit) edit.disabled = busy;
    }
    const form = wrap.querySelector(".extra-platform-form");
    form?.querySelector('button[type="submit"]')?.toggleAttribute("disabled", busy);
    form?.querySelector(".preset-model-refresh")?.toggleAttribute("disabled", busy);
    if (discoveryChanged && state.extraPlatformDraft?.preset === "deepseek") {
      const picker = form?.querySelector(".preset-model-picker");
      if (picker) picker.outerHTML = renderDeepSeekModelPicker(state.extraPlatformDraft.models, !busy);
    }
    bindManagedDeepSeekBalanceButtons(wrap);
  }

  function showExtraModelOperation({ message, platformId = null, phase = "starting" }) {
    state.extraModelOperationDraft = { state: "loading", message, platformId, phase };
    patchExtraModelsDom(state.data.extraModels);
  }

  function bindManagedDeepSeekBalanceButtons(scope) {
    for (const button of scope.querySelectorAll(".extra-deepseek-refresh-balance")) {
      if (button.dataset.bound === "true") continue;
      button.dataset.bound = "true";
      button.addEventListener("click", () => enqueue({ type: "extra-deepseek-refresh-balance" }));
    }
  }

  function renderExtraPlatformForm(platform, editable) {
    if (platform.preset === "deepseek") return renderDeepSeekPresetForm(platform, editable);
    const models = Array.isArray(platform.models) && platform.models.length
      ? platform.models
      : [blankExtraModel()];
    return `<form class="extra-platform-form" data-platform-id="${escapeHtml(platform.id ?? "")}">
      <label class="provider-toggle"><input name="enabled" type="checkbox" ${platform.enabled ? "checked" : ""} ${editable ? "" : "disabled"}>在模型列表中启用该平台</label>
      <div class="provider-field"><label>平台名称</label><input name="name" value="${escapeHtml(platform.name ?? "")}" placeholder="例如 TokenHub" required ${editable ? "" : "disabled"}></div>
      <div class="provider-field"><label>API Base URL</label><input name="baseUrl" value="${escapeHtml(platform.baseUrl ?? "")}" placeholder="https://example.com/v1" spellcheck="false" required ${editable ? "" : "disabled"}></div>
      <div class="provider-field"><label>API Key（本地明文保存并完整回显）</label><input class="provider-key" name="apiKey" type="text" autocomplete="off" spellcheck="false" value="${escapeHtml(platform.apiKey ?? "")}" placeholder="th-..." ${editable ? "" : "disabled"}></div>
      <div class="extra-models-head"><span>平台模型</span><button class="btn extra-model-add" type="button" ${editable ? "" : "disabled"}>添加模型</button></div>
      <div class="extra-model-list">${models.map((model, index) => `<div class="extra-model-row" data-model-index="${index}">
        <div class="provider-field"><label>模型 ID</label><input name="modelId" value="${escapeHtml(model.id ?? "")}" placeholder="model-id" required ${editable ? "" : "disabled"}></div>
        <div class="provider-field"><label>显示名称</label><input name="displayName" value="${escapeHtml(model.displayName ?? "")}" placeholder="模型显示名称" ${editable ? "" : "disabled"}></div>
        <div class="provider-field"><label>上下文（K）</label><input name="contextWindow" type="number" min="1" step="0.001" value="${escapeHtml(contextTokensToK(model.contextWindow ?? 128000))}" required ${editable ? "" : "disabled"}></div>
        <button class="btn extra-model-remove" type="button" ${editable && models.length > 1 ? "" : "disabled"}>移除</button>
        ${renderExtraModelCompatibility(model)}
        ${renderExtraModelReasoning(model, editable)}
      </div>`).join("")}</div>
      <div class="provider-warning">Key 保存在 ${escapeHtml(state.data.extraModels?.settingsPath ?? "本地 extra-model-settings.json")}；不写入系统安全存储。启用时将自动检测每个模型并产生少量 Token；检测通过后保存，重启 Codex 后生效。</div>
      <div class="provider-actions">${platform.id ? '<button class="btn extra-platform-remove" type="button">删除平台</button>' : ""}<button class="btn extra-platform-cancel" type="button">取消</button><button class="btn primary" type="submit" ${editable ? "" : "disabled"}>${platform.enabled ? "检测并保存" : "保存停用配置"}</button></div>
    </form>`;
  }

  function renderDeepSeekPresetForm(platform, editable) {
    const models = Array.isArray(platform.models) ? platform.models : [];
    const refreshed = platform.modelsUpdatedAt
      ? `最近读取：${escapeHtml(formatUpdatedAt(platform.modelsUpdatedAt))}`
      : "首次保存时读取当前 Key 可用模型";
    return `<form class="extra-platform-form preset-platform-form" data-platform-id="${escapeHtml(platform.id ?? "")}" data-platform-preset="deepseek">
      <label class="provider-toggle"><input name="enabled" type="checkbox" ${platform.enabled ? "checked" : ""} ${editable ? "" : "disabled"}>在模型列表中启用 DeepSeek</label>
      <div class="provider-field"><label>DeepSeek API Key（本地明文保存并完整回显）</label><input class="provider-key" name="apiKey" type="text" autocomplete="off" spellcheck="false" value="${escapeHtml(platform.apiKey ?? "")}" placeholder="sk-..." ${editable ? "" : "disabled"}></div>
      <div class="preset-platform-note"><span>官方地址：${escapeHtml(platform.baseUrl)}</span><span>模型列表由 DeepSeek 官方 /models 接口读取；连接、工具、推理、内置联网和图片能力自动检测。上下文由你按 K 填写。</span><span>${refreshed}</span></div>
      ${renderDeepSeekModelPicker(models, editable)}
      <div class="provider-warning">启用并保存时会先读取可用模型，再对已选模型发送少量真实请求完成能力检测，因此会产生少量 Token。Key 保存在 ${escapeHtml(state.data.extraModels?.settingsPath ?? "本地 extra-model-settings.json")}。保存后等待重启 Codex 生效。</div>
      <div class="provider-actions"><button class="btn preset-model-refresh" type="button" ${editable ? "" : "disabled"}>读取最新模型</button><button class="btn extra-platform-cancel" type="button">取消</button><button class="btn primary" type="submit" ${editable ? "" : "disabled"}>${platform.enabled ? "检测并保存" : "保存停用配置"}</button></div>
    </form>`;
  }

  function renderDeepSeekModelPicker(models, editable) {
    const selectedCount = models.filter((model) => model.selected !== false).length;
    return `<details class="preset-model-picker" ${models.length <= 3 ? "open" : ""}><summary><span>可用模型</span><span class="badge current preset-model-count">已选 ${selectedCount} / ${models.length}</span></summary><div class="preset-model-options">${models.map((model) => `<div class="preset-model-option"><label class="preset-model-option-select"><input name="presetModel" type="checkbox" value="${escapeHtml(model.id)}" ${model.selected !== false ? "checked" : ""} ${editable ? "" : "disabled"}><div class="preset-model-option-main"><div class="preset-model-option-name">${escapeHtml(model.displayName || model.id)}</div><div class="preset-model-option-id">${escapeHtml(model.id)}</div>${renderExtraModelCompatibility(model)}</div></label><label class="preset-model-context"><span>上下文</span><input name="presetContextWindow" data-model-id="${escapeHtml(model.id)}" type="number" min="1" step="0.001" value="${escapeHtml(contextTokensToK(model.contextWindow ?? 128000))}" required ${editable ? "" : "disabled"}><span>K</span></label></div>`).join("")}</div></details>`;
  }

  function renderExtraModelCompatibility(model, compact = false) {
    const compatibility = model?.compatibility ?? {};
    const modelLabel = compact
      ? `<span class="model-label" title="${escapeHtml(model?.displayName || model?.id || "模型")}">${escapeHtml(model?.displayName || model?.id || "模型")}</span>`
      : '<span class="model-label">自动检测</span>';
    if (compatibility.status === "verified") {
      const capabilities = compatibility.capabilities ?? {};
      const bridgedTools = capabilities.customTools === "bridged" ||
        capabilities.namespaceTools === "bridged";
      const protocolId = compatibility.protocol === "chat" ? "chat" : "responses";
      const protocol = protocolId === "chat" ? "Chat 转换" : "Responses";
      const tools = bridgedTools ? "工具已自动适配" : "工具可用";
      const hostedSearch = capabilities.hostedTools?.web_search === "native";
      const search = hostedSearch ? "内置联网可用" : "内置联网不可用";
      const imageSupported = compatibility.imageStatus === "supported";
      const imageProtocol = compatibility.routes?.imageInput === "chat" ? "chat" : protocolId;
      const image = imageSupported
        ? imageProtocol === protocolId ? "支持图片" : "支持图片 · Chat"
        : "不支持图片";
      const reasoningSupported = capabilities.reasoning === "native";
      const reasoning = reasoningSupported ? "推理：支持" : "推理：不支持";
      const reasoningEfforts = Array.isArray(model.reasoningEfforts)
        ? model.reasoningEfforts.filter((effort) => CUSTOM_REASONING_EFFORTS.includes(effort))
        : [];
      const effortBadge = reasoningEfforts.length
        ? `<span class="badge current">推理强度：${escapeHtml(reasoningEfforts.join(" / "))}（实测接受）</span>`
        : "";
      const checkedAt = compatibility.checkedAt
        ? ` title="检测于 ${escapeHtml(formatUpdatedAt(compatibility.checkedAt))}"`
        : "";
      return `<div class="extra-model-capabilities"${checkedAt}>${modelLabel}<span class="badge current">${protocol}</span><span class="badge current">${tools}</span><span class="badge${reasoningSupported ? " current" : ""}">${reasoning}</span>${effortBadge}<span class="badge${hostedSearch ? " current" : ""}" title="由模型供应商在请求内执行的联网搜索；Codex 独立 web.run 属于另一项能力">${search}</span><span class="badge${imageSupported ? " current" : ""}">${image}</span></div>`;
    }
    const legacy = compatibility.status === "legacy";
    const outdated = compatibility.status === "pending" && Number(compatibility.probeVersion) > 0;
    const pendingLabel = legacy
      ? "沿用旧设置 · 待重新检测"
      : outdated ? "检测规则已更新 · 需重新检测" : "待检测";
    return `<div class="extra-model-capabilities">${modelLabel}<span class="badge pending">${pendingLabel}</span></div>`;
  }

  function renderExtraModelReasoning(model, editable) {
    const selectedEfforts = Array.isArray(model.reasoningEfforts)
      ? model.reasoningEfforts.filter((effort) => CUSTOM_REASONING_EFFORTS.includes(effort))
      : [];
    const defaultEffort = selectedEfforts.includes(model.defaultReasoningEffort)
      ? model.defaultReasoningEffort
      : selectedEfforts[0] ?? "";
    if (model?.compatibility?.status !== "verified") {
      return '<div class="extra-model-reasoning"><span class="extra-model-efforts-label">推理能力和可用强度将在保存时自动检测</span></div>';
    }
    if (selectedEfforts.length === 0) return "";
    const options = selectedEfforts.length
      ? selectedEfforts.map((effort) => `<option value="${effort}" ${effort === defaultEffort ? "selected" : ""}>${effort}</option>`).join("")
      : '<option value="">平台默认</option>';
    return `<div class="extra-model-reasoning">
      <div class="provider-field"><label>默认强度</label><select name="defaultReasoningEffort" ${editable && selectedEfforts.length ? "" : "disabled"}>${options}</select></div>
    </div>`;
  }

  function blankExtraModel() {
    return {
      id: "",
      displayName: "",
      contextWindow: 128000,
      compatibility: { status: "pending" },
      reasoningEfforts: [],
      defaultReasoningEffort: "",
    };
  }

  function readExtraPlatformForm(form) {
    if (!form) return state.extraPlatformDraft;
    if (form.dataset.platformPreset === "deepseek") {
      const selected = new Set([...form.querySelectorAll('[name="presetModel"]:checked')]
        .map((input) => input.value));
      const contexts = new Map([...form.querySelectorAll('[name="presetContextWindow"]')]
        .map((input) => [input.dataset.modelId, contextKToTokens(input.value)]));
      return {
        ...state.extraPlatformDraft,
        id: form.dataset.platformId ?? "",
        preset: "deepseek",
        name: "DeepSeek",
        baseUrl: "https://api.deepseek.com/",
        apiKey: form.querySelector('[name="apiKey"]')?.value ?? "",
        enabled: Boolean(form.querySelector('[name="enabled"]')?.checked),
        models: (state.extraPlatformDraft?.models ?? []).map((model) => ({
          ...model,
          selected: selected.has(model.id),
          contextWindow: contexts.get(model.id) ?? model.contextWindow,
        })),
      };
    }
    return {
      id: form.dataset.platformId ?? "",
      name: form.querySelector('[name="name"]')?.value ?? "",
      baseUrl: form.querySelector('[name="baseUrl"]')?.value ?? "",
      apiKey: form.querySelector('[name="apiKey"]')?.value ?? "",
      enabled: Boolean(form.querySelector('[name="enabled"]')?.checked),
      models: [...form.querySelectorAll(".extra-model-row")].map((row, index) => ({
        id: row.querySelector('[name="modelId"]')?.value ?? "",
        displayName: row.querySelector('[name="displayName"]')?.value ?? "",
        contextWindow: contextKToTokens(row.querySelector('[name="contextWindow"]')?.value),
        selected: true,
        compatibility: state.extraPlatformDraft?.models?.[index]?.compatibility
          ? { ...state.extraPlatformDraft.models[index].compatibility }
          : { status: "pending" },
        reasoningEfforts: [...(state.extraPlatformDraft?.models?.[index]?.reasoningEfforts ?? [])],
        defaultReasoningEffort: row.querySelector('[name="defaultReasoningEffort"]')?.value ?? "",
      })),
    };
  }

  function renderContextModel(model) {
    const editing = state.contextEditingSlug === model.slug;
    return `<article class="model-card ${model.overridden ? "overridden" : ""}">
      <div class="model-head"><div class="model-name-wrap"><div class="model-name" title="${escapeHtml(model.displayName)}">${escapeHtml(model.displayName)}</div><div class="model-slug">${escapeHtml(model.slug)}</div></div><div class="model-actions"><span class="badge ${model.overridden ? "current" : ""}">${model.overridden ? "已覆盖" : "系统默认"}</span><button class="btn context-edit-open" type="button" data-slug="${escapeHtml(model.slug)}">${editing ? "收起" : "修改"}</button></div></div>
      <div class="model-values"><div class="model-value"><span>系统默认上下文</span><strong>${formatContextValue(model.defaultContextWindow)}</strong></div><div class="model-value"><span>当前配置上下文</span><strong>${formatContextValue(model.effectiveContextWindow)}</strong></div></div>
      <div class="model-max">最大上下文：系统 ${formatContextValue(model.defaultMaxContextWindow)} · 配置 ${formatContextValue(model.effectiveMaxContextWindow)}</div>
      ${renderContextEditForm(model, !editing)}
    </article>`;
  }

  function renderContextEditForm(model, hidden) {
    const contextValue = model.effectiveContextWindow ?? "";
    const maxContextValue = model.effectiveMaxContextWindow ?? "";
    return `<form class="context-edit-form" data-slug="${escapeHtml(model.slug)}" data-max-context-window="${escapeHtml(maxContextValue)}"${hidden ? " hidden" : ""}>
      <div class="context-field"><label>上下文窗口</label><input name="contextWindow" type="number" min="1" step="1" inputmode="numeric" value="${escapeHtml(contextValue)}" required></div>
      <details class="context-advanced"><summary>高级：单独设置最大上下文窗口</summary><div class="context-field"><label>最大上下文窗口</label><input name="maxContextWindow" type="number" min="1" step="1" inputmode="numeric" value="${escapeHtml(maxContextValue)}" required></div></details>
      <div class="context-edit-actions"><button class="btn context-edit-cancel" type="button">取消</button>${model.overridden ? '<button class="btn context-reset" type="button">恢复系统默认</button>' : ""}<button class="btn primary" type="submit">保存覆盖值</button></div>
    </form>`;
  }

  function positionPopover(wrap) {
    const chip = wrap.querySelector(".quota-chip");
    const popover = wrap.querySelector(".quota-popover");
    if (!chip || !popover) return;
    const chipRect = chip.getBoundingClientRect();
    const availableHeight = calculateMaxHeight(chipRect.top);
    popover.style.bottom = `${Math.max(12, window.innerHeight - chipRect.top + 10)}px`;
    popover.style.maxHeight = `${availableHeight}px`;
    if (popover.classList.contains("detail-popover")) {
      applyDetailPanelSize(wrap, popover);
    } else {
      popover.style.removeProperty("width");
      popover.style.removeProperty("height");
    }
  }

  function captureDetailPanelBaseSize(wrap) {
    const popover = wrap.querySelector(".quota-popover");
    if (!popover) return;
    const width = Math.max(1, Math.round(popover.offsetWidth));
    const height = Math.max(1, Math.round(popover.offsetHeight));
    state.detailPanelBaseSize = { width, height };
    state.detailPanelSize = { width, height };
    state.detailPanelResize = null;
  }

  function resetDetailPanelSize() {
    cancelDetailPanelResize();
    state.detailPanelBaseSize = null;
    state.detailPanelSize = null;
  }

  function cancelDetailPanelResize() {
    state.detailPanelResizeCleanup?.();
    state.detailPanelResizeCleanup = null;
    state.detailPanelResize = null;
  }

  function detailPanelBounds(wrap) {
    const chip = wrap.querySelector(".quota-chip");
    return {
      maxWidth: Math.max(0, Math.floor(window.innerWidth - 24)),
      maxHeight: chip ? calculateMaxHeight(chip.getBoundingClientRect().top) : 0,
    };
  }

  function applyDetailPanelSize(wrap, popover, requested = state.detailPanelSize) {
    const base = state.detailPanelBaseSize;
    if (!base) return;
    const bounds = detailPanelBounds(wrap);
    const minimumWidth = Math.min(base.width, bounds.maxWidth);
    const minimumHeight = Math.min(base.height, bounds.maxHeight);
    const width = Math.min(bounds.maxWidth, Math.max(minimumWidth, requested?.width ?? base.width));
    const height = Math.min(bounds.maxHeight, Math.max(minimumHeight, requested?.height ?? base.height));
    popover.style.width = `${width}px`;
    popover.style.height = `${height}px`;
    return { width, height };
  }

  function isLightTheme() {
    return document.documentElement.classList.contains("electron-light") ||
      (!document.documentElement.classList.contains("electron-dark") &&
        window.matchMedia?.("(prefers-color-scheme: light)").matches);
  }

  function renderMigrationPage(accounts, busy, operation) {
    const mode = state.migrationMode === "handoff" ? "handoff" : "temporary";
    const isEligible = (account) => mode === "handoff"
      ? account.canTransfer === true
      : account.canTemporaryTransfer === true;
    for (const accountId of state.migrationSelectedIds) {
      const account = accounts.find((item) => item.id === accountId);
      if (!account || !isEligible(account)) state.migrationSelectedIds.delete(accountId);
    }
    const rows = accounts.map((account) => {
      const eligible = isEligible(account);
      const checked = eligible && state.migrationSelectedIds.has(account.id);
      const stateText = account.authStatus === "transferred"
        ? "已转出"
        : account.authStatus === "needsReauth"
          ? "需要重新授权"
          : account.authStatus === "temporary"
            ? "临时凭据"
            : mode === "temporary" && account.authMode === "apiKey"
              ? "仅支持完整转移"
              : account.current
                ? "当前账号"
                : formatPlan(account.authMode);
      return `<label class="migration-account-row">
        <input class="migration-account-checkbox" type="checkbox" value="${escapeHtml(account.id)}" ${checked ? "checked" : ""} ${busy || !eligible ? "disabled" : ""}>
        <span class="migration-account-label" title="${escapeHtml(account.email)}">${escapeHtml(account.email)}</span>
        <span class="migration-account-state">${escapeHtml(stateText)}</span>
      </label>`;
    }).join("");
    const selectedAccounts = accounts.filter((account) => state.migrationSelectedIds.has(account.id));
    const currentSelected = mode === "handoff" && selectedAccounts.some((account) => account.current);
    const currentNote = currentSelected
      ? '<div class="migration-current-note">所选账号包含当前账号。生成文件后，Codex 将自动切换到其他可用账号；没有可用账号时会退出登录并重新启动。</div>'
      : "";
    const modeNote = mode === "temporary"
      ? "导出前会主动刷新所选 OAuth 账号，把新的 access token 和 refresh token 都写回本机加密账户库；若包含当前账号，也同步写回 Codex 登录。迁移文件只包含 access token，新设备只能使用到它过期。"
      : "导出前会主动刷新所选 OAuth 账号，把新的 access token 和 refresh token 都写回本机加密账户库供恢复验证。迁移文件包含完整凭据；生成后本机账号标记为“已转出”，停止刷新、切换和唤醒。";
    const submitText = mode === "handoff" ? "确认完整转移" : "生成临时迁移文件";
    return `<header class="panel-head"><div class="panel-title-wrap"><button class="icon-btn migration-back" type="button" aria-label="返回账号额度">←</button><div><div class="panel-title">账号迁移</div><div class="panel-subtitle">导入继续使用账号管理中的 Token / JSON</div></div></div>${renderPanelControls()}</header>
      <form class="migration-form">
        <div class="migration-options">
          <label class="migration-option ${mode === "temporary" ? "selected" : ""}"><input class="migration-mode" type="radio" name="migrationMode" value="temporary" ${mode === "temporary" ? "checked" : ""} ${busy ? "disabled" : ""}><span><span class="migration-option-title">临时使用</span><span class="migration-option-note">不导出 refresh token，本机账号不停止。</span></span></label>
          <label class="migration-option ${mode === "handoff" ? "selected" : ""}"><input class="migration-mode" type="radio" name="migrationMode" value="handoff" ${mode === "handoff" ? "checked" : ""} ${busy ? "disabled" : ""}><span><span class="migration-option-title">完整转移</span><span class="migration-option-note">新设备接管刷新凭据，本机进入已转出状态。</span></span></label>
        </div>
        <section class="provider-summary"><div class="provider-note">${escapeHtml(modeNote)}</div><div class="provider-warning">迁移文件包含明文敏感凭据，只能存放在可信设备中。</div></section>
        <div class="add-title">选择账号</div>
        <div class="migration-account-list">${rows || '<div class="empty">暂无账号</div>'}</div>
        ${currentNote}
        ${operation}
        <div class="migration-actions"><button class="btn primary migration-submit" type="submit" ${busy || selectedAccounts.length === 0 ? "disabled" : ""}>${submitText}</button></div>
      </form>`;
  }

  function renderWakeupPage(busy) {
    const accounts = (state.data.accounts ?? []).filter((item) =>
      item.authMode === "oauth" && item.authStatus === "active"
    );
    const header = `<header class="panel-head"><div class="panel-title-wrap"><button class="icon-btn wakeup-back" type="button" aria-label="返回账号额度">←</button><div><div class="panel-title">每日唤醒</div><div class="panel-subtitle">${accounts.length} 个账号 · 已开启 ${accounts.filter((item) => item.wakeup?.enabled).length} 个</div></div></div>${renderPanelControls()}</header>`;
    if (!accounts.length) return `${header}<div class="empty">添加 OAuth 账号后可配置每日唤醒；API Key 账号不支持此功能</div>`;
    return `${header}
      <section class="provider-summary">
        <div class="provider-note">每天按电脑本地时区执行，可添加多个时刻。需要保持 Codex 和注入器运行；关闭或长时间休眠后不补发错过的时刻。</div>
        <div class="provider-note">自动使用可用的最低价模型及最低推理强度。手动唤醒无需开启定时；多个账号依次执行。</div>
      </section>
      <div class="account-list">${accounts.map((account) => renderWakeupAccount(account, busy)).join("")}</div>`;
  }

  function renderWakeupAccount(account, busy) {
    const wakeup = account.wakeup ?? {};
    const draft = state.wakeupDrafts.get(account.id) ?? { enabled: Boolean(wakeup.enabled), times: [...(wakeup.times ?? [])] };
    const accountId = escapeHtml(account.id);
    const lastRun = wakeup.lastRun;
    const statusNames = { running: "执行中", success: "唤醒成功（模型已回复）", error: "唤醒未成功" };
    const result = lastRun
      ? `<div class="operation wakeup-result ${escapeHtml(lastRun.status)}">
          <div>${lastRun.source === "scheduled" ? "定时" : "手动"}唤醒 · ${escapeHtml(statusNames[lastRun.status] ?? "未知")} · ${escapeHtml(formatUpdatedAt(lastRun.startedAt))}</div>
          ${lastRun.scheduledTime ? `<div>计划时刻：${escapeHtml(lastRun.scheduledTime)}</div>` : ""}
          <div>${escapeHtml(lastRun.message)}</div>
          ${lastRun.model ? `<div>模型：${escapeHtml(lastRun.model)}</div>` : ""}
          ${lastRun.reply ? `<div>回复：${escapeHtml(lastRun.reply)}</div>` : ""}
        </div>` : '<div class="context-note">尚未执行唤醒</div>';
    const message = wakeup.message
      ? `<div class="operation ${escapeHtml(wakeup.message.status)}">${escapeHtml(wakeup.message.text)}</div>` : "";
    const timeRows = draft.times.map((time, index) => `<div class="wakeup-time-row">
      <label for="wakeup-time-${accountId}-${index}">时刻 ${index + 1}</label>
      <input id="wakeup-time-${accountId}-${index}" name="time" type="time" step="60" value="${escapeHtml(time)}" required ${busy ? "disabled" : ""}>
      <button class="btn wakeup-time-remove" type="button" data-time-index="${index}" ${busy ? "disabled" : ""}>移除</button>
    </div>`).join("");
    return `<article id="wakeup-account-${accountId}" class="account-card ${account.current ? "current" : ""}">
      <div class="account-head"><span class="account-email" title="${escapeHtml(account.email)}">${escapeHtml(account.email)}</span><span class="badges">${account.current ? '<span class="badge current">当前</span>' : ""}<span class="badge ${wakeup.enabled ? "current" : ""}">${wakeup.enabled ? "已开启" : "未开启"}</span></span></div>
      <div class="expiry">下次计划：${wakeup.nextAt ? escapeHtml(formatUpdatedAt(wakeup.nextAt)) : "未开启"}</div>
      <form class="wakeup-form" data-account-id="${accountId}">
        <label class="provider-toggle"><input id="wakeup-enabled-${accountId}" name="enabled" type="checkbox" ${draft.enabled ? "checked" : ""} ${busy ? "disabled" : ""}>开启每日定时唤醒</label>
        <div class="wakeup-times">${timeRows || '<div class="context-note">尚未添加时间</div>'}</div>
        <div class="provider-actions"><button class="btn wakeup-time-add" type="button" ${busy ? "disabled" : ""}>添加时间</button><button class="btn wakeup-now" type="button" data-account-id="${accountId}" ${busy || wakeup.busy || account.authStatus === "needsReauth" ? "disabled" : ""}>${wakeup.busy ? "唤醒中…" : "立即唤醒"}</button><button class="btn primary" type="submit" ${busy ? "disabled" : ""}>保存设置</button></div>
      </form>
      ${message}
      ${result}
    </article>`;
  }

  function renderWakeupStatus(account) {
    if (account.authMode !== "oauth" || account.authStatus !== "active") return "";
    const wakeup = account.wakeup ?? {};
    const lastRun = wakeup.lastRun;
    const result = lastRun
      ? ({ running: "执行中", success: "成功", error: "未成功" }[lastRun.status] ?? "未知")
      : wakeup.busy ? "等待执行" : "尚未执行";
    const lines = [
      `配置时间：${wakeup.times?.length ? wakeup.times.join("、") : "未配置"}`,
      lastRun?.startedAt ? `${formatUpdatedAt(lastRun.startedAt)} · ${result}` : result,
    ];
    const tooltip = escapeHtml(lines.join("\n"));
    return `<button class="btn account-switch wakeup-status wakeup-open ${wakeup.enabled ? "primary" : ""}" type="button" data-account-id="${escapeHtml(account.id)}" data-account-tooltip="${tooltip}" aria-label="每日唤醒${wakeup.enabled ? "已开启" : "未开启"}；${tooltip}；点击打开设置">唤醒</button>`;
  }

  function readWakeupForm(form) {
    return {
      enabled: Boolean(form?.querySelector('[name="enabled"]')?.checked),
      times: [...(form?.querySelectorAll('[name="time"]') ?? [])].map((input) => input.value),
    };
  }

  function renderAccount(account) {
    const windows = Array.isArray(account.windows) ? account.windows : [];
    const quotaHtml = windows.length
      ? `<div class="window-list">${windows.map((quota, idx) => renderWindow(quota, idx === windows.length - 1 ? account : null)).join("")}</div>`
      : account.credits?.formattedUsd
        ? `<div class="window-list"><div class="window-row"><div class="window-subline"><span class="window-credit">点数：${escapeHtml(account.credits.formattedUsd)}</span></div></div></div>`
        : '<div class="expiry">暂无额度数据</div>';
    const expiry = formatExpiry(account.subscriptionActiveUntil);
    const updatedAt = formatUpdatedAt(account.quotaUpdatedAt);
    const busy = state.data.operation?.state === "loading";
    const needsReauth = account.authStatus === "needsReauth";
    const transferred = account.authStatus === "transferred";
    const temporary = account.authStatus === "temporary";
    const switchControl = account.current
      ? ""
      : transferred
        ? ""
      : needsReauth
        ? '<span class="badge">需要重新授权</span>'
        : `<button class="btn primary account-switch switch-account" type="button" data-account-id="${escapeHtml(account.id)}" data-account-tooltip="切换到此账号" aria-label="切换到此账号" ${busy ? "disabled" : ""}>切换</button>`;
    const removeControl = `<button class="btn account-remove remove-account" type="button" data-account-id="${escapeHtml(account.id)}" data-account-email="${escapeHtml(account.email)}" title="${account.current ? "当前账号请先切换后再移除" : "移除本工具保存的账号凭据"}" ${busy || account.current ? "disabled" : ""}>移除</button>`;
    const authStateControl = transferred
      ? `<button class="badge transferred restore-transferred" type="button" data-account-id="${escapeHtml(account.id)}" data-account-email="${escapeHtml(account.email)}" data-auth-mode="${escapeHtml(account.authMode)}" title="点击验证并恢复本机使用" ${busy ? "disabled" : ""}>已转出</button>`
      : temporary
        ? '<span class="badge">临时</span>'
        : "";
    const stateMeta = transferred
      ? `<span>转出：${escapeHtml(formatUpdatedAt(account.transferredAt))}</span>`
      : temporary
        ? `<span>临时至：${escapeHtml(formatUpdatedAt(account.temporaryExpiresAt))}</span>`
        : `<span>订阅：${escapeHtml(expiry)}</span>`;
    return `<article class="account-card ${account.current ? "current" : ""} ${transferred ? "transferred" : ""}">
      <div class="account-head"><span class="account-email" title="${escapeHtml(account.email)}">${escapeHtml(account.email)}</span><span class="badges">${account.current ? '<span class="badge current">当前</span>' : ""}${authStateControl}${switchControl}${removeControl}${renderWakeupStatus(account)}<span class="badge">${escapeHtml(formatPlan(account.planType ?? account.authMode))}</span></span></div>
      <div class="expiry account-meta">${stateMeta}<span>最后刷新：${escapeHtml(updatedAt)}</span></div>
      ${quotaHtml}
      ${account.quotaError ? `<div class="quota-error">刷新异常：${escapeHtml(account.quotaError)}</div>` : ""}
    </article>`;
  }

  function renderWindow(quota, account = null) {
    const remaining = number(quota.remainingPercent);
    const creditText = account?.credits?.formattedUsd
      ? `点数：${escapeHtml(account.credits.formattedUsd)}`
      : account?.credits?.unlimited
        ? "点数：无限"
        : "";
    const resetText = quota.resetsAt ? `重置：${escapeHtml(formatReset(quota.resetsAt))}` : "";
    return `<div class="window-row">
      <span class="window-label">${escapeHtml(quota.label ?? "Usage")}</span>
      <span class="window-left ${levelClass(remaining)}">${remaining}%</span>
      <span class="window-track"><i style="width:${remaining}%"></i></span>
      <div class="window-subline">
        <span class="window-credit">${creditText}</span>
        <span class="window-reset">${resetText}</span>
      </div>
    </div>`;
  }

  function hideAccountTooltip() {
    window.clearTimeout(state.accountTooltipTimer);
    state.accountTooltipTimer = null;
    state.shadow?.querySelector(".account-tooltip")?.remove();
  }

  function scheduleAccountTooltip(button) {
    hideAccountTooltip();
    state.accountTooltipTimer = window.setTimeout(() => {
      state.accountTooltipTimer = null;
      if (!button.isConnected || !state.pinned || state.dismissed) return;
      const panel = button.closest(".quota-popover");
      if (!panel) return;
      const tooltip = document.createElement("div");
      tooltip.className = "account-tooltip";
      tooltip.setAttribute("role", "tooltip");
      tooltip.setAttribute("popover", "manual");
      tooltip.textContent = button.dataset.accountTooltip;
      panel.append(tooltip);
      tooltip.showPopover();
      const anchor = button.getBoundingClientRect();
      const bounds = tooltip.getBoundingClientRect();
      const left = Math.max(12, Math.min(window.innerWidth - bounds.width - 12,
        anchor.left + (anchor.width - bounds.width) / 2));
      const above = anchor.top - bounds.height - 6;
      const top = above >= 12 ? above : Math.max(12,
        Math.min(window.innerHeight - bounds.height - 12, anchor.bottom + 6));
      tooltip.style.left = `${Math.round(left)}px`;
      tooltip.style.top = `${Math.round(top)}px`;
    }, ACCOUNT_TOOLTIP_DELAY_MS);
  }

  function bindDetailPanelResize(wrap) {
    const panel = wrap.querySelector(".detail-popover");
    if (!panel || !state.detailPanelBaseSize) return;
    const resizeEdge = (event) => {
      const bounds = panel.getBoundingClientRect();
      const top = event.clientY >= bounds.top && event.clientY <= bounds.top + 8;
      const right = event.clientX >= bounds.right - 8 && event.clientX <= bounds.right;
      return top && right ? "top-right" : top ? "top" : right ? "right" : null;
    };
    const resizeCursor = (edge) => edge === "top-right"
      ? "nesw-resize"
      : edge === "top" ? "ns-resize" : edge === "right" ? "ew-resize" : "";
    const drag = (event) => {
      const resize = state.detailPanelResize;
      if (!resize) return;
      const next = applyDetailPanelSize(wrap, panel, {
        width: resize.edge.includes("right")
          ? resize.startWidth + event.clientX - resize.startX
          : resize.startWidth,
        height: resize.edge.includes("top")
          ? resize.startHeight + resize.startY - event.clientY
          : resize.startHeight,
      });
      if (next) state.detailPanelSize = next;
      event.preventDefault();
    };
    const finish = (event) => {
      if (!state.detailPanelResize) return;
      cancelDetailPanelResize();
      panel.style.cursor = resizeCursor(resizeEdge(event));
      event.preventDefault();
    };
    panel.addEventListener("mousemove", (event) => {
      if (!state.detailPanelResize) panel.style.cursor = resizeCursor(resizeEdge(event));
    });
    panel.addEventListener("mouseleave", () => {
      if (!state.detailPanelResize) panel.style.cursor = "";
    });
    panel.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      const edge = resizeEdge(event);
      if (!edge) return;
      cancelDetailPanelResize();
      state.detailPanelResize = {
        edge,
        startX: event.clientX,
        startY: event.clientY,
        startWidth: panel.offsetWidth,
        startHeight: panel.offsetHeight,
      };
      window.addEventListener("mousemove", drag, true);
      window.addEventListener("mouseup", finish, true);
      state.detailPanelResizeCleanup = () => {
        window.removeEventListener("mousemove", drag, true);
        window.removeEventListener("mouseup", finish, true);
      };
      event.preventDefault();
      event.stopPropagation();
    });
  }

  function bindEvents(wrap) {
    bindDetailPanelResize(wrap);
    wrap.querySelector(".host-health-recheck")?.addEventListener("click", () => {
      enqueue({ type: "host-health-recheck" });
    });
    wrap.querySelector(".host-health-restart")?.addEventListener("click", (event) => {
      event.currentTarget.disabled = true;
      enqueue({ type: "host-health-restart" });
    });
    wrap.querySelector(".host-health-open-logs")?.addEventListener("click", (event) => {
      event.currentTarget.disabled = true;
      enqueue({ type: "host-health-open-logs" });
    });
    wrap.querySelectorAll("[data-account-tooltip]").forEach((button) => {
      button.addEventListener("pointerenter", () => scheduleAccountTooltip(button));
      button.addEventListener("focus", () => scheduleAccountTooltip(button));
      button.addEventListener("pointerleave", hideAccountTooltip);
      button.addEventListener("blur", hideAccountTooltip);
      button.addEventListener("pointerdown", hideAccountTooltip);
      button.addEventListener("keydown", (event) => {
        if (event.key === "Escape") hideAccountTooltip();
      });
    });
    wrap.querySelector(".panel-scroll")?.addEventListener("scroll", hideAccountTooltip, { passive: true });
    wrap.querySelectorAll(".wakeup-open").forEach((button) => button.addEventListener("click", () => {
      captureDetailPanelBaseSize(wrap);
      state.wakeupDrafts.clear();
      state.page = "wakeup";
      state.pinned = true;
      state.dismissed = false;
      render();
      const scroller = wrap.querySelector(".panel-scroll");
      if (scroller) scroller.scrollTop = 0;
      if (button.dataset.accountId) {
        state.shadow.getElementById(`wakeup-account-${button.dataset.accountId}`)?.scrollIntoView({ block: "nearest" });
      }
    }));
    wrap.querySelector(".wakeup-back")?.addEventListener("click", () => {
      state.page = "accounts";
      resetDetailPanelSize();
      state.wakeupDrafts.clear();
      render();
    });
    wrap.querySelector(".migration-open")?.addEventListener("click", () => {
      captureDetailPanelBaseSize(wrap);
      state.migrationMode = "temporary";
      state.migrationSelectedIds = new Set((state.data.accounts ?? [])
        .filter((account) => account.canTemporaryTransfer)
        .map((account) => account.id));
      state.page = "migration";
      state.pinned = true;
      state.dismissed = false;
      render();
    });
    wrap.querySelector(".migration-back")?.addEventListener("click", () => {
      state.page = "accounts";
      resetDetailPanelSize();
      state.migrationSelectedIds.clear();
      render();
    });
    wrap.querySelectorAll(".migration-mode").forEach((input) => input.addEventListener("change", () => {
      if (!input.checked) return;
      state.migrationMode = input.value === "handoff" ? "handoff" : "temporary";
      const eligibilityField = state.migrationMode === "handoff"
        ? "canTransfer"
        : "canTemporaryTransfer";
      state.migrationSelectedIds = new Set((state.data.accounts ?? [])
        .filter((account) => account[eligibilityField])
        .map((account) => account.id));
      render();
    }));
    wrap.querySelectorAll(".migration-account-checkbox").forEach((input) => input.addEventListener("change", () => {
      if (input.checked) state.migrationSelectedIds.add(input.value);
      else state.migrationSelectedIds.delete(input.value);
      render();
    }));
    wrap.querySelector(".migration-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const accountIds = [...state.migrationSelectedIds];
      if (accountIds.length === 0) return;
      if (state.migrationMode === "handoff") {
        const selected = (state.data.accounts ?? []).filter((account) => accountIds.includes(account.id));
        const includesCurrent = selected.some((account) => account.current);
        const warning = [
          `确认完整转移 ${accountIds.length} 个账号？`,
          "",
          "导出前会主动刷新 Token。生成文件后，本机账号将标记为“已转出”，停止刷新、切换和唤醒。",
          includesCurrent ? "当前账号将被切换或退出登录，Codex 随后会重启。" : "",
          "迁移文件包含明文敏感凭据，请只交给目标设备。",
        ].filter(Boolean).join("\n");
        if (!window.confirm(warning)) return;
      }
      event.currentTarget.querySelector(".migration-submit").disabled = true;
      enqueue({ type: "account-transfer", mode: state.migrationMode, accountIds });
    });
    wrap.querySelectorAll(".wakeup-form").forEach((form) => {
      const accountId = form.dataset.accountId;
      const keepWakeupDraft = () => {
        const draft = readWakeupForm(form);
        state.wakeupDrafts.set(accountId, draft);
        return draft;
      };
      form.addEventListener("input", keepWakeupDraft);
      form.addEventListener("change", keepWakeupDraft);
      form.querySelector(".wakeup-time-add")?.addEventListener("click", () => {
        const draft = keepWakeupDraft();
        draft.times.push("");
        render();
        state.shadow.getElementById(`wakeup-time-${accountId}-${draft.times.length - 1}`)?.focus();
      });
      form.querySelectorAll(".wakeup-time-remove").forEach((button) => button.addEventListener("click", () => {
        const draft = keepWakeupDraft();
        draft.times.splice(Number(button.dataset.timeIndex), 1);
        render();
      }));
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const draft = keepWakeupDraft();
        draft.times = [...new Set(draft.times)].sort();
        enqueue({ type: "wakeup-save", accountId, ...draft });
        render();
      });
    });
    wrap.querySelectorAll(".wakeup-now").forEach((button) => button.addEventListener("click", () => {
      button.disabled = true;
      enqueue({ type: "wakeup-now", accountId: button.dataset.accountId });
    }));
    const chip = wrap.querySelector(".quota-chip");
    chip?.addEventListener("click", () => {
      state.dismissed = false;
      state.pinned = !state.pinned;
      render();
    });
    wrap.querySelector(".close-panel")?.addEventListener("click", () => {
      dismissPanel();
    });
    wrap.querySelector(".context-open")?.addEventListener("click", () => {
      captureDetailPanelBaseSize(wrap);
      state.page = "context";
      state.contextEditingSlug = null;
      state.pinned = true;
      state.dismissed = false;
      render();
    });
    wrap.querySelector(".extra-models-open")?.addEventListener("click", () => {
      captureDetailPanelBaseSize(wrap);
      state.page = "extra-models";
      state.extraPlatformDraft = null;
      state.extraModelOperationDraft = null;
      state.pinned = true;
      state.dismissed = false;
      render();
    });
    wrap.querySelector(".context-back")?.addEventListener("click", () => {
      state.page = "accounts";
      resetDetailPanelSize();
      state.contextEditingSlug = null;
      render();
    });
    wrap.querySelector(".extra-models-back")?.addEventListener("click", () => {
      state.page = "accounts";
      resetDetailPanelSize();
      state.extraPlatformDraft = null;
      state.extraModelOperationDraft = null;
      render();
    });
    bindManagedDeepSeekBalanceButtons(wrap);
    wrap.querySelector(".extra-platform-add")?.addEventListener("click", () => {
      state.extraPlatformDraft = {
        id: "",
        name: "",
        baseUrl: "",
        apiKey: "",
        enabled: true,
        models: [blankExtraModel()],
      };
      render();
    });
    wrap.querySelectorAll(".extra-platform-edit").forEach((button) => button.addEventListener("click", () => {
      const platform = state.data.extraModels?.platforms?.find((item) => item.id === button.dataset.platformId);
      if (!platform) return;
      state.extraPlatformDraft = {
        ...platform,
        models: platform.models.map((model) => ({
          ...model,
          compatibility: model.compatibility ? { ...model.compatibility } : { status: "pending" },
        })),
      };
      render();
    }));
    wrap.querySelectorAll(".extra-platform-detect").forEach((button) => button.addEventListener("click", () => {
      button.disabled = true;
      enqueue({ type: "extra-platform-detect", platformId: button.dataset.platformId });
      showExtraModelOperation({
        message: "正在准备模型能力检测",
        platformId: button.dataset.platformId,
        phase: "detecting",
      });
    }));
    const extraPlatformForm = wrap.querySelector(".extra-platform-form");
    wrap.querySelector(".preset-model-refresh")?.addEventListener("click", (event) => {
      const platform = readExtraPlatformForm(extraPlatformForm);
      state.extraPlatformDraft = platform;
      event.currentTarget.disabled = true;
      enqueue({ type: "extra-platform-models-refresh", platform });
      showExtraModelOperation({
        message: "正在读取 DeepSeek 可用模型",
        platformId: platform.id,
        phase: "models",
      });
    });
    extraPlatformForm?.addEventListener("input", () => {
      state.extraPlatformDraft = readExtraPlatformForm(extraPlatformForm);
    });
    extraPlatformForm?.addEventListener("change", (event) => {
      const draft = readExtraPlatformForm(extraPlatformForm);
      if (event.target?.name === "presetModel") {
        state.extraPlatformDraft = draft;
        const selectedCount = draft.models.filter((model) => model.selected !== false).length;
        const count = extraPlatformForm.querySelector(".preset-model-count");
        if (count) count.textContent = `已选 ${selectedCount} / ${draft.models.length}`;
        return;
      }
      state.extraPlatformDraft = draft;
    });
    wrap.querySelector(".extra-model-add")?.addEventListener("click", () => {
      const draft = readExtraPlatformForm(extraPlatformForm);
      draft.models.push(blankExtraModel());
      state.extraPlatformDraft = draft;
      render();
    });
    wrap.querySelectorAll(".extra-model-remove").forEach((button) => button.addEventListener("click", () => {
      const draft = readExtraPlatformForm(extraPlatformForm);
      const index = Number(button.closest(".extra-model-row")?.dataset.modelIndex);
      if (Number.isInteger(index) && draft.models.length > 1) draft.models.splice(index, 1);
      state.extraPlatformDraft = draft;
      render();
    }));
    wrap.querySelector(".extra-platform-cancel")?.addEventListener("click", () => {
      state.extraModelOperationDraft = null;
      state.extraPlatformDraft = null;
      render();
    });
    extraPlatformForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      const platform = readExtraPlatformForm(event.currentTarget);
      state.extraPlatformDraft = platform;
      enqueue({ type: "extra-platform-save", platform });
      event.currentTarget.querySelector('button[type="submit"]')?.setAttribute("disabled", "");
      showExtraModelOperation({
        message: platform.enabled ? "正在准备模型能力检测" : "正在保存停用配置",
        platformId: platform.id,
        phase: platform.enabled ? "detecting" : "saving",
      });
    });
    wrap.querySelector(".extra-platform-remove")?.addEventListener("click", () => {
      const platform = readExtraPlatformForm(extraPlatformForm);
      if (!window.confirm(`确定删除 ${platform.name || "该平台"}、其全部模型和本地 API Key？删除结果将在重启 Codex 后生效。`)) return;
      enqueue({ type: "extra-platform-remove", platformId: platform.id });
    });
    wrap.querySelector(".context-refresh")?.addEventListener("click", () => enqueue({ type: "context-refresh" }));
    wrap.querySelector(".context-reset-all")?.addEventListener("click", () => {
      state.contextEditingSlug = null;
      enqueue({ type: "context-reset-all" });
    });
    wrap.querySelectorAll(".context-edit-open").forEach((button) => button.addEventListener("click", () => {
      const form = button.closest(".model-card")?.querySelector(".context-edit-form");
      const open = Boolean(form?.hidden);
      state.contextEditingSlug = open ? button.dataset.slug : null;
      setContextEditorOpen(form, open);
    }));
    wrap.querySelectorAll(".context-edit-cancel").forEach((button) => button.addEventListener("click", () => {
      const form = button.closest(".context-edit-form");
      state.contextEditingSlug = null;
      setContextEditorOpen(form, false);
    }));
    wrap.querySelectorAll(".context-reset").forEach((button) => button.addEventListener("click", (event) => {
      const form = event.currentTarget.closest(".context-edit-form");
      state.contextEditingSlug = null;
      setContextEditorOpen(form, false);
      enqueue({ type: "context-reset", slug: form?.dataset.slug });
    }));
    wrap.querySelectorAll(".context-edit-form").forEach((form) => form.addEventListener("submit", (event) => {
      event.preventDefault();
      const fields = new FormData(event.currentTarget);
      const contextWindow = Number(fields.get("contextWindow"));
      const currentMaxContextWindow = Number(event.currentTarget.dataset.maxContextWindow);
      const enteredMaxContextWindow = Number(fields.get("maxContextWindow"));
      const maxFieldChanged = enteredMaxContextWindow !== currentMaxContextWindow;
      const maxContextWindow = maxFieldChanged
        ? enteredMaxContextWindow
        : Math.max(currentMaxContextWindow || contextWindow, contextWindow);
      state.contextEditingSlug = null;
      setContextEditorOpen(event.currentTarget, false);
      enqueue({
        type: "context-save",
        slug: event.currentTarget.dataset.slug,
        contextWindow,
        maxContextWindow,
      });
    }));
    wrap.querySelectorAll(".switch-account").forEach((button) => button.addEventListener("click", () => enqueue({ type: "switch-account", accountId: button.dataset.accountId })));
    wrap.querySelectorAll(".restore-transferred").forEach((button) => button.addEventListener("click", () => {
      const email = button.dataset.accountEmail || "该账号";
      const apiKey = button.dataset.authMode === "apiKey";
      const warning = apiKey
        ? `确认恢复 ${email} 在本机的使用？\n\n恢复后，本机与新设备可能同时使用同一 API Key 并分别产生费用。请确认新设备已经停止使用。`
        : `确认恢复 ${email} 在本机的使用？\n\n仅在迁移文件尚未导入，或新设备已经停止使用时恢复。恢复会刷新本机保留的 refresh token，可能使新设备登录失效；如果 Token 已被新设备轮换，本机将需要重新 OAuth。`;
      if (!window.confirm(warning)) return;
      button.disabled = true;
      enqueue({ type: "restore-transferred", accountId: button.dataset.accountId });
    }));
    wrap.querySelectorAll(".remove-account").forEach((button) => button.addEventListener("click", () => {
      const email = button.dataset.accountEmail || "该账号";
      if (!window.confirm(`确定移除 ${email}？\n\n将删除本工具保存的账号凭据，不会注销 OpenAI 账号。`)) return;
      button.disabled = true;
      enqueue({ type: "remove-account", accountId: button.dataset.accountId });
    }));
    wrap.querySelector(".oauth-add")?.addEventListener("click", () => enqueue({ type: "oauth-add" }));
    wrap.querySelector(".oauth-cancel")?.addEventListener("click", () => enqueue({ type: "oauth-cancel" }));
    wrap.querySelector(".local-import")?.addEventListener("click", () => enqueue({ type: "local-import" }));
    wrap.querySelector(".refresh-all")?.addEventListener("click", () => enqueue({ type: "refresh-all" }));
    wrap.querySelector(".token-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      enqueue({ type: "token-add", token: String(form.get("token") ?? "") });
    });
    wrap.querySelector(".api-key-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      enqueue({ type: "api-key-add", name: String(form.get("name") ?? ""), apiKey: String(form.get("apiKey") ?? "") });
    });
  }

  function setContextEditorOpen(form, open) {
    if (!form) return;
    form.hidden = !open;
    const button = form.closest(".model-card")?.querySelector(".context-edit-open");
    if (button) button.textContent = open ? "收起" : "修改";
  }

  function enqueue(action) {
    state.actions.push({ ...action, id: `${Date.now()}-${Math.random().toString(16).slice(2)}` });
    state.dismissed = false;
    state.pinned = true;
  }

  function dismissPanel() {
    hideAccountTooltip();
    state.pinned = false;
    state.dismissed = true;
    state.page = "accounts";
    resetDetailPanelSize();
    state.migrationSelectedIds.clear();
    state.wakeupDrafts.clear();
    state.contextEditingSlug = null;
    state.extraPlatformDraft = null;
    state.extraModelOperationDraft = null;
    const wrap = state.shadow?.querySelector(".quota-wrap");
    wrap?.classList.remove("is-open");
    wrap?.classList.add("is-dismissed");
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

  const conversationTurnSelector = "[data-content-search-turn-key]";
  function findConversationObserverRoot() {
    const firstTurn = document.querySelector(conversationTurnSelector);
    if (!firstTurn) return null;
    let candidate = firstTurn.parentElement;
    while (candidate && candidate !== document.body) {
      if (candidate.querySelectorAll(conversationTurnSelector).length > 1) return candidate;
      candidate = candidate.parentElement;
    }
    return firstTurn.parentElement;
  }

  function bindConversationObserver() {
    if (state.conversationObserverRoot?.isConnected) return;
    const root = findConversationObserverRoot();
    if (root === state.conversationObserverRoot) return;
    state.observer?.disconnect();
    state.conversationObserverRoot = root;
    if (root) {
      state.observer?.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-content-search-turn-key"],
      });
    }
  }

  function mutationTouchesConversation(mutations) {
    return mutations.some((mutation) => {
      if (mutation.type === "attributes" &&
        mutation.attributeName === "data-content-search-turn-key") return true;
      const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes]
        .filter((node) => node.nodeType === Node.ELEMENT_NODE);
      if (changedNodes.length > 0 && changedNodes.every((node) =>
        node.matches?.("[data-codex-token-usage], [data-codex-token-usage-footer]"))) {
        return false;
      }
      const target = mutation.target;
      if (target?.closest?.("[data-codex-token-usage], [data-codex-token-usage-footer]")) return false;
      const turnTarget = target?.closest?.(conversationTurnSelector);
      if (turnTarget) {
        const turnId = turnTarget.getAttribute("data-content-search-turn-key");
        return !state.conversationUsageLines.get(turnId)?.isConnected;
      }
      return changedNodes.some((node) =>
        node.matches?.(conversationTurnSelector) ||
        node.querySelector?.(conversationTurnSelector));
    });
  }

  state.observer = new MutationObserver((mutations) => {
    if (mutationTouchesConversation(mutations)) {
      state.conversationDomDirty = true;
      scheduleConversationTokenUsageRender();
    }
  });
  state.mountObserver = new MutationObserver((mutations) => {
    if (mutationTouchesConversation(mutations)) {
      state.conversationDomDirty = true;
      scheduleConversationTokenUsageRender();
    }
    if (state.mountCheckFrame != null) return;
    state.mountCheckFrame = window.requestAnimationFrame(() => {
      state.mountCheckFrame = null;
      if (!state.root?.isConnected) ensureMounted();
      const firstTurn = document.querySelector(conversationTurnSelector);
      if (firstTurn && state.conversationObserverRoot?.isConnected &&
        !state.conversationObserverRoot.contains(firstTurn)) {
        state.observer?.disconnect();
        state.conversationObserverRoot = null;
        state.conversationDomDirty = true;
      }
      if (!state.conversationObserverRoot?.isConnected) {
        state.conversationDomDirty = true;
        scheduleConversationTokenUsageRender();
      }
    });
  });
  state.mountObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-content-search-turn-key"],
  });
  // Theme changes need no data revision and must not rebuild an active form.
  const themeQuery = window.matchMedia?.("(prefers-color-scheme: light)");
  const syncTheme = () => ensureMounted();
  const themeObserver = new MutationObserver(syncTheme);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  themeQuery?.addEventListener("change", syncTheme);
  state.resizeHandler = () => {
    hideAccountTooltip();
    const wrap = state.shadow?.querySelector(".quota-wrap");
    if (wrap) positionPopover(wrap);
    if (state.conversationTooltipTarget) {
      positionConversationTokenTooltip(state.conversationTooltipTarget);
    }
  };
  state.documentPointerHandler = (event) => {
    if (state.root && event.composedPath().includes(state.root)) return;
    if (state.conversationTooltip && event.composedPath().includes(state.conversationTooltip)) return;
    if (state.conversationTooltipBridge && event.composedPath().includes(state.conversationTooltipBridge)) return;
    dismissPanel();
  };
  window.addEventListener("resize", state.resizeHandler);
  document.addEventListener("pointerdown", state.documentPointerHandler, true);
  ensureMounted();

  window[GLOBAL_KEY] = {
    version: VERSION,
    update(data, revision = null) {
      const json = revision == null ? JSON.stringify(data ?? {}) : `revision:${revision}`;
      if (revision != null && revision === state.dataRevision) return;
      if (json === state.dataJson) return;
      const patchOpenExtraModelsPage = state.page === "extra-models" &&
        Boolean(state.shadow?.querySelector(".extra-models-popover"));
      state.dataJson = json;
      state.dataRevision = revision;
      state.tokenUsageRevision = revision;
      applyExtraModelDiscovery(data?.extraModels);
      state.data = data ?? state.data;
      ensureMounted();
      if (patchOpenExtraModelsPage) {
        patchExtraModelsDom(data?.extraModels, { clearDraftOperation: true });
        scheduleConversationTokenUsageRender();
        return;
      }
      render();
    },
    updateExtraModels(extraModels, revision = null) {
      if (revision != null && revision === state.dataRevision) return;
      state.dataRevision = revision;
      ensureMounted();
      patchExtraModelsDom(extraModels, { clearDraftOperation: true });
    },
    updateTokenUsage(tokenUsage, revision = null) {
      if (revision != null && revision === state.tokenUsageRevision) return;
      state.tokenUsageRevision = revision;
      state.data = { ...state.data, tokenUsage: tokenUsage ?? { status: "ready", turns: [] } };
      ensureMounted();
      scheduleConversationTokenUsageRender();
    },
    updateTokenUsageDelta(delta, revision = null) {
      if (revision != null && revision === state.tokenUsageRevision) return;
      const current = state.data.tokenUsage ?? { status: "ready", turns: [] };
      const turnsById = new Map(
        (Array.isArray(current.turns) ? current.turns : [])
          .map((turn) => [String(turn?.turnId ?? ""), turn])
          .filter(([turnId]) => turnId),
      );
      for (const turnId of Array.isArray(delta?.removedTurnIds) ? delta.removedTurnIds : []) {
        turnsById.delete(String(turnId));
      }
      for (const turn of Array.isArray(delta?.updates) ? delta.updates : []) {
        const turnId = String(turn?.turnId ?? "");
        if (turnId) turnsById.set(turnId, turn);
      }
      const nextTokenUsage = {
        ...current,
        status: delta?.status ?? current.status,
        error: Object.prototype.hasOwnProperty.call(delta ?? {}, "error")
          ? delta.error
          : current.error,
        turns: [...turnsById.values()].sort((left, right) =>
          Number(left?.updatedAt) - Number(right?.updatedAt)),
      };
      state.tokenUsageRevision = revision;
      state.data = { ...state.data, tokenUsage: nextTokenUsage };
      ensureMounted();
      scheduleConversationTokenUsageRender();
    },
    drainActions() {
      return state.actions.splice(0);
    },
    destroy() {
      themeObserver.disconnect();
      themeQuery?.removeEventListener("change", syncTheme);
      hideAccountTooltip();
      state.observer?.disconnect();
      state.observer = null;
      state.mountObserver?.disconnect();
      state.mountObserver = null;
      if (state.mountCheckFrame != null) {
        window.cancelAnimationFrame(state.mountCheckFrame);
        state.mountCheckFrame = null;
      }
      clearConversationTooltipTimer();
      if (state.conversationRenderFrame != null) {
        window.cancelAnimationFrame(state.conversationRenderFrame);
        state.conversationRenderFrame = null;
      }
      window.removeEventListener("resize", state.resizeHandler);
      document.removeEventListener("pointerdown", state.documentPointerHandler, true);
      document.querySelectorAll("[data-codex-token-usage], [data-codex-token-usage-footer]")
        .forEach((node) => node.remove());
      state.conversationTooltip?.remove();
      state.conversationTooltipBridge?.remove();
      state.conversationTooltip = null;
      state.conversationTooltipBridge = null;
      state.conversationTooltipTimer = null;
      state.conversationTooltipPendingLine = null;
      state.conversationTooltipPendingPointer = null;
      state.conversationTooltipTarget = null;
      state.conversationTooltipPointer = null;
      state.conversationTurnNodes.clear();
      state.conversationUsageLines.clear();
      state.conversationObserverRoot = null;
      document.getElementById(GLOBAL_STYLE_ID)?.remove();
      state.root?.remove();
      delete window[GLOBAL_KEY];
    },
  };
  return VERSION;
}

export function widgetInstallExpression() {
  return `(${installQuotaWidget.toString()})(${calculatePopoverMaxHeight.toString()},${WIDGET_RUNTIME_VERSION},${paginateGenerationDetails.toString()},${formatGenerationDetailTitle.toString()},${formatGenerationPhaseText.toString()},${formatGenerationPrimaryText.toString()},${formatConversationUsageSummary.toString()},${selectConversationNetworkLatency.toString()},${formatNetworkLatencyText.toString()},${averageGenerationNetworkLatency.toString()},${generationToolRows.toString()},${createGenerationToolRow.toString()},${generationExecutionRemainder.toString()},${calculateScrollbarEndPadding.toString()})`;
}

export function widgetRuntimeVersionExpression() {
  return "window.__codexQuotaWidget?.version ?? null";
}

export function widgetUpdateExpression(data) {
  return `window.__codexQuotaWidget?.update(${JSON.stringify(data)})`;
}

export function widgetUpdateExpressionJson(serializedData, revision = null) {
  const revisionArgument = revision == null ? "" : `,${JSON.stringify(revision)}`;
  return `window.__codexQuotaWidget?.update(${String(serializedData)}${revisionArgument})`;
}

export function widgetTokenUsageUpdateExpressionJson(serializedTokenUsage, revision = null) {
  const revisionArgument = revision == null ? "" : `,${JSON.stringify(revision)}`;
  return `window.__codexQuotaWidget?.updateTokenUsage(${String(serializedTokenUsage)}${revisionArgument})`;
}

export function widgetExtraModelsUpdateExpressionJson(serializedExtraModels, revision = null) {
  const revisionArgument = revision == null ? "" : `,${JSON.stringify(revision)}`;
  return `window.__codexQuotaWidget?.updateExtraModels(${String(serializedExtraModels)}${revisionArgument})`;
}

export function widgetTokenUsageDeltaUpdateExpressionJson(serializedDelta, revision = null) {
  const revisionArgument = revision == null ? "" : `,${JSON.stringify(revision)}`;
  return `window.__codexQuotaWidget?.updateTokenUsageDelta(${String(serializedDelta)}${revisionArgument})`;
}

export function widgetDrainActionsExpression() {
  return "window.__codexQuotaWidget?.drainActions?.() ?? []";
}
