function createBalance(dependencies) {
  const { state } = dependencies;
  const escapeHtml = (...args) => dependencies.escapeHtml(...args);

function currentDeepSeekBalanceView() {
    const extraModels = state.data.extraModels ?? {};
    const managed = extraModels.platforms?.find?.((platform) =>
      platform?.preset === "deepseek" && platform?.apiKey);
    const balance = extraModels.deepSeekBalance ?? {};
    return {
      configured: Boolean(managed),
      balance: balance.balance ?? null,
      updatedAt: balance.updatedAt ?? null,
      error: balance.error ?? null,
      refreshing: Boolean(balance.refreshing),
    };
  }

function renderPanelBalance() {
    const accounts = Array.isArray(state.data.accounts) ? state.data.accounts : [];
    const currentAccount = accounts.find((account) => account.current) ?? accounts[0] ?? null;
    const credits = currentAccount?.credits ?? state.data.credits ?? null;
    const codexBalance = !credits
      ? ""
      : credits.unlimited
        ? "无限"
        : credits.formattedUsd ||
          (Number.isFinite(credits.creditQuantity) ? `${credits.creditQuantity} 点` : "");
    const deepSeekBalance = (currentDeepSeekBalanceView().balance?.items ?? [])
      .map((item) => `${escapeHtml(item.currency)} ${escapeHtml(item.totalBalance)}`)
      .join(" · ");
    const items = [];
    if (codexBalance) items.push(`Codex 余额 ${escapeHtml(codexBalance)}`);
    if (deepSeekBalance) items.push(`DeepSeek 余额 ${deepSeekBalance}`);
    return items.length
      ? `<span class="panel-balance">${items.join(" · ")}</span>`
      : "";
  }

function patchPanelBalance(wrap) {
    const current = wrap.querySelector(".panel-balance");
    const next = renderPanelBalance();
    if (current) {
      if (next) current.outerHTML = next;
      else current.remove();
    } else if (next) {
      wrap.querySelector(".panel-version-text")?.insertAdjacentHTML("beforebegin", next);
    }
  }

  return { currentDeepSeekBalanceView, renderPanelBalance, patchPanelBalance };
}

export { createBalance };
