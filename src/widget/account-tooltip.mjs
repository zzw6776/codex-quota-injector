function createAccountTooltip(dependencies) {
  const { ACCOUNT_TOOLTIP_DELAY_MS, state } = dependencies;


function hideAccountTooltip() {
    window.clearTimeout(state.accountTooltipTimer);
    state.accountTooltipTimer = null;
    state.shadow?.querySelector(".account-tooltip")?.remove();
  }

function scheduleAccountTooltip(button) {
    hideAccountTooltip();
    state.accountTooltipTimer = window.setTimeout(() => {
      state.accountTooltipTimer = null;
      if (!button.isConnected || !state.pinned || state.dismissed) return;
      const panel = button.closest(".quota-popover");
      if (!panel) return;
      const tooltip = document.createElement("div");
      tooltip.className = "account-tooltip";
      tooltip.setAttribute("role", "tooltip");
      tooltip.setAttribute("popover", "manual");
      tooltip.textContent = button.dataset.accountTooltip;
      panel.append(tooltip);
      tooltip.showPopover();
      const anchor = button.getBoundingClientRect();
      const bounds = tooltip.getBoundingClientRect();
      const left = Math.max(12, Math.min(window.innerWidth - bounds.width - 12,
        anchor.left + (anchor.width - bounds.width) / 2));
      const above = anchor.top - bounds.height - 6;
      const top = above >= 12 ? above : Math.max(12,
        Math.min(window.innerHeight - bounds.height - 12, anchor.bottom + 6));
      tooltip.style.left = `${Math.round(left)}px`;
      tooltip.style.top = `${Math.round(top)}px`;
    }, ACCOUNT_TOOLTIP_DELAY_MS);
  }

  return { hideAccountTooltip, scheduleAccountTooltip };
}

export { createAccountTooltip };
