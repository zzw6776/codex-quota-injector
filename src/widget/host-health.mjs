// Browser-serializable factory: all external values arrive through this explicit boundary.
function createHostHealth({ state, formatUpdatedAt, escapeHtml }) {
  function presentation(health) {
    const checks = Object.values(health?.checks ?? {});
    const legacyUnknown = ["status-query-failed", "startup-status-timeout", "health-check-failed",
      "health-state-missing", "required-tool-unverified", "codex-app-reload-failed"].includes(health?.code);
    const status = legacyUnknown ? "unconfirmed" : health?.status ?? "unconfirmed";
    const titles = {
      idle: "选择本机任务后自动检查任务工具",
      starting: checks.length ? health.message : "正在连接任务工具",
      ready: health?.verification === "calls" ? health.message : "工具目录已核验",
      unconfirmed: health?.code === "health-runtime-outdated" ? "检查服务待更新" : "任务工具状态待确认",
      degraded: ["relay-not-current", "relay-disconnected"].includes(health?.code)
        ? "任务工具连接已断开" : "任务工具检查异常",
      direct: "官方直连",
    };
    return { status, title: titles[status] ?? "任务工具状态待确认", checks };
  }

  function expanded(health) {
    return state.hostHealthDetailsThread === (health?.threadId ?? "global");
  }

  function renderHostHealthBanner(health) {
    if (!health?.required) return "";
    const view = presentation(health);
    const open = expanded(health);
    // Routine connection/check progress belongs in the flyout, not the account panel.
    if (!["degraded", "unconfirmed"].includes(view.status)) return "";
    const checking = view.checks.some(check => check.status === "checking");
    const recheck = health.canCheck && health.threadId
      ? `<button class="btn host-health-recheck" type="button" title="实际调用当前任务的 4 项必需工具，确认是否可用" ${checking ? "disabled" : ""}>${checking ? "检查中…" : "重新检查"}</button>` : "";
    const message = view.status === "unconfirmed" && health.code === "startup-status-timeout"
      ? "等待工具服务就绪超时，暂时无法确认状态。" : health.message;
    return `<aside class="host-health-banner ${view.status}" role="${view.status === "degraded" ? "alert" : "status"}" aria-live="polite">
      <div class="host-health-title">${escapeHtml(view.title)}</div>
      ${message && message !== view.title ? `<div>${escapeHtml(message)}</div>` : ""}
      ${view.status === "unconfirmed" ? '<div>尚未确认不代表工具不可用。</div>' : ""}
      ${health.actionError ? `<div class="host-health-detail">操作未完成：${escapeHtml(health.actionError)}</div>` : ""}
      <div class="host-health-actions">${recheck}
        <button class="btn host-health-details" type="button" aria-expanded="${open}">查看详情</button>
      </div>
    </aside>`;
  }

  function renderHostHealthFlyout(health) {
    if (!expanded(health)) return "";
    const view = presentation(health);
    const checking = view.checks.some(check => check.status === "checking");
    const message = view.status === "unconfirmed" && health?.code === "startup-status-timeout"
      ? "等待工具服务就绪超时，暂时无法确认状态。" : health?.message;
    return `<aside class="host-health-flyout ${view.status}" popover="manual" role="dialog" aria-label="任务工具检查详情">
      <header class="host-health-flyout-head">
        <div><div class="host-health-title"><span class="host-health-dot ${view.status}" aria-hidden="true"></span>任务工具</div>
          <div class="host-health-flyout-summary">${escapeHtml(view.title)}</div>
          ${message && message !== view.title ? `<div class="host-health-flyout-message">${escapeHtml(message)}</div>` : ""}</div>
        <button class="icon-btn host-health-flyout-close" type="button" aria-label="关闭任务工具检查详情"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="m5 5 14 14M19 5 5 19"/></svg></button>
      </header>
      <div class="host-health-flyout-scroll">
        ${view.status === "unconfirmed" ? '<div>尚未确认不代表工具不可用。</div>' : ""}
        ${health?.actionError ? `<div class="host-health-detail">操作未完成：${escapeHtml(health.actionError)}</div>` : ""}
        ${renderDetails(health)}
        <div class="host-health-actions host-health-action-grid">
          ${health?.canCheck && health?.threadId ? `<button class="btn host-health-recheck" type="button" title="实际调用当前任务的 4 项必需工具，确认是否可用" ${checking ? "disabled" : ""}>${checking ? "检查中…" : "重新检查"}</button>` : ""}
          ${health?.canCheck ? `<button class="btn host-health-diagnose" type="button" title="查询完整注册目录，用于诊断工具缺失或加载异常；可能耗时较长" ${health?.diagnostic?.status === "checking" ? "disabled" : ""}>诊断工具目录</button>` : ""}
          ${health?.canCheck ? '<button class="btn host-health-reload" type="button" title="重新读取工具配置并刷新已加载任务的连接，可能影响其他任务">刷新工具配置</button>' : ""}
          ${health?.canRestart ? '<button class="btn host-health-restart" type="button" title="退出并重新启动整个 Codex 应用">重启 Codex</button>' : ""}
        </div>
        <footer class="host-health-flyout-footer">
          <span>${health?.updatedAt ? `更新于 ${escapeHtml(formatUpdatedAt(health.updatedAt))}` : "尚无更新时间"}</span>
          ${health?.canOpenLogs ? '<button class="host-health-open-logs" type="button">诊断日志 ↗</button>' : ""}
        </footer>
      </div>
    </aside>`;
  }

  function renderDetails(health = {}) {
    const labels = { passed: "通过", checking: "检查中", failed: "异常", unconfirmed: "未确认" };
    const rows = (health.requiredTools ?? []).map(tool => {
      const check = health.checks?.[tool];
      const checkedAt = check?.checkedAt ? ` title="检查时间：${escapeHtml(formatUpdatedAt(check.checkedAt))}"` : "";
      const status = Object.hasOwn(labels, check?.status) ? check.status : "unknown";
      return `<li><div class="host-health-check-row"${checkedAt}><span>${escapeHtml(hostToolLabel(tool))}</span><span class="host-health-check-status ${status}">${labels[status] ?? "尚未检查"}</span></div>
        ${check?.detail ? `<div class="host-health-detail">${escapeHtml(check.detail)}</div>` : ""}</li>`;
    }).join("");
    const diagnostic = health.diagnostic;
    const diagnosticMessage = diagnostic?.status === "checking" ? "正在查询完整工具目录…"
      : diagnostic?.detail ?? diagnostic?.catalog?.message;
    return `<div class="host-health-details-content">
      <ul class="host-health-checks">${rows}</ul>
      ${health.detail ? `<div class="host-health-detail">${escapeHtml(health.detail)}</div>` : ""}
      ${diagnosticMessage ? `<div class="host-health-detail">目录诊断：${escapeHtml(diagnosticMessage)}</div>` : ""}
    </div>`;
  }

  function renderPanelControls(health = state.data.hostHealth) {
    const view = presentation(health);
    const details = [view.title];
    if (health?.updatedAt) details.push(`状态更新：${formatUpdatedAt(health.updatedAt)}`);
    details.push("点击查看逐项检查结果");
    const text = escapeHtml(details.join("\n"));
    const turnState = state.data.turnState ?? {};
    const byteLength = Number.isInteger(turnState.byteLength) && turnState.byteLength >= 0
      ? turnState.byteLength : null;
    const turnStateLabel = byteLength === null ? "--" : String(byteLength);
    const turnStateDetails = byteLength === null
      ? "尚未观察到当前任务的 x-codex-turn-state"
      : `x-codex-turn-state：${byteLength} 字节`;
    const turnStateMeta = [turnState.model,
      turnState.observedAt ? `观察时间：${formatUpdatedAt(turnState.observedAt)}` : null]
      .filter(Boolean).join("\n");
    const turnStateText = escapeHtml(`${turnStateDetails}${turnStateMeta ? `\n${turnStateMeta}` : ""}`);
    return `<div class="panel-controls"><span class="turn-state-status" data-account-tooltip="${turnStateText}" aria-label="${turnStateText}">${escapeHtml(turnStateLabel)}</span><button class="host-health-status status-${view.status}" type="button" data-account-tooltip="${text}" aria-label="${text}"><span class="host-health-dot ${view.status}" aria-hidden="true"></span></button><button class="icon-btn close-panel" type="button" aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="m5 5 14 14M19 5 5 19"/></svg></button></div>`;
  }

  function hostToolLabel(name) {
    return {
      list_threads: "查看任务列表", read_thread: "读取任务内容",
      list_projects: "查看项目列表", get_usage_limits: "查看用量额度",
    }[name] ?? String(name);
  }

  return { renderHostHealthBanner, renderHostHealthFlyout, renderPanelControls, presentation };
}

export { createHostHealth };
