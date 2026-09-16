// Browser-serializable factory: all external values arrive through this explicit boundary.
function createTooltipPosition({ CONVERSATION_TOOLTIP_DELAY_MS, state, showConversationTokenTooltip }) {
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
      "box-sizing:border-box",
      "width:min(420px,calc(100vw - 24px))",
      "min-width:0",
      "max-width:calc(100vw - 24px)",
      "overflow-x:clip",
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

  return { scheduleConversationTokenTooltip, moveConversationTokenTooltip, conversationTooltipPointer, ensureConversationTokenTooltip, positionConversationTokenTooltip, isConversationTooltipArea, hideConversationTokenTooltip, clearConversationTooltipTimer };
}

export { createTooltipPosition };
