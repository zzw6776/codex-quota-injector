export function calculatePopoverMaxHeight(chipTop) {
  const TITLE_BAR_SAFE_TOP = 44;
  const ANCHOR_GAP = 10;
  const MAX_HEIGHT = 720;
  const top = Number(chipTop);
  if (!Number.isFinite(top)) return 0;
  return Math.max(0, Math.min(MAX_HEIGHT, Math.floor(top - TITLE_BAR_SAFE_TOP - ANCHOR_GAP)));
}

export function installQuotaWidget(
  calculateMaxHeight = (chipTop) => Math.max(0, Math.min(720, Math.floor(Number(chipTop) - 54))),
) {
  const GLOBAL_KEY = "__codexQuotaWidget";
  const ROOT_ID = "codex-quota-injector-root";
  const VERSION = 29;
  if (window[GLOBAL_KEY]?.version === VERSION) return VERSION;
  window[GLOBAL_KEY]?.destroy?.();

  const state = {
    data: {
      accounts: [],
      windows: [],
      currentAccountId: null,
      operation: null,
      context: { status: "unavailable", models: [], overriddenCount: 0 },
    },
    dataJson: "",
    root: null,
    shadow: null,
    observer: null,
    resizeHandler: null,
    documentPointerHandler: null,
    pinned: false,
    dismissed: false,
    hoverTimer: null,
    actions: [],
    page: "accounts",
    contextEditingSlug: null,
  };

  const styleText = `
    :host { display: inline-flex; flex: 0 0 auto; align-items: center; }
    * { box-sizing: border-box; }
    button, input, textarea { font: inherit; }
    .quota-wrap { position: relative; display: inline-flex; align-items: center; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .quota-wrap::before { content: ""; position: absolute; left: 0; bottom: 100%; width: 100%; height: 13px; }
    .quota-chip {
      appearance: none; border: 0; border-radius: 999px; cursor: pointer;
      height: 22px; min-width: 0; padding: 0 5px;
      display: inline-flex; align-items: center; justify-content: center;
      gap: 4px; background: transparent; color: var(--token-text-secondary, #777780);
      font: 500 12px/1 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-variant-numeric: tabular-nums; white-space: nowrap;
      transition: color 120ms ease, background 120ms ease;
    }
    .quota-chip:hover, .quota-chip:focus-visible { color: inherit; background: color-mix(in srgb, currentColor 7%, transparent); outline: none; }
    .quota-divider { opacity: .42; font-weight: 400; }
    .quota-chip-item { display: inline-flex; align-items: baseline; }
    .is-warning { color: #d97706 !important; }
    .is-critical { color: #dc4c3f !important; }
    .quota-popover {
      position: fixed; inset: auto auto 58px 12px; margin: 0; width: min(430px, calc(100vw - 24px));
      max-height: 720px; overflow: auto;
      overflow-anchor: none;
      padding: 14px; border-radius: 16px;
      color: var(--token-foreground, #f4f4f7); background: var(--token-main-surface-primary, #191923);
      border: 1px solid var(--token-border, rgba(255,255,255,.09));
      box-shadow: 0 16px 44px rgba(0,0,0,.38);
      opacity: 0; visibility: hidden; transform: translateY(5px) scale(.985);
      transform-origin: right bottom; pointer-events: none;
      transition: opacity 120ms ease, transform 120ms ease, visibility 120ms;
    }
    .quota-popover.context-popover { width: min(620px, calc(100vw - 24px)); }
    .quota-wrap:focus-within .quota-popover,
    .quota-wrap.is-open .quota-popover, .quota-wrap.is-hover-grace .quota-popover {
      opacity: 1; visibility: visible; transform: translateY(0) scale(1); pointer-events: auto;
    }
    .quota-wrap.is-dismissed .quota-popover {
      opacity: 0; visibility: hidden; transform: translateY(5px) scale(.985); pointer-events: none;
    }
    .panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 1px 2px 10px; }
    .panel-title { font-size: 14px; font-weight: 700; }
    .panel-title-wrap { display: flex; align-items: center; min-width: 0; gap: 7px; }
    .panel-subtitle { margin-top: 3px; color: var(--token-text-secondary, #aaaab5); font-size: 10px; font-weight: 400; }
    .panel-count { margin-left: 6px; color: var(--token-text-secondary, #aaaab5); font-size: 12px; font-weight: 500; }
    .icon-btn { appearance: none; width: 26px; height: 26px; border: 0; border-radius: 8px; cursor: pointer; color: inherit; background: transparent; }
    .icon-btn:hover { background: rgba(255,255,255,.07); }
    .account-list { display: grid; gap: 8px; }
    .account-card { padding: 11px 12px; border: 1px solid rgba(255,255,255,.07); border-radius: 12px; background: rgba(255,255,255,.025); }
    .account-card.current { border-color: rgba(217,184,255,.33); background: rgba(217,184,255,.055); }
    .account-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .account-email { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 650; }
    .badges { display: flex; align-items: center; gap: 5px; flex: 0 0 auto; }
    .badge { padding: 2px 6px; border-radius: 999px; background: rgba(255,255,255,.07); color: var(--token-text-secondary, #aaaab5); font-size: 10px; line-height: 16px; }
    .badge.current { color: #d9b8ff; background: rgba(217,184,255,.12); }
    .expiry { margin-top: 5px; color: var(--token-text-secondary, #aaaab5); font-size: 11px; line-height: 16px; }
    .account-meta { display: flex; align-items: center; justify-content: space-between; gap: 10px; white-space: nowrap; }
    .window-list { display: grid; gap: 7px; margin-top: 9px; }
    .window-row { display: grid; grid-template-columns: 58px 42px minmax(70px, 1fr); align-items: center; gap: 8px; font-size: 11px; }
    .window-label { color: var(--token-text-secondary, #aaaab5); }
    .window-left { text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; }
    .window-track { height: 4px; overflow: hidden; border-radius: 99px; background: rgba(255,255,255,.08); }
    .window-track i { display: block; height: 100%; border-radius: inherit; background: #d9b8ff; }
    .window-reset { grid-column: 2 / 4; margin-top: -3px; color: var(--token-text-secondary, #8f8f9b); font-size: 10px; }
    .btn { appearance: none; border: 1px solid rgba(255,255,255,.11); border-radius: 8px; cursor: pointer; padding: 5px 9px; color: inherit; background: rgba(255,255,255,.045); font-size: 11px; }
    .btn:hover { background: rgba(255,255,255,.09); }
    .btn.primary { border-color: rgba(217,184,255,.24); color: #e5cdfd; background: rgba(217,184,255,.1); }
    .btn:disabled { cursor: default; opacity: .45; }
    .account-switch { padding: 2px 7px; border-radius: 999px; line-height: 16px; white-space: nowrap; }
    .account-remove { padding: 2px 7px; border-radius: 999px; line-height: 16px; white-space: nowrap; color: #ef8e86; border-color: rgba(220,76,63,.2); background: rgba(220,76,63,.06); }
    .account-remove:hover { background: rgba(220,76,63,.12); }
    .empty { padding: 18px 8px; text-align: center; color: var(--token-text-secondary, #aaaab5); font-size: 12px; }
    .operation { margin-top: 9px; padding: 8px 10px; border-radius: 9px; overflow-wrap: anywhere; background: rgba(255,255,255,.045); color: var(--token-text-secondary, #b5b5bf); font-size: 11px; }
    .operation.has-action { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .operation.has-action span { min-width: 0; }
    .operation .oauth-cancel { flex: 0 0 auto; padding: 3px 7px; }
    .operation.success { color: #7ecb9b; background: rgba(52,168,92,.09); }
    .operation.error { color: #ef8e86; background: rgba(220,76,63,.09); }
    .add-panel { margin-top: 11px; padding-top: 11px; border-top: 1px solid rgba(255,255,255,.07); }
    .add-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .toolbar-actions { display: flex; align-items: center; gap: 7px; }
    .add-title { font-size: 12px; font-weight: 650; }
    .add-options { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-top: 9px; }
    details { grid-column: 1 / -1; border: 1px solid rgba(255,255,255,.07); border-radius: 9px; }
    summary { cursor: pointer; padding: 7px 9px; color: var(--token-text-secondary, #aaaab5); font-size: 11px; }
    form { display: grid; gap: 7px; padding: 0 9px 9px; }
    input, textarea { width: 100%; border: 1px solid rgba(255,255,255,.1); border-radius: 7px; outline: none; padding: 7px 8px; color: inherit; background: rgba(0,0,0,.16); font-size: 11px; }
    textarea { min-height: 70px; resize: vertical; }
    input:focus, textarea:focus { border-color: rgba(217,184,255,.4); }
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
    .quota-wrap.is-light .quota-popover { color: #202124; background: #fff; border-color: rgba(0,0,0,.12); box-shadow: 0 16px 44px rgba(0,0,0,.18); }
    .quota-wrap.is-light .account-card { border-color: rgba(0,0,0,.09); background: rgba(0,0,0,.018); }
    .quota-wrap.is-light .account-card.current { border-color: rgba(116,69,143,.35); background: rgba(116,69,143,.055); }
    .quota-wrap.is-light .badge { color: #676771; background: rgba(0,0,0,.055); }
    .quota-wrap.is-light .badge.current { color: #754694; background: rgba(116,69,143,.1); }
    .quota-wrap.is-light .expiry, .quota-wrap.is-light .window-label, .quota-wrap.is-light .window-reset,
    .quota-wrap.is-light summary, .quota-wrap.is-light .empty { color: #6f6f79; }
    .quota-wrap.is-light .window-track { background: rgba(0,0,0,.08); }
    .quota-wrap.is-light .window-track i { background: #9b68bb; }
    .quota-wrap.is-light .btn { color: #2f3035; border-color: rgba(0,0,0,.12); background: rgba(0,0,0,.025); }
    .quota-wrap.is-light .btn:hover { background: rgba(0,0,0,.065); }
    .quota-wrap.is-light .btn.primary { color: #71438e; border-color: rgba(116,69,143,.28); background: rgba(116,69,143,.08); }
    .quota-wrap.is-light .account-remove { color: #b53d35; border-color: rgba(181,61,53,.2); background: rgba(181,61,53,.045); }
    .quota-wrap.is-light .account-remove:hover { background: rgba(181,61,53,.09); }
    .quota-wrap.is-light .icon-btn:hover { background: rgba(0,0,0,.06); }
    .quota-wrap.is-light .add-panel, .quota-wrap.is-light details { border-color: rgba(0,0,0,.09); }
    .quota-wrap.is-light input, .quota-wrap.is-light textarea { color: #202124; border-color: rgba(0,0,0,.13); background: rgba(0,0,0,.025); }
    .quota-wrap.is-light .operation { color: #666670; background: rgba(0,0,0,.04); }
    .quota-wrap.is-light .context-summary, .quota-wrap.is-light .model-card { border-color: rgba(0,0,0,.09); background: rgba(0,0,0,.018); }
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
    const previousPopover = wrap.querySelector(".quota-popover");
    const previousScrollTop = previousPopover?.scrollTop ?? 0;
    const previousScrollLeft = previousPopover?.scrollLeft ?? 0;
    wrap.classList.toggle("is-light", isLightTheme());
    wrap.classList.toggle("is-open", state.pinned);
    wrap.classList.toggle("is-dismissed", state.dismissed);
    const accounts = Array.isArray(state.data.accounts) ? state.data.accounts : [];
    const windows = Array.isArray(state.data.windows) ? state.data.windows : [];
    const chip = windows.length
      ? windows.map((quota) => `<span class="quota-chip-item ${levelClass(quota.remainingPercent)}">${number(quota.remainingPercent)}%</span>`).join('<span class="quota-divider">·</span>')
      : '<span class="quota-chip-item">--</span>';
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
    const popoverClass = contextPage ? "quota-popover context-popover" : "quota-popover";
    const popoverContent = contextPage
      ? renderContextPage(busy)
      : `
        <header class="panel-head"><div class="panel-title-wrap"><div class="panel-title">账号额度<span class="panel-count">${accounts.length} 个账号</span></div><button class="icon-btn context-open" type="button" aria-label="模型上下文" title="模型上下文">⚙</button></div><button class="icon-btn close-panel" type="button" aria-label="关闭">×</button></header>
        <div class="account-list">${accountHtml}</div>
        ${operation}
        <section class="add-panel">
          <div class="add-toolbar"><span class="add-title">账号管理</span><span class="toolbar-actions"><button class="btn export-all" type="button" title="导出文件包含完整登录凭据，请妥善保管" ${busy || accounts.length === 0 ? "disabled" : ""}>导出全部</button><button class="btn refresh-all" type="button" ${busy ? "disabled" : ""}>刷新全部</button></span></div>
          <div class="add-options">
            <button class="btn primary oauth-add" type="button" ${busy ? "disabled" : ""}>OpenAI OAuth</button>
            <button class="btn local-import" type="button" ${busy ? "disabled" : ""}>导入本机登录</button>
            <details><summary>Token / JSON</summary><form class="token-form"><textarea name="token" autocomplete="off" placeholder="粘贴 auth.json、tokens JSON、access token 或 refresh token" required ${busy ? "disabled" : ""}></textarea><button class="btn primary" type="submit" ${busy ? "disabled" : ""}>导入 Token</button></form></details>
            <details><summary>API Key</summary><form class="api-key-form"><input name="name" placeholder="账号名称（可选）" ${busy ? "disabled" : ""}><input name="apiKey" type="password" autocomplete="off" placeholder="OpenAI API Key" required ${busy ? "disabled" : ""}><button class="btn primary" type="submit" ${busy ? "disabled" : ""}>添加 API Key</button></form></details>
          </div>
        </section>`;
    wrap.innerHTML = `
      <button class="quota-chip" type="button" aria-label="查看账号额度">${chip}</button>
      <section class="${popoverClass}" popover="manual" aria-label="${contextPage ? "Codex 模型上下文" : "Codex 账号与额度"}">${popoverContent}</section>`;
    const nextPopover = wrap.querySelector(".quota-popover");
    if (nextPopover) {
      nextPopover.showPopover();
      nextPopover.scrollTop = previousScrollTop;
      nextPopover.scrollLeft = previousScrollLeft;
    }
    positionPopover(wrap);
    bindEvents(wrap);
  }

  function renderContextPage(busy) {
    const context = state.data.context ?? {};
    const models = Array.isArray(context.models) ? context.models : [];
    const orphanedCount = Number(context.orphanedCount) || 0;
    const status = String(context.status ?? "unavailable");
    const statusText = {
      "system-default": "使用系统默认值",
      applied: "已写入配置，重启后生效",
      pending: "覆盖值待加载",
      external: "检测到其他模型目录",
      unavailable: "无法读取系统模型目录",
    }[status] ?? "状态未知";
    const contextNote = status === "external"
      ? "Codex 当前指向其他模型目录。本工具不会自动合并或接管，请先恢复 Codex 官方模型目录。"
      : `默认值来自 Codex 当前模型目录。只有主动保存的模型才会生成覆盖值；修改后需要重启 Codex 才能加载。${orphanedCount ? `有 ${orphanedCount} 条覆盖记录对应的模型已不存在，可用“恢复全部默认”清理。` : ""}`;
    const statusMessage = context.message
      ? `<div class="operation ${context.messageState === "error" ? "error" : "success"}">${escapeHtml(context.message)}</div>`
      : "";
    const modelHtml = models.length
      ? models.map(renderContextModel).join("")
      : '<div class="context-empty">没有可展示的模型目录</div>';
    return `
      <header class="panel-head"><div class="panel-title-wrap"><button class="icon-btn context-back" type="button" aria-label="返回账号额度">←</button><div><div class="panel-title">模型上下文</div><div class="panel-subtitle">${models.length} 个模型 · 已覆盖 ${Number(context.overriddenCount) || 0} 个${orphanedCount ? ` · ${orphanedCount} 个模型已不存在` : ""}</div></div></div><button class="icon-btn close-panel" type="button" aria-label="关闭">×</button></header>
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

  function positionPopover(wrap) {
    const chip = wrap.querySelector(".quota-chip");
    const popover = wrap.querySelector(".quota-popover");
    if (!chip || !popover) return;
    const chipRect = chip.getBoundingClientRect();
    popover.style.bottom = `${Math.max(12, window.innerHeight - chipRect.top + 10)}px`;
    popover.style.maxHeight = `${calculateMaxHeight(chipRect.top)}px`;
  }

  function isLightTheme() {
    return document.documentElement.classList.contains("electron-light") ||
      (!document.documentElement.classList.contains("electron-dark") &&
        window.matchMedia?.("(prefers-color-scheme: light)").matches);
  }

  function renderAccount(account) {
    const windows = Array.isArray(account.windows) ? account.windows : [];
    const quotaHtml = windows.length
      ? `<div class="window-list">${windows.map(renderWindow).join("")}</div>`
      : '<div class="expiry">暂无额度数据</div>';
    const expiry = formatExpiry(account.subscriptionActiveUntil);
    const updatedAt = formatUpdatedAt(account.quotaUpdatedAt);
    const busy = state.data.operation?.state === "loading";
    const needsReauth = account.authStatus === "needsReauth";
    const switchControl = account.current
      ? ""
      : needsReauth
        ? '<span class="badge">需要重新授权</span>'
        : `<button class="btn primary account-switch switch-account" type="button" data-account-id="${escapeHtml(account.id)}" ${busy ? "disabled" : ""}>切换到此账号</button>`;
    const removeControl = `<button class="btn account-remove remove-account" type="button" data-account-id="${escapeHtml(account.id)}" data-account-email="${escapeHtml(account.email)}" title="${account.current ? "当前账号请先切换后再移除" : "移除本工具保存的账号凭据"}" ${busy || account.current ? "disabled" : ""}>移除</button>`;
    return `<article class="account-card ${account.current ? "current" : ""}">
      <div class="account-head"><span class="account-email" title="${escapeHtml(account.email)}">${escapeHtml(account.email)}</span><span class="badges">${account.current ? '<span class="badge current">当前</span>' : ""}${switchControl}${removeControl}<span class="badge">${escapeHtml(formatPlan(account.planType ?? account.authMode))}</span></span></div>
      <div class="expiry account-meta"><span>订阅：${escapeHtml(expiry)}</span><span>最后刷新：${escapeHtml(updatedAt)}</span></div>
      ${quotaHtml}
      ${account.quotaError ? `<div class="quota-error">刷新异常：${escapeHtml(account.quotaError)}</div>` : ""}
    </article>`;
  }

  function renderWindow(quota) {
    const remaining = number(quota.remainingPercent);
    return `<div class="window-row"><span class="window-label">${escapeHtml(quota.label ?? "Usage")}</span><span class="window-left ${levelClass(remaining)}">${remaining}%</span><span class="window-track"><i style="width:${remaining}%"></i></span><span class="window-reset">重置：${escapeHtml(formatReset(quota.resetsAt))}</span></div>`;
  }

  function bindEvents(wrap) {
    const holdHover = () => {
      if (state.hoverTimer != null) {
        window.clearTimeout(state.hoverTimer);
        state.hoverTimer = null;
      }
      wrap.classList.add("is-hover-grace");
    };
    const releaseHover = () => {
      if (state.pinned || state.dismissed) return;
      if (state.hoverTimer != null) window.clearTimeout(state.hoverTimer);
      state.hoverTimer = window.setTimeout(() => {
        state.hoverTimer = null;
        wrap.classList.remove("is-hover-grace");
      }, 220);
    };
    const chip = wrap.querySelector(".quota-chip");
    chip?.addEventListener("pointerenter", () => {
      if (state.dismissed) {
        state.dismissed = false;
        wrap.classList.remove("is-dismissed");
      }
      holdHover();
    });
    chip?.addEventListener("pointerleave", releaseHover);
    const popover = wrap.querySelector(".quota-popover");
    popover?.addEventListener("pointerenter", holdHover);
    popover?.addEventListener("pointerleave", releaseHover);
    chip?.addEventListener("click", () => {
      state.dismissed = false;
      state.pinned = !state.pinned;
      render();
    });
    wrap.querySelector(".close-panel")?.addEventListener("click", () => {
      dismissPanel();
    });
    wrap.querySelector(".context-open")?.addEventListener("click", () => {
      state.page = "context";
      state.contextEditingSlug = null;
      state.pinned = true;
      state.dismissed = false;
      render();
    });
    wrap.querySelector(".context-back")?.addEventListener("click", () => {
      state.page = "accounts";
      state.contextEditingSlug = null;
      render();
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
    wrap.querySelectorAll(".remove-account").forEach((button) => button.addEventListener("click", () => {
      const email = button.dataset.accountEmail || "该账号";
      if (!window.confirm(`确定移除 ${email}？\n\n将删除本工具保存的账号凭据，不会注销 OpenAI 账号。`)) return;
      button.disabled = true;
      enqueue({ type: "remove-account", accountId: button.dataset.accountId });
    }));
    wrap.querySelector(".oauth-add")?.addEventListener("click", () => enqueue({ type: "oauth-add" }));
    wrap.querySelector(".oauth-cancel")?.addEventListener("click", () => enqueue({ type: "oauth-cancel" }));
    wrap.querySelector(".local-import")?.addEventListener("click", () => enqueue({ type: "local-import" }));
    wrap.querySelector(".export-all")?.addEventListener("click", () => enqueue({ type: "export-all" }));
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
    clearHoverGrace();
    state.pinned = false;
    state.dismissed = true;
    state.page = "accounts";
    state.contextEditingSlug = null;
    const wrap = state.shadow?.querySelector(".quota-wrap");
    wrap?.classList.remove("is-open");
    wrap?.classList.add("is-dismissed");
  }

  function clearHoverGrace() {
    if (state.hoverTimer != null) {
      window.clearTimeout(state.hoverTimer);
      state.hoverTimer = null;
    }
    state.shadow?.querySelector(".quota-wrap")?.classList.remove("is-hover-grace");
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
      chatgptproplan: "Pro", pro: "Pro",
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

  function number(value) {
    return Math.min(100, Math.max(0, Math.round(Number(value) || 0)));
  }

  function escapeHtml(value) {
    return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }

  state.observer = new MutationObserver(() => ensureMounted());
  state.observer.observe(document.documentElement, { childList: true, subtree: true });
  state.resizeHandler = () => {
    const wrap = state.shadow?.querySelector(".quota-wrap");
    if (wrap) positionPopover(wrap);
  };
  state.documentPointerHandler = (event) => {
    if (state.root && event.composedPath().includes(state.root)) return;
    dismissPanel();
  };
  window.addEventListener("resize", state.resizeHandler);
  document.addEventListener("pointerdown", state.documentPointerHandler, true);
  ensureMounted();

  window[GLOBAL_KEY] = {
    version: VERSION,
    update(data) {
      const json = JSON.stringify(data ?? {});
      if (json === state.dataJson) return;
      state.dataJson = json;
      state.data = data ?? state.data;
      ensureMounted();
      render();
    },
    drainActions() {
      return state.actions.splice(0);
    },
    destroy() {
      state.observer?.disconnect();
      clearHoverGrace();
      window.removeEventListener("resize", state.resizeHandler);
      document.removeEventListener("pointerdown", state.documentPointerHandler, true);
      state.root?.remove();
      delete window[GLOBAL_KEY];
    },
  };
  return VERSION;
}

export function widgetInstallExpression() {
  return `(${installQuotaWidget.toString()})(${calculatePopoverMaxHeight.toString()})`;
}

export function widgetUpdateExpression(data) {
  return `window.__codexQuotaWidget?.update(${JSON.stringify(data)})`;
}

export function widgetDrainActionsExpression() {
  return "window.__codexQuotaWidget?.drainActions?.() ?? []";
}
