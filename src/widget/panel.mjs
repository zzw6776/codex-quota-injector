// Browser-serializable factory: all external values arrive through this explicit boundary.
function createPanel({ calculateMaxHeight, state, render, enqueue, ACCOUNT_TOOLTIP_DELAY_MS }) {
  function positionPopover(wrap) {
    const chip = wrap.querySelector(".quota-chip");
    const popover = wrap.querySelector(".quota-popover");
    if (!chip || !popover) return;
    const chipRect = chip.getBoundingClientRect();
    const availableHeight = calculateMaxHeight(chipRect.top);
    popover.style.bottom = `${Math.max(12, window.innerHeight - chipRect.top + 10)}px`;
    popover.style.maxHeight = `${availableHeight}px`;
    if (popover.classList.contains("detail-popover")) {
      applyDetailPanelSize(wrap, popover);
    } else {
      popover.style.removeProperty("width");
      popover.style.removeProperty("height");
    }
  }

  function captureDetailPanelBaseSize(wrap) {
    const popover = wrap.querySelector(".quota-popover");
    if (!popover) return;
    const width = Math.max(1, Math.round(popover.offsetWidth));
    const height = Math.max(1, Math.round(popover.offsetHeight));
    state.detailPanelBaseSize = { width, height };
    state.detailPanelSize = { width, height };
    state.detailPanelResize = null;
  }

  function resetDetailPanelSize() {
    cancelDetailPanelResize();
    state.detailPanelBaseSize = null;
    state.detailPanelSize = null;
  }

  function cancelDetailPanelResize() {
    state.detailPanelResizeCleanup?.();
    state.detailPanelResizeCleanup = null;
    state.detailPanelResize = null;
  }

  function detailPanelBounds(wrap) {
    const chip = wrap.querySelector(".quota-chip");
    return {
      maxWidth: Math.max(0, Math.floor(window.innerWidth - 24)),
      maxHeight: chip ? calculateMaxHeight(chip.getBoundingClientRect().top) : 0,
    };
  }

  function applyDetailPanelSize(wrap, popover, requested = state.detailPanelSize) {
    const base = state.detailPanelBaseSize;
    if (!base) return;
    const bounds = detailPanelBounds(wrap);
    const minimumWidth = Math.min(base.width, bounds.maxWidth);
    const minimumHeight = Math.min(base.height, bounds.maxHeight);
    const width = Math.min(bounds.maxWidth, Math.max(minimumWidth, requested?.width ?? base.width));
    const height = Math.min(bounds.maxHeight, Math.max(minimumHeight, requested?.height ?? base.height));
    popover.style.width = `${width}px`;
    popover.style.height = `${height}px`;
    return { width, height };
  }

  function bindDetailPanelResize(wrap) {
    const panel = wrap.querySelector(".detail-popover");
    if (!panel || !state.detailPanelBaseSize) return;
    const resizeEdge = (event) => {
      const bounds = panel.getBoundingClientRect();
      const top = event.clientY >= bounds.top && event.clientY <= bounds.top + 8;
      const right = event.clientX >= bounds.right - 8 && event.clientX <= bounds.right;
      return top && right ? "top-right" : top ? "top" : right ? "right" : null;
    };
    const resizeCursor = (edge) => edge === "top-right"
      ? "nesw-resize"
      : edge === "top" ? "ns-resize" : edge === "right" ? "ew-resize" : "";
    const drag = (event) => {
      const resize = state.detailPanelResize;
      if (!resize) return;
      const next = applyDetailPanelSize(wrap, panel, {
        width: resize.edge.includes("right")
          ? resize.startWidth + event.clientX - resize.startX
          : resize.startWidth,
        height: resize.edge.includes("top")
          ? resize.startHeight + resize.startY - event.clientY
          : resize.startHeight,
      });
      if (next) state.detailPanelSize = next;
      event.preventDefault();
    };
    const finish = (event) => {
      if (!state.detailPanelResize) return;
      cancelDetailPanelResize();
      panel.style.cursor = resizeCursor(resizeEdge(event));
      event.preventDefault();
      if (state.panelRefreshPending) render({ background: true });
    };
    panel.addEventListener("mousemove", (event) => {
      if (!state.detailPanelResize) panel.style.cursor = resizeCursor(resizeEdge(event));
    });
    panel.addEventListener("mouseleave", () => {
      if (!state.detailPanelResize) panel.style.cursor = "";
    });
    panel.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      const edge = resizeEdge(event);
      if (!edge) return;
      cancelDetailPanelResize();
      state.detailPanelResize = {
        edge,
        startX: event.clientX,
        startY: event.clientY,
        startWidth: panel.offsetWidth,
        startHeight: panel.offsetHeight,
      };
      window.addEventListener("mousemove", drag, true);
      window.addEventListener("mouseup", finish, true);
      state.detailPanelResizeCleanup = () => {
        window.removeEventListener("mousemove", drag, true);
        window.removeEventListener("mouseup", finish, true);
      };
      event.preventDefault();
      event.stopPropagation();
    });
  }

  function dismissPanel() {
    hideAccountTooltip();
    const wrap = state.shadow?.querySelector(".quota-wrap");
    const scroller = wrap?.querySelector(".panel-scroll");
    if (!state.dismissed && scroller) state.panelScrollPosition = {
      page: state.page, top: scroller.scrollTop, left: scroller.scrollLeft,
    };
    state.pinned = false;
    state.dismissed = true;
    cancelDetailPanelResize();
    state.detailPanelSize = null;
    wrap?.classList.remove("is-open");
    wrap?.classList.add("is-dismissed");
  }

  function bindGeneralEvents(wrap) {
bindDetailPanelResize(wrap);
wrap.querySelector(".host-health-recheck")?.addEventListener("click", () => {
      enqueue({ type: "host-health-recheck" });
    });
wrap.querySelector(".host-health-restart")?.addEventListener("click", (event) => {
      event.currentTarget.disabled = true;
      enqueue({ type: "host-health-restart" });
    });
wrap.querySelector(".host-health-open-logs")?.addEventListener("click", (event) => {
      event.currentTarget.disabled = true;
      enqueue({ type: "host-health-open-logs" });
    });
wrap.querySelectorAll("[data-account-tooltip]").forEach((button) => {
      button.addEventListener("pointerenter", () => scheduleAccountTooltip(button));
      button.addEventListener("focus", () => scheduleAccountTooltip(button));
      button.addEventListener("pointerleave", hideAccountTooltip);
      button.addEventListener("blur", hideAccountTooltip);
      button.addEventListener("pointerdown", hideAccountTooltip);
      button.addEventListener("keydown", (event) => {
        if (event.key === "Escape") hideAccountTooltip();
      });
    });
wrap.querySelector(".panel-scroll")?.addEventListener("scroll", hideAccountTooltip, { passive: true });
}

  function bindPanelEvents(wrap) {
const chip = wrap.querySelector(".quota-chip");
chip?.addEventListener("click", () => {
      if (state.pinned && !state.dismissed) { dismissPanel(); return; }
      state.dismissed = false;
      state.pinned = true;
      wrap.classList.remove("is-dismissed");
      wrap.classList.add("is-open");
      if (state.panelRefreshPending) render({ background: true });
      positionPopover(wrap);
      const scroller = wrap.querySelector(".panel-scroll");
      if (scroller && state.panelScrollPosition?.page === state.page) {
        scroller.scrollTop = state.panelScrollPosition.top;
        scroller.scrollLeft = state.panelScrollPosition.left;
      }
    });
wrap.querySelector(".close-panel")?.addEventListener("click", () => {
      dismissPanel();
    });
}

  function hideAccountTooltip() {
    window.clearTimeout(state.accountTooltipTimer);
    state.accountTooltipTimer = null;
    state.shadow?.querySelector(".account-tooltip")?.remove();
  }

  // Only used when a real panel change requires reconstruction. Ordinary
  // quota updates keep the account import forms in place.
  function preservePanelInputs(wrap) {
    const snapshots = [...wrap.querySelectorAll(".token-form, .api-key-form, .context-edit-form")]
      .filter((form) => !form.hidden)
      .map((form) => ({
        selector: `.${form.classList[0]}${form.dataset.slug ? `[data-slug="${CSS.escape(form.dataset.slug)}"]` : ""}`,
        outerOpen: form.closest("details")?.open,
        details: [...form.querySelectorAll("details")].map((node) => node.open),
        fields: [...form.querySelectorAll("input[name], textarea[name]")].map((input) => ({
          name: input.name, value: input.value,
          focused: state.shadow.activeElement === input,
          start: input.selectionStart, end: input.selectionEnd,
          direction: input.selectionDirection,
        })),
      }));
    return () => {
      for (const snapshot of snapshots) {
        const form = wrap.querySelector(snapshot.selector);
        if (!form || form.hidden) continue;
        const outer = form.closest("details");
        if (outer && snapshot.outerOpen != null) outer.open = snapshot.outerOpen;
        form.querySelectorAll("details").forEach((node, index) => { node.open = snapshot.details[index]; });
        for (const field of snapshot.fields) {
          const input = form.querySelector(`[name="${CSS.escape(field.name)}"]`);
          if (!input) continue;
          input.value = field.value;
          if (field.focused) {
            input.focus({ preventScroll: true });
            if (field.start != null) input.setSelectionRange(field.start, field.end, field.direction);
          }
        }
      }
    };
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

  return { positionPopover, captureDetailPanelBaseSize, resetDetailPanelSize, cancelDetailPanelResize, dismissPanel, bindGeneralEvents, bindPanelEvents, hideAccountTooltip, preservePanelInputs };
}

export { createPanel };
