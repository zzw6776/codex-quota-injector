// Browser-serializable factory: all external values arrive through this explicit boundary.
function createHostHealth({ state, formatUpdatedAt, escapeHtml }) {
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

  return { renderHostHealthBanner, renderPanelControls };
}

export { createHostHealth };
