function createAccounts(dependencies) {
  const { state } = dependencies;
  const renderWakeupStatus = (...args) => dependencies.renderWakeupStatus(...args);
  const enqueue = (...args) => dependencies.enqueue(...args);
  const formatReset = (...args) => dependencies.formatReset(...args);
  const formatExpiry = (...args) => dependencies.formatExpiry(...args);
  const formatUpdatedAt = (...args) => dependencies.formatUpdatedAt(...args);
  const formatPlan = (...args) => dependencies.formatPlan(...args);
  const levelClass = (...args) => dependencies.levelClass(...args);
  const number = (...args) => dependencies.number(...args);
  const escapeHtml = (...args) => dependencies.escapeHtml(...args);

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

function bindAccountEvents(wrap) {
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

  return { renderAccount, renderWindow, bindAccountEvents };
}

export { createAccounts };
