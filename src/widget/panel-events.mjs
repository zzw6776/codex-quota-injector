function createPanelEvents(dependencies) {
  const { state } = dependencies;
  const positionPopover = (...args) => dependencies.positionPopover(...args);
  const hideAccountTooltip = (...args) => dependencies.hideAccountTooltip(...args);
  const scheduleAccountTooltip = (...args) => dependencies.scheduleAccountTooltip(...args);
  const bindDetailPanelResize = (...args) => dependencies.bindDetailPanelResize(...args);
  const enqueue = (...args) => dependencies.enqueue(...args);
  const dismissPanel = (...args) => dependencies.dismissPanel(...args);

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

  return { bindGeneralEvents, bindPanelEvents };
}

export { createPanelEvents };
