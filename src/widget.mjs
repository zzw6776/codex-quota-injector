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
  const PLACEHOLDER_ID = "codex-quota-injector-placeholder";
  const VERSION = 11;
  if (window[GLOBAL_KEY]?.version === VERSION) return VERSION;
  window[GLOBAL_KEY]?.destroy?.();

  const state = {
    data: { accounts: [], windows: [], currentAccountId: null, operation: null },
    dataJson: "",
    root: null,
    placeholder: null,
    shadow: null,
    observer: null,
    resizeHandler: null,
    documentPointerHandler: null,
    pinned: false,
    dismissed: false,
    hoverTimer: null,
    actions: [],
  };

  const styleText = `
    :host { display: inline-flex; position: fixed; z-index: 2147483000; }
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
      position: fixed; left: 12px; bottom: 58px; width: min(430px, calc(100vw - 24px));
      max-height: 720px; overflow: auto;
      padding: 14px; border-radius: 16px;
      color: var(--token-foreground, #f4f4f7); background: var(--token-main-surface-primary, #191923);
      border: 1px solid var(--token-border, rgba(255,255,255,.09));
      box-shadow: 0 16px 44px rgba(0,0,0,.38);
      opacity: 0; visibility: hidden; transform: translateY(5px) scale(.985);
      transform-origin: right bottom; pointer-events: none;
      transition: opacity 120ms ease, transform 120ms ease, visibility 120ms;
    }
    .quota-wrap:hover .quota-popover, .quota-wrap:focus-within .quota-popover,
    .quota-wrap.is-open .quota-popover, .quota-wrap.is-hover-grace .quota-popover {
      opacity: 1; visibility: visible; transform: translateY(0) scale(1); pointer-events: auto;
    }
    .quota-wrap.is-dismissed .quota-popover {
      opacity: 0; visibility: hidden; transform: translateY(5px) scale(.985); pointer-events: none;
    }
    .panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 1px 2px 10px; }
    .panel-title { font-size: 14px; font-weight: 700; }
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
    .window-list { display: grid; gap: 7px; margin-top: 9px; }
    .window-row { display: grid; grid-template-columns: 58px 42px minmax(70px, 1fr); align-items: center; gap: 8px; font-size: 11px; }
    .window-label { color: var(--token-text-secondary, #aaaab5); }
    .window-left { text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; }
    .window-track { height: 4px; overflow: hidden; border-radius: 99px; background: rgba(255,255,255,.08); }
    .window-track i { display: block; height: 100%; border-radius: inherit; background: #d9b8ff; }
    .window-reset { grid-column: 2 / 4; margin-top: -3px; color: var(--token-text-secondary, #8f8f9b); font-size: 10px; }
    .account-actions { display: flex; justify-content: flex-end; margin-top: 9px; }
    .btn { appearance: none; border: 1px solid rgba(255,255,255,.11); border-radius: 8px; cursor: pointer; padding: 5px 9px; color: inherit; background: rgba(255,255,255,.045); font-size: 11px; }
    .btn:hover { background: rgba(255,255,255,.09); }
    .btn.primary { border-color: rgba(217,184,255,.24); color: #e5cdfd; background: rgba(217,184,255,.1); }
    .btn:disabled { cursor: default; opacity: .45; }
    .empty { padding: 18px 8px; text-align: center; color: var(--token-text-secondary, #aaaab5); font-size: 12px; }
    .operation { margin-top: 9px; padding: 8px 10px; border-radius: 9px; overflow-wrap: anywhere; background: rgba(255,255,255,.045); color: var(--token-text-secondary, #b5b5bf); font-size: 11px; }
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
    .quota-wrap.is-light .icon-btn:hover { background: rgba(0,0,0,.06); }
    .quota-wrap.is-light .add-panel, .quota-wrap.is-light details { border-color: rgba(0,0,0,.09); }
    .quota-wrap.is-light input, .quota-wrap.is-light textarea { color: #202124; border-color: rgba(0,0,0,.13); background: rgba(0,0,0,.025); }
    .quota-wrap.is-light .operation { color: #666670; background: rgba(0,0,0,.04); }
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
    if (!profileButton?.parentElement) return false;
    let placeholder = document.getElementById(PLACEHOLDER_ID);
    if (!placeholder) {
      placeholder = document.createElement("span");
      placeholder.id = PLACEHOLDER_ID;
      placeholder.setAttribute("aria-hidden", "true");
      placeholder.style.cssText = "display:inline-block;flex:0 0 auto;width:22px;height:22px;pointer-events:none";
      profileButton.after(placeholder);
    }
    state.placeholder = placeholder;
    if (state.root?.isConnected) {
      const wrap = state.shadow?.querySelector(".quota-wrap");
      wrap?.classList.toggle("is-light", isLightTheme());
      positionWidget();
      return true;
    }
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
    document.body.append(root);
    state.root = root;
    state.shadow = shadow;
    render();
    return true;
  }

  function render() {
    const wrap = state.shadow?.querySelector(".quota-wrap");
    if (!wrap) return;
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
    const operation = state.data.operation
      ? `<div class="operation ${escapeHtml(state.data.operation.state)}">${escapeHtml(state.data.operation.message)}</div>`
      : "";
    const busy = state.data.operation?.state === "loading";
    wrap.innerHTML = `
      <button class="quota-chip" type="button" aria-label="查看账号额度">${chip}</button>
      <section class="quota-popover" aria-label="Codex 账号与额度">
        <header class="panel-head"><div class="panel-title">账号额度<span class="panel-count">${accounts.length} 个账号</span></div><button class="icon-btn close-panel" type="button" aria-label="关闭">×</button></header>
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
        </section>
      </section>`;
    positionWidget();
    bindEvents(wrap);
  }

  function positionWidget() {
    const placeholder = state.placeholder;
    const root = state.root;
    const wrap = state.shadow?.querySelector(".quota-wrap");
    const chip = wrap?.querySelector(".quota-chip");
    if (!placeholder?.isConnected || !root?.isConnected || !wrap || !chip) return;
    const chipRect = chip.getBoundingClientRect();
    const chipWidth = Math.max(22, chipRect.width);
    placeholder.style.width = `${chipWidth}px`;
    const anchor = placeholder.getBoundingClientRect();
    root.style.left = `${anchor.left}px`;
    root.style.top = `${anchor.top + Math.max(0, (anchor.height - chipRect.height) / 2)}px`;
    positionPopover(wrap);
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
    const busy = state.data.operation?.state === "loading";
    return `<article class="account-card ${account.current ? "current" : ""}">
      <div class="account-head"><span class="account-email" title="${escapeHtml(account.email)}">${escapeHtml(account.email)}</span><span class="badges">${account.current ? '<span class="badge current">当前</span>' : ""}<span class="badge">${escapeHtml(formatPlan(account.planType ?? account.authMode))}</span></span></div>
      <div class="expiry">订阅：${escapeHtml(expiry)}</div>
      ${quotaHtml}
      ${account.quotaError ? `<div class="quota-error">${escapeHtml(account.quotaError)}</div>` : ""}
      <div class="account-actions">${account.current ? "" : `<button class="btn primary switch-account" type="button" data-account-id="${escapeHtml(account.id)}" ${busy ? "disabled" : ""}>切换到此账号</button>`}</div>
    </article>`;
  }

  function renderWindow(quota) {
    const remaining = number(quota.remainingPercent);
    return `<div class="window-row"><span class="window-label">${escapeHtml(quota.label ?? "Usage")}</span><span class="window-left ${levelClass(remaining)}">${remaining}%</span><span class="window-track"><i style="width:${remaining}%"></i></span><span class="window-reset">重置：${escapeHtml(formatReset(quota.resetsAt))}</span></div>`;
  }

  function bindEvents(wrap) {
    wrap.onpointerenter = () => clearHoverGrace();
    wrap.onpointerleave = () => {
      if (state.pinned || state.dismissed) return;
      clearHoverGrace();
      wrap.classList.add("is-hover-grace");
      state.hoverTimer = window.setTimeout(() => {
        state.hoverTimer = null;
        wrap.classList.remove("is-hover-grace");
      }, 220);
    };
    const chip = wrap.querySelector(".quota-chip");
    chip?.addEventListener("pointerenter", () => {
      if (!state.dismissed) return;
      state.dismissed = false;
      wrap.classList.remove("is-dismissed");
    });
    chip?.addEventListener("click", () => {
      state.dismissed = false;
      state.pinned = !state.pinned;
      render();
    });
    wrap.querySelector(".close-panel")?.addEventListener("click", () => {
      dismissPanel();
    });
    wrap.querySelectorAll(".switch-account").forEach((button) => button.addEventListener("click", () => enqueue({ type: "switch-account", accountId: button.dataset.accountId })));
    wrap.querySelector(".oauth-add")?.addEventListener("click", () => enqueue({ type: "oauth-add" }));
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

  function enqueue(action) {
    state.actions.push({ ...action, id: `${Date.now()}-${Math.random().toString(16).slice(2)}` });
    state.dismissed = false;
    state.pinned = true;
  }

  function dismissPanel() {
    clearHoverGrace();
    state.pinned = false;
    state.dismissed = true;
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

  function number(value) {
    return Math.min(100, Math.max(0, Math.round(Number(value) || 0)));
  }

  function escapeHtml(value) {
    return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }

  state.observer = new MutationObserver(() => ensureMounted());
  state.observer.observe(document.documentElement, { childList: true, subtree: true });
  state.resizeHandler = () => {
    positionWidget();
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
      state.placeholder?.remove();
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
