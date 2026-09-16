function createWakeup(dependencies) {
  const { state } = dependencies;
  const render = (...args) => dependencies.render(...args);
  const renderPanelControls = (...args) => dependencies.renderPanelControls(...args);
  const captureDetailPanelBaseSize = (...args) => dependencies.captureDetailPanelBaseSize(...args);
  const resetDetailPanelSize = (...args) => dependencies.resetDetailPanelSize(...args);
  const enqueue = (...args) => dependencies.enqueue(...args);
  const formatUpdatedAt = (...args) => dependencies.formatUpdatedAt(...args);
  const escapeHtml = (...args) => dependencies.escapeHtml(...args);

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

function bindWakeupNavigation(wrap) {
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
}

function bindWakeupFormEvents(wrap) {
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
}

  return { renderWakeupPage, renderWakeupAccount, renderWakeupStatus, readWakeupForm, bindWakeupNavigation, bindWakeupFormEvents };
}

export { createWakeup };
