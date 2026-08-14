export const WIDGET_RUNTIME_VERSION = 57;

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
  runtimeVersion = WIDGET_RUNTIME_VERSION,
) {
  const GLOBAL_KEY = "__codexQuotaWidget";
  const ROOT_ID = "codex-quota-injector-root";
  const VERSION = runtimeVersion;
  const MAX_CONVERSATION_USAGE_CACHE = 240;
  const CONVERSATION_TOOLTIP_DELAY_MS = 500;
  if (window[GLOBAL_KEY]?.version === VERSION) return VERSION;
  window[GLOBAL_KEY]?.destroy?.();

  const state = {
    data: {
      accounts: [],
      windows: [],
      currentAccountId: null,
      operation: null,
      context: { status: "unavailable", models: [], overriddenCount: 0 },
      deepSeek: { enabled: false, apiKey: "", balance: null },
      tokenUsage: { status: "ready", turns: [] },
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
    hoverTimer: null,
    actions: [],
    page: "accounts",
    contextEditingSlug: null,
    deepSeekKeyDraft: null,
    deepSeekEnabledDraft: null,
    deepSeekSubmittedKey: null,
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
    .quota-popover.provider-popover { width: min(520px, calc(100vw - 24px)); }
    .quota-wrap:focus-within .quota-popover,
    .quota-wrap.is-open .quota-popover, .quota-wrap.is-hover-grace .quota-popover {
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
    .accounts-head { align-items: baseline; }
    .accounts-head .icon-btn {
      display: inline-block; height: auto; padding: 5px 0; line-height: 1; transform: none;
    }
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
    .balance-section { margin-top: 10px; }
    .balance-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 7px; font-size: 11px; }
    .balance-grid { display: grid; gap: 7px; }
    .balance-card { padding: 9px 10px; border: 1px solid rgba(255,255,255,.07); border-radius: 10px; background: rgba(255,255,255,.025); }
    .balance-currency { color: var(--token-text-secondary, #aaaab5); font-size: 10px; }
    .balance-total { margin-top: 3px; font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums; }
    .balance-detail { margin-top: 4px; color: var(--token-text-secondary, #aaaab5); font-size: 10px; }
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
    .quota-wrap.is-light .provider-icon-btn {
      color: #70717c; background: transparent;
    }
    .quota-wrap.is-light .provider-icon-btn:hover, .quota-wrap.is-light .provider-icon-btn:focus-visible {
      color: #363740; background: rgba(0,0,0,.06);
    }
    .quota-wrap.is-light .add-panel, .quota-wrap.is-light details { border-color: rgba(0,0,0,.09); }
    .quota-wrap.is-light input, .quota-wrap.is-light textarea { color: #202124; border-color: rgba(0,0,0,.13); background: rgba(0,0,0,.025); }
    .quota-wrap.is-light .operation { color: #666670; background: rgba(0,0,0,.04); }
    .quota-wrap.is-light .context-summary, .quota-wrap.is-light .model-card,
    .quota-wrap.is-light .provider-summary, .quota-wrap.is-light .provider-form,
    .quota-wrap.is-light .balance-card { border-color: rgba(0,0,0,.09); background: rgba(0,0,0,.018); }
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
    const providerPage = state.page === "provider";
    const popoverClass = contextPage
      ? "quota-popover context-popover"
      : providerPage
        ? "quota-popover provider-popover"
        : "quota-popover";
    const popoverContent = contextPage
      ? renderContextPage(busy)
      : providerPage
        ? renderProviderPage()
        : `
        <header class="panel-head accounts-head"><div class="panel-title-wrap"><div class="panel-title">账号额度<span class="panel-count">${accounts.length} 个账号</span></div><button class="icon-btn provider-icon-btn provider-open" type="button" aria-label="DeepSeek 设置" title="DeepSeek 设置"><span aria-hidden="true">DS</span></button><button class="icon-btn context-open" type="button" aria-label="模型上下文" title="模型上下文">⚙</button></div><button class="icon-btn close-panel" type="button" aria-label="关闭">×</button></header>
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
      <section class="${popoverClass}" popover="manual" aria-label="${contextPage ? "Codex 模型上下文" : providerPage ? "DeepSeek 设置" : "Codex 账号与额度"}">${popoverContent}</section>`;
    const nextPopover = wrap.querySelector(".quota-popover");
    if (nextPopover) {
      nextPopover.showPopover();
      nextPopover.scrollTop = previousScrollTop;
      nextPopover.scrollLeft = previousScrollLeft;
    }
    positionPopover(wrap);
    bindEvents(wrap);
    scheduleConversationTokenUsageRender();
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
      if (turnId && Number(usage.totalTokens) > 0) {
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
    const usageItems = [...state.conversationUsageByTurn.values()];
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
      const turnNode = turnNodes.get(turnId);
      if (!turnId || !turnNode || Number(usage.totalTokens) <= 0) continue;
      visibleTurnIds.add(turnId);
      const host = turnNode.firstElementChild ?? turnNode;
      let line = state.conversationUsageLines.get(turnId);
      if (!line?.isConnected) line = turnNode.querySelector("[data-codex-token-usage]");
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
      const cost = usage.cost ?? {};
      const costLabel = usage.completed ? (cost.label ?? "本轮费用") : "实时估算";
      const costSummary = cost.available
        ? `${costLabel} ${formatCny(cost.totalCny)}`
        : "费用暂不可算";
      const generationRate = Number(usage.totalGenerationRate) > 0
        ? `速率 ${formatGenerationRate(usage.totalGenerationRate)}`
        : null;
      const summary = [
        `${usage.completed ? "本轮" : "实时"} Token ${formatTokenCount(usage.totalTokens)}`,
        `输入 ${formatTokenCount(usage.inputTokens)}`,
        `缓存输入 ${formatTokenCount(usage.cachedInputTokens)}`,
        `输出 ${formatTokenCount(usage.outputTokens)}`,
        `累计 ${formatTokenCount(usage.cumulativeTotalTokens)}`,
        ...(generationRate ? [generationRate] : []),
        costSummary,
      ].join(" · ");
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
    tooltip.replaceChildren();

    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin-bottom:8px;font-weight:650";
    const title = document.createElement("span");
    title.textContent = cost.normalizedModel || cost.requestedModel || usage.model || "Token 费用明细";
    const total = document.createElement("strong");
    total.style.cssText = "font-variant-numeric:tabular-nums;white-space:nowrap";
    total.textContent = cost.available
      ? `${usage.completed ? (cost.label ?? "本轮费用") : "实时估算"} ${formatCny(cost.totalCny)}`
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
    appendConversationTooltipMetricRow(
      rows,
      "速率",
      formatGenerationRate(usage.totalGenerationRate),
      Number(usage.totalGenerationRate) > 0
        ? "包含推理输出，按流式事件估算"
        : "等待更多流式数据",
    );

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
      const tiers = Array.isArray(cost.contextTiers) && cost.contextTiers.includes("long")
        ? "包含长上下文请求"
        : "短上下文";
      pricing.textContent = `OpenAI 标准 API 价格 · ${tiers}`;
    } else if (cost.provider === "deepseek") {
      pricing.textContent = "DeepSeek API 官方价格";
    } else {
      pricing.textContent = cost.reason || "当前模型没有可用价格";
    }
    footer.append(pricing);
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
    const showContext = contextTiers.has("short") && contextTiers.has("long");
    return tiers.map((tier) => {
      const labels = [
        showModel ? tier.cost?.normalizedModel : "",
        showContext ? formatContextTier(tier.cost?.contextTier) : "",
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
      "width:max-content",
      "min-width:320px",
      "max-width:min(420px,calc(100vw - 24px))",
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

  function renderProviderPage() {
    const provider = state.data.deepSeek ?? {};
    const key = state.deepSeekKeyDraft ?? provider.apiKey ?? "";
    const enabled = state.deepSeekEnabledDraft ?? Boolean(provider.enabled);
    const configured = Boolean(provider.apiKey);
    const supported = provider.supported !== false;
    const pendingRestart = Boolean(provider.pendingRestart);
    const balanceItems = Array.isArray(provider.balance?.items) ? provider.balance.items : [];
    const balanceHtml = balanceItems.length
      ? balanceItems.map((item) => `<div class="balance-card"><div class="balance-currency">${escapeHtml(item.currency)}</div><div class="balance-total">${escapeHtml(item.totalBalance)}</div><div class="balance-detail">赠送余额 ${escapeHtml(item.grantedBalance)} · 充值余额 ${escapeHtml(item.toppedUpBalance)}</div></div>`).join("")
      : `<div class="context-empty">${configured ? "暂无可用余额数据" : "保存 API Key 后可查询余额"}</div>`;
    const statusMessage = provider.message
      ? `<div class="operation ${provider.messageState === "error" ? "error" : "success"}">${escapeHtml(provider.message)}</div>`
      : "";
    const balanceError = provider.balanceError
      ? `<div class="quota-error">${escapeHtml(provider.balanceError)}（保留上次成功余额）</div>`
      : "";
    return `
      <header class="panel-head"><div class="panel-title-wrap"><button class="icon-btn provider-back" type="button" aria-label="返回账号额度">←</button><div><div class="panel-title">DeepSeek 模型</div><div class="panel-subtitle">${escapeHtml(provider.model?.displayName ?? "DeepSeek V4 Flash")} · 推理深度 low / high / max</div></div></div><button class="icon-btn close-panel" type="button" aria-label="关闭">×</button></header>
      <section class="provider-summary"><div class="provider-status"><span class="${provider.enabled ? "enabled" : "disabled"}">${provider.enabled ? "已启用" : "未启用"}</span><span class="badge">${escapeHtml(provider.model?.slug ?? "deepseek-v4-flash")}</span></div><div class="provider-note">启用后，OpenAI 官方模型和 DeepSeek 会同时出现在模型列表。供应商在新建任务时确定，同一任务不能中途切换。</div></section>
      <form class="provider-form">
        <label class="provider-toggle"><input name="enabled" type="checkbox" ${enabled ? "checked" : ""} ${supported && !pendingRestart ? "" : "disabled"}>在模型列表中启用 DeepSeek</label>
        <div class="provider-field"><label>DeepSeek API Key（本地明文保存并完整回显）</label><input class="provider-key" name="apiKey" type="text" autocomplete="off" spellcheck="false" value="${escapeHtml(key)}" placeholder="sk-..." ${supported && !pendingRestart ? "" : "disabled"}></div>
        <div class="provider-warning">Key 保存在 ${escapeHtml(provider.settingsPath ?? "本地 provider-settings.json")}；不会写入系统安全存储。保存、停用或删除后都会重启 Codex。</div>
        <div class="provider-actions"><button class="btn deepseek-remove" type="button" ${configured && !pendingRestart ? "" : "disabled"}>删除并重启 Codex</button><button class="btn primary" type="submit" ${supported && !pendingRestart ? "" : "disabled"}>保存并重启 Codex</button></div>
        ${supported ? "" : '<div class="quota-error">DeepSeek 模型共存当前仅支持 macOS。</div>'}
      </form>
      ${statusMessage}
      <section class="balance-section"><div class="balance-head"><span>账户余额${provider.balance ? ` · ${provider.balance.available ? "账户可用" : "账户不可用"}` : ""} · ${escapeHtml(formatUpdatedAt(provider.balanceUpdatedAt))}</span><button class="btn deepseek-refresh-balance" type="button" ${!configured || provider.balanceRefreshing ? "disabled" : ""}>${provider.balanceRefreshing ? "查询中" : "查询余额"}</button></div><div class="balance-grid">${balanceHtml}</div>${balanceError}</section>`;
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
    wrap.querySelector(".provider-open")?.addEventListener("click", () => {
      state.page = "provider";
      state.deepSeekKeyDraft = state.data.deepSeek?.apiKey ?? "";
      state.deepSeekEnabledDraft = Boolean(state.data.deepSeek?.enabled);
      state.pinned = true;
      state.dismissed = false;
      render();
    });
    wrap.querySelector(".context-back")?.addEventListener("click", () => {
      state.page = "accounts";
      state.contextEditingSlug = null;
      render();
    });
    wrap.querySelector(".provider-back")?.addEventListener("click", () => {
      state.page = "accounts";
      render();
    });
    wrap.querySelector(".provider-key")?.addEventListener("input", (event) => {
      state.deepSeekKeyDraft = event.currentTarget.value;
    });
    wrap.querySelector('.provider-form input[name="enabled"]')?.addEventListener("change", (event) => {
      state.deepSeekEnabledDraft = event.currentTarget.checked;
    });
    wrap.querySelector(".provider-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const apiKey = String(form.get("apiKey") ?? "");
      const enabled = form.get("enabled") === "on";
      state.deepSeekKeyDraft = apiKey;
      state.deepSeekEnabledDraft = enabled;
      state.deepSeekSubmittedKey = apiKey.trim();
      enqueue({ type: "deepseek-save", apiKey, enabled });
    });
    wrap.querySelector(".deepseek-remove")?.addEventListener("click", () => {
      if (!window.confirm("确定删除本地保存的完整 DeepSeek API Key 并重启 Codex？")) return;
      state.deepSeekKeyDraft = "";
      state.deepSeekEnabledDraft = false;
      state.deepSeekSubmittedKey = "";
      enqueue({ type: "deepseek-remove" });
    });
    wrap.querySelector(".deepseek-refresh-balance")?.addEventListener("click", () => enqueue({ type: "deepseek-refresh-balance" }));
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
      state.observer?.observe(root, { childList: true, subtree: true });
    }
  }

  function mutationTouchesConversation(mutations) {
    return mutations.some((mutation) => {
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
  state.mountObserver = new MutationObserver(() => {
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
  state.mountObserver.observe(document.documentElement, { childList: true, subtree: true });
  state.resizeHandler = () => {
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
      if (state.deepSeekSubmittedKey != null &&
        String(data?.deepSeek?.apiKey ?? "") === state.deepSeekSubmittedKey) {
        state.deepSeekKeyDraft = null;
        state.deepSeekEnabledDraft = null;
        state.deepSeekSubmittedKey = null;
      }
      state.dataJson = json;
      state.dataRevision = revision;
      state.tokenUsageRevision = revision;
      state.data = data ?? state.data;
      ensureMounted();
      render();
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
      state.observer?.disconnect();
      state.observer = null;
      state.mountObserver?.disconnect();
      state.mountObserver = null;
      if (state.mountCheckFrame != null) {
        window.cancelAnimationFrame(state.mountCheckFrame);
        state.mountCheckFrame = null;
      }
      clearHoverGrace();
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
      state.root?.remove();
      delete window[GLOBAL_KEY];
    },
  };
  return VERSION;
}

export function widgetInstallExpression() {
  return `(${installQuotaWidget.toString()})(${calculatePopoverMaxHeight.toString()},${WIDGET_RUNTIME_VERSION})`;
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

export function widgetTokenUsageDeltaUpdateExpressionJson(serializedDelta, revision = null) {
  const revisionArgument = revision == null ? "" : `,${JSON.stringify(revision)}`;
  return `window.__codexQuotaWidget?.updateTokenUsageDelta(${String(serializedDelta)}${revisionArgument})`;
}

export function widgetDrainActionsExpression() {
  return "window.__codexQuotaWidget?.drainActions?.() ?? []";
}
