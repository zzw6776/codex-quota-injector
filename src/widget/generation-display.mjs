import { formatNetworkLatencyText } from "./usage-display.mjs";

function paginateGenerationDetails(details, visibleCount = 20) {
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

function formatGenerationDetailTitle(detail, isLatestCompleted = false) {
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

function formatGenerationPhaseText(detail) {
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

function generationToolRows(detail) {
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

function generationExecutionRemainder(detail) {
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

function formatGenerationPrimaryText(
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

function averageGenerationNetworkLatency(details) {
  const values = (Array.isArray(details) ? details : [])
    .map((detail) => detail?.networkLatency?.latencyMs)
    .filter((value) => value != null && Number.isFinite(Number(value)) && Number(value) >= 0)
    .map(Number);
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function createGenerationToolRow(document, call, formatDuration) {
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


export { createGenerationToolRow, paginateGenerationDetails, formatGenerationDetailTitle, formatGenerationPhaseText, generationToolRows, generationExecutionRemainder, formatGenerationPrimaryText, averageGenerationNetworkLatency };
