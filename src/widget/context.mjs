function createContext(dependencies) {
  const { state } = dependencies;
  const renderPanelControls = (...args) => dependencies.renderPanelControls(...args);
  const enqueue = (...args) => dependencies.enqueue(...args);
  const formatContextValue = (...args) => dependencies.formatContextValue(...args);
  const escapeHtml = (...args) => dependencies.escapeHtml(...args);

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

function bindContextEvents(wrap) {
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
}

function setContextEditorOpen(form, open) {
    if (!form) return;
    form.hidden = !open;
    const button = form.closest(".model-card")?.querySelector(".context-edit-open");
    if (button) button.textContent = open ? "收起" : "修改";
  }

  return { renderContextPage, renderContextModel, renderContextEditForm, bindContextEvents, setContextEditorOpen };
}

export { createContext };
