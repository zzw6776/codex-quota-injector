// Browser-serializable factory: all external values arrive through this explicit boundary.
function createMigration({ state, render, renderPanelControls, captureDetailPanelBaseSize, resetDetailPanelSize, enqueue, formatPlan, escapeHtml }) {
  function renderMigrationPage(accounts, busy, operation) {
    const mode = state.migrationMode === "handoff" ? "handoff" : "temporary";
    const isEligible = (account) => mode === "handoff"
      ? account.canTransfer === true
      : account.canTemporaryTransfer === true;
    for (const accountId of state.migrationSelectedIds) {
      const account = accounts.find((item) => item.id === accountId);
      if (!account || !isEligible(account)) state.migrationSelectedIds.delete(accountId);
    }
    const rows = accounts.map((account) => {
      const eligible = isEligible(account);
      const checked = eligible && state.migrationSelectedIds.has(account.id);
      const stateText = account.authStatus === "transferred"
        ? "已转出"
        : account.authStatus === "needsReauth"
          ? "需要重新授权"
          : account.authStatus === "temporary"
            ? "临时凭据"
            : mode === "temporary" && account.authMode === "apiKey"
              ? "仅支持完整转移"
              : account.current
                ? "当前账号"
                : formatPlan(account.authMode);
      return `<label class="migration-account-row">
        <input class="migration-account-checkbox" type="checkbox" value="${escapeHtml(account.id)}" ${checked ? "checked" : ""} ${busy || !eligible ? "disabled" : ""}>
        <span class="migration-account-label" title="${escapeHtml(account.email)}">${escapeHtml(account.email)}</span>
        <span class="migration-account-state">${escapeHtml(stateText)}</span>
      </label>`;
    }).join("");
    const selectedAccounts = accounts.filter((account) => state.migrationSelectedIds.has(account.id));
    const currentSelected = mode === "handoff" && selectedAccounts.some((account) => account.current);
    const currentNote = currentSelected
      ? '<div class="migration-current-note">所选账号包含当前账号。生成文件后，Codex 将自动切换到其他可用账号；没有可用账号时会退出登录并重新启动。</div>'
      : "";
    const modeNote = mode === "temporary"
      ? "导出前会主动刷新所选 OAuth 账号，把新的 access token 和 refresh token 都写回本机加密账户库；若包含当前账号，也同步写回 Codex 登录。迁移文件只包含 access token，新设备只能使用到它过期。"
      : "导出前会主动刷新所选 OAuth 账号，把新的 access token 和 refresh token 都写回本机加密账户库供恢复验证。迁移文件包含完整凭据；生成后本机账号标记为“已转出”，停止刷新、切换和唤醒。";
    const submitText = mode === "handoff" ? "确认完整转移" : "生成临时迁移文件";
    return `<header class="panel-head"><div class="panel-title-wrap"><button class="icon-btn migration-back" type="button" aria-label="返回账号额度">←</button><div><div class="panel-title">账号迁移</div><div class="panel-subtitle">导入继续使用账号管理中的 Token / JSON</div></div></div>${renderPanelControls()}</header>
      <form class="migration-form">
        <div class="migration-options">
          <label class="migration-option ${mode === "temporary" ? "selected" : ""}"><input class="migration-mode" type="radio" name="migrationMode" value="temporary" ${mode === "temporary" ? "checked" : ""} ${busy ? "disabled" : ""}><span><span class="migration-option-title">临时使用</span><span class="migration-option-note">不导出 refresh token，本机账号不停止。</span></span></label>
          <label class="migration-option ${mode === "handoff" ? "selected" : ""}"><input class="migration-mode" type="radio" name="migrationMode" value="handoff" ${mode === "handoff" ? "checked" : ""} ${busy ? "disabled" : ""}><span><span class="migration-option-title">完整转移</span><span class="migration-option-note">新设备接管刷新凭据，本机进入已转出状态。</span></span></label>
        </div>
        <section class="provider-summary"><div class="provider-note">${escapeHtml(modeNote)}</div><div class="provider-warning">迁移文件包含明文敏感凭据，只能存放在可信设备中。</div></section>
        <div class="add-title">选择账号</div>
        <div class="migration-account-list">${rows || '<div class="empty">暂无账号</div>'}</div>
        ${currentNote}
        ${operation}
        <div class="migration-actions"><button class="btn primary migration-submit" type="submit" ${busy || selectedAccounts.length === 0 ? "disabled" : ""}>${submitText}</button></div>
      </form>`;
  }

  function bindMigrationEvents(wrap) {
wrap.querySelector(".migration-open")?.addEventListener("click", () => {
      captureDetailPanelBaseSize(wrap);
      state.migrationMode = "temporary";
      state.migrationSelectedIds = new Set((state.data.accounts ?? [])
        .filter((account) => account.canTemporaryTransfer)
        .map((account) => account.id));
      state.page = "migration";
      state.pinned = true;
      state.dismissed = false;
      render();
    });
wrap.querySelector(".migration-back")?.addEventListener("click", () => {
      state.page = "accounts";
      resetDetailPanelSize();
      state.migrationSelectedIds.clear();
      render();
    });
wrap.querySelectorAll(".migration-mode").forEach((input) => input.addEventListener("change", () => {
      if (!input.checked) return;
      state.migrationMode = input.value === "handoff" ? "handoff" : "temporary";
      const eligibilityField = state.migrationMode === "handoff"
        ? "canTransfer"
        : "canTemporaryTransfer";
      state.migrationSelectedIds = new Set((state.data.accounts ?? [])
        .filter((account) => account[eligibilityField])
        .map((account) => account.id));
      render();
    }));
wrap.querySelectorAll(".migration-account-checkbox").forEach((input) => input.addEventListener("change", () => {
      if (input.checked) state.migrationSelectedIds.add(input.value);
      else state.migrationSelectedIds.delete(input.value);
      render();
    }));
wrap.querySelector(".migration-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const accountIds = [...state.migrationSelectedIds];
      if (accountIds.length === 0) return;
      if (state.migrationMode === "handoff") {
        const selected = (state.data.accounts ?? []).filter((account) => accountIds.includes(account.id));
        const includesCurrent = selected.some((account) => account.current);
        const warning = [
          `确认完整转移 ${accountIds.length} 个账号？`,
          "",
          "导出前会主动刷新 Token。生成文件后，本机账号将标记为“已转出”，停止刷新、切换和唤醒。",
          includesCurrent ? "当前账号将被切换或退出登录，Codex 随后会重启。" : "",
          "迁移文件包含明文敏感凭据，请只交给目标设备。",
        ].filter(Boolean).join("\n");
        if (!window.confirm(warning)) return;
      }
      event.currentTarget.querySelector(".migration-submit").disabled = true;
      enqueue({ type: "account-transfer", mode: state.migrationMode, accountIds });
    });
}

  return { renderMigrationPage, bindMigrationEvents };
}

export { createMigration };
