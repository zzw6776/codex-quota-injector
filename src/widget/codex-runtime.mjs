// Browser-serializable factory: all external values arrive through this explicit boundary.
function createCodexRuntime({
  state,
  render,
  renderPanelControls,
  captureDetailPanelBaseSize,
  resetDetailPanelSize,
  enqueue,
  formatUpdatedAt,
  escapeHtml,
}) {
  function runtimeLabel(runtime) {
    if (!runtime) return "尚未确认";
    if (runtime.mode === "bundled") return `桌面内置 ${runtime.version}`;
    if (runtime.mode === "alpha") return `官方 Alpha ${runtime.version}`;
    if (runtime.mode === "custom") return `自定义 ${runtime.version}`;
    return runtime.version ?? "未知版本";
  }

  function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes <= 0) return "";
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  }

  function renderCodexRuntimePage() {
    const runtime = state.data.codexRuntime ?? {};
    const supported = runtime.supported !== false;
    const installed = Array.isArray(runtime.installed) ? runtime.installed : [];
    const busy = ["checking", "downloading", "verifying"].includes(runtime.status);
    const selectedValue = runtime.mode === "alpha" && runtime.selected?.version
      ? `alpha:${runtime.selected.version}`
      : runtime.mode === "custom" ? "custom" : "bundled";
    const options = [
      `<option value="bundled" ${selectedValue === "bundled" ? "selected" : ""}>桌面内置${runtime.bundled?.version ? ` · ${escapeHtml(runtime.bundled.version)}` : ""}</option>`,
      ...installed.map((item) => `<option value="alpha:${escapeHtml(item.version)}" ${selectedValue === `alpha:${item.version}` ? "selected" : ""}>官方 Alpha · ${escapeHtml(item.version)}</option>`),
      `<option value="custom" ${selectedValue === "custom" ? "selected" : ""}>自定义可执行文件</option>`,
    ].join("");
    const operation = runtime.operation;
    const progress = operation?.type === "install"
      ? Math.max(0, Math.min(100, Math.round(
          Number(operation.total) > 0 ? Number(operation.received) / Number(operation.total) * 100 : 0,
        )))
      : null;
    const operationHtml = operation?.type === "install"
      ? `<div class="operation codex-runtime-progress" role="status"><div><span>正在下载并校验</span><span>${progress}% · ${escapeHtml(formatBytes(operation.received))} / ${escapeHtml(formatBytes(operation.total))}</span></div><span class="extra-model-progress-track" aria-hidden="true"><i style="width:${progress}%"></i></span></div>`
      : operation?.type === "check"
        ? '<div class="operation" role="status">正在检查 OpenAI 官方发布…</div>'
        : operation?.type === "verify"
          ? '<div class="operation" role="status">正在验证版本与 app-server 握手…</div>'
          : "";
    const latest = runtime.latest;
    const latestSelected = runtime.mode === "alpha" &&
      runtime.selected?.version === latest?.version;
    const latestInstalled = installed.some((item) => item.version === latest?.version);
    const latestText = latest
      ? `${escapeHtml(latest.version)}${latest.publishedAt ? ` · ${escapeHtml(formatUpdatedAt(latest.publishedAt))}` : ""} · ${escapeHtml(formatBytes(latest.size))}`
      : "尚未取得远端版本";
    const fallback = runtime.fallback
      ? `<div class="quota-error">${escapeHtml(runtime.error ?? "所选后端不可用，已自动回退")}</div>`
      : runtime.error ? `<div class="quota-error">${escapeHtml(runtime.error)}</div>` : "";
    const bundledUpdate = runtime.bundledUpdate;
    const bundledUpdateHtml = bundledUpdate
      ? `<div class="provider-warning">桌面内置 CLI 已从 ${escapeHtml(bundledUpdate.previousVersion)} 更新到 ${escapeHtml(bundledUpdate.currentVersion)}；${bundledUpdate.status === "fallback"
          ? `原后端验证失败，当前已回退到 ${escapeHtml(bundledUpdate.selectedVersion)}`
          : `已重新验证，仍使用 ${escapeHtml(bundledUpdate.selectedVersion)}`}。</div>`
      : "";
    const customPath = runtime.mode === "custom"
      ? runtime.selected?.executable ?? runtime.customPath ?? ""
      : runtime.customPath ?? "";
    const activeBadge = runtime.pendingRestart
      ? '<span class="badge pending-restart">等待重启生效</span>'
      : runtime.active
        ? '<span class="badge current">当前运行</span>'
        : '<span class="badge">尚未确认运行版本</span>';
    const sharing = runtime.mcpConnectionSharing ?? {};
    const sharingDisabled = busy || (!sharing.compatible && !sharing.enabled);
    const sharingStatus = runtime.pendingRestart
      ? sharing.selected
        ? "重启后启用"
        : sharing.active ? "重启后关闭" : "重启后保持关闭"
      : sharing.active ? "当前已启用" : sharing.selected ? "下次启动时启用" : "当前关闭";
    const sharingNote = sharing.compatible
      ? "开启前会用隔离配置验证功能；仅在开关开启时，才向 app-server 注入 features.mcp_connection_sharing=true。它只尝试复用符合官方共享条件的本地 stdio MCP，其他 MCP 不受影响。"
      : "所选后端不兼容；需要 Codex 0.166.0-alpha.1 或更高版本，当前不会注入该配置。";
    return `
      <header class="panel-head"><div class="panel-title-wrap"><button class="icon-btn codex-runtime-back" type="button" aria-label="返回账号额度">←</button><div><div class="panel-title">Codex 后端</div><div class="panel-subtitle">CLI 与 app-server 运行时</div></div></div>${renderPanelControls()}</header>
      <section class="provider-summary codex-runtime-summary">
        <div class="provider-status"><span class="${runtime.fallback ? "disabled" : "enabled"}">${escapeHtml(runtimeLabel(runtime.active))}</span>${activeBadge}</div>
        <div class="provider-note">已选择：${escapeHtml(runtimeLabel(runtime.selected))}。受管版本只替换桌面端调用的 Codex CLI/app-server，不修改 Codex.app；切换后需由你重启 Codex 才会生效。</div>
        ${bundledUpdateHtml}
      </section>
      ${supported ? `<form class="provider-form codex-runtime-form">
        <div class="provider-field"><label for="codex-runtime-source">后端来源</label><select id="codex-runtime-source" name="source" ${busy ? "disabled" : ""}>${options}</select></div>
        <div class="provider-field codex-runtime-custom" ${selectedValue === "custom" ? "" : "hidden"}><label for="codex-runtime-path">自定义 Codex CLI 绝对路径</label><input id="codex-runtime-path" name="path" value="${escapeHtml(customPath)}" placeholder="/absolute/path/to/codex" ${busy ? "disabled" : ""}></div>
        <div class="provider-warning">保存前会验证 <code>--version</code> 和 app-server 初始化握手；不会发送模型请求。</div>
        <div class="provider-actions"><button class="btn primary" type="submit" ${busy ? "disabled" : ""}>验证并选择</button></div>
      </form>
      <section class="codex-runtime-feature">
        <div class="codex-runtime-feature-head"><label class="provider-toggle"><input class="codex-runtime-mcp-sharing" type="checkbox" ${sharing.enabled ? "checked" : ""} ${sharingDisabled ? "disabled" : ""}>实验性 MCP 连接共享</label><span class="badge ${sharing.active ? "current" : ""}">${escapeHtml(sharingStatus)}</span></div>
        <div class="provider-note">${escapeHtml(sharingNote)}</div>
      </section>
      <section class="codex-runtime-release">
        <div class="codex-runtime-release-head"><div><strong>OpenAI 最新 Alpha</strong><div>${latestText}</div></div><div class="provider-actions"><button class="btn codex-runtime-check" type="button" ${busy ? "disabled" : ""}>检查更新</button><button class="btn primary codex-runtime-install" type="button" ${busy || !latest || latestSelected ? "disabled" : ""}>${latestSelected ? "已选择" : latestInstalled ? "选择此版本" : "下载并选择"}</button></div></div>
        <div class="provider-note">下载只接受 OpenAI GitHub Release 的当前架构资产，并校验声明大小、SHA-256、Mach-O 架构、版本及 app-server 握手。已安装旧版保留在下拉框中，可随时回滚。</div>
      </section>
      ${operationHtml}
      ${runtime.message ? `<div class="operation success">${escapeHtml(runtime.message)}</div>` : ""}
      ${fallback}` : '<div class="quota-error">受管 Codex 后端当前仅支持 macOS arm64/x64。</div>'}`;
  }

  function bindCodexRuntimeEvents(wrap) {
    wrap.querySelector(".codex-runtime-open")?.addEventListener("click", () => {
      captureDetailPanelBaseSize(wrap);
      state.page = "codex-runtime";
      state.pinned = true;
      state.dismissed = false;
      render();
    });
    wrap.querySelector(".codex-runtime-back")?.addEventListener("click", () => {
      state.page = "accounts";
      resetDetailPanelSize();
      render();
    });
    const form = wrap.querySelector(".codex-runtime-form");
    const source = form?.elements.source;
    source?.addEventListener("change", () => {
      form.querySelector(".codex-runtime-custom")?.toggleAttribute("hidden", source.value !== "custom");
    });
    form?.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = String(source.value ?? "bundled");
      const [mode, version = null] = value.split(":", 2);
      enqueue({
        type: "codex-runtime-select",
        mode,
        version,
        path: String(form.elements.path?.value ?? "").trim(),
      });
      for (const control of form.querySelectorAll("input, select, button")) control.disabled = true;
    });
    wrap.querySelector(".codex-runtime-check")?.addEventListener("click", (event) => {
      event.currentTarget.disabled = true;
      enqueue({ type: "codex-runtime-check" });
    });
    wrap.querySelector(".codex-runtime-install")?.addEventListener("click", (event) => {
      event.currentTarget.disabled = true;
      enqueue({ type: "codex-runtime-install" });
    });
    wrap.querySelector(".codex-runtime-mcp-sharing")?.addEventListener("change", (event) => {
      event.currentTarget.disabled = true;
      enqueue({
        type: "codex-runtime-mcp-sharing",
        enabled: event.currentTarget.checked,
      });
    });
  }

  return { renderCodexRuntimePage, bindCodexRuntimeEvents };
}

export { createCodexRuntime };
