function createPanelLayout(dependencies) {
  const { calculateMaxHeight, state } = dependencies;
  const hideAccountTooltip = (...args) => dependencies.hideAccountTooltip(...args);

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

  return { positionPopover, captureDetailPanelBaseSize, resetDetailPanelSize, cancelDetailPanelResize, detailPanelBounds, applyDetailPanelSize, bindDetailPanelResize, dismissPanel };
}

export { createPanelLayout };
