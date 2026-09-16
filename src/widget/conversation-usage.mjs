// Browser-serializable factory: all external values arrive through this explicit boundary.
function createConversationUsage({ usageSummaryText, selectNetworkLatency, MAX_CONVERSATION_USAGE_CACHE, state, showConversationTokenTooltip, scheduleConversationTokenTooltip, moveConversationTokenTooltip, isConversationTooltipArea, hideConversationTokenTooltip, formatTokenCount, conversationTurnSelector }) {
  function scheduleConversationTokenUsageRender() {
    if (state.conversationRenderFrame != null) return;
    state.conversationRenderFrame = window.requestAnimationFrame(() => {
      state.conversationRenderFrame = null;
      renderConversationTokenUsage();
    });
  }

  function placeConversationTokenUsageLine(line, host) {
    if (!line || !host) return;
    let footer = [...host.children].find((child) =>
      child.matches?.("[data-codex-token-usage-footer]"));
    if (!footer) {
      footer = document.createElement("div");
      footer.setAttribute("data-codex-token-usage-footer", "");
      footer.style.cssText = "display:block;width:100%;margin-top:2px";
    }
    if (footer.parentElement !== host || footer !== host.lastElementChild) host.append(footer);
    if (line.parentElement !== footer) footer.append(line);
  }

  function renderConversationTokenUsage() {
    const incomingUsageItems = Array.isArray(state.data.tokenUsage?.turns)
      ? state.data.tokenUsage.turns
      : [];
    const incomingIds = new Set();
    for (const usage of incomingUsageItems) {
      const turnId = String(usage?.turnId ?? "");
      if (turnId) {
        incomingIds.add(turnId);
        state.conversationUsageByTurn.set(turnId, usage);
      }
    }
    if (incomingIds.size > 0) {
      for (const turnId of state.conversationUsageByTurn.keys()) {
        if (!incomingIds.has(turnId)) state.conversationUsageByTurn.delete(turnId);
      }
    } else if (state.data.tokenUsage?.status === "ready") {
      state.conversationUsageByTurn.clear();
    }
    if (state.conversationUsageByTurn.size > MAX_CONVERSATION_USAGE_CACHE) {
      const retained = [...state.conversationUsageByTurn.values()]
        .sort((left, right) => Number(left.updatedAt) - Number(right.updatedAt))
        .slice(-MAX_CONVERSATION_USAGE_CACHE);
      state.conversationUsageByTurn = new Map(
        retained.map((usage) => [String(usage.turnId), usage]),
      );
    }
    const usageGroups = new Map();
    for (const usage of [...state.conversationUsageByTurn.values()]
      .sort((left, right) => Number(left?.updatedAt) - Number(right?.updatedAt))) {
      const hostTurnId = String(usage?.isSubagentSummary ? usage.parentTurnId : usage?.turnId ?? "");
      const group = usageGroups.get(hostTurnId) ?? [];
      group.push(usage);
      usageGroups.set(hostTurnId, group);
    }
    const usageItems = [...usageGroups.values()].flatMap((group) => group.sort((left, right) =>
      Number(Boolean(left?.completed)) - Number(Boolean(right?.completed)) ||
      Number(Boolean(left?.isSubagentSummary)) - Number(Boolean(right?.isSubagentSummary)) ||
      Number(left?.updatedAt) - Number(right?.updatedAt)));
    bindConversationObserver();
    if (state.conversationDomDirty) {
      state.conversationTurnNodes = new Map([...document.querySelectorAll("[data-content-search-turn-key]")]
        .map((node) => [node.getAttribute("data-content-search-turn-key"), node]));
      state.conversationDomDirty = false;
    }
    const turnNodes = state.conversationTurnNodes;
    const visibleTurnIds = new Set();

    for (const usage of usageItems) {
      const turnId = String(usage?.turnId ?? "");
      const hostTurnId = String(usage?.isSubagentSummary ? usage.parentTurnId : turnId);
      const turnNode = turnNodes.get(hostTurnId);
      if (!turnId || !turnNode) continue;
      visibleTurnIds.add(turnId);
      const host = turnNode.firstElementChild ?? turnNode;
      let line = state.conversationUsageLines.get(turnId);
      if (!line?.isConnected) {
        line = [...turnNode.querySelectorAll("[data-codex-token-usage]")]
          .find((candidate) => candidate.getAttribute("data-codex-token-usage") === turnId);
      }
      if (!line) {
        line = document.createElement("div");
        line.setAttribute("data-codex-token-usage", turnId);
        line.setAttribute("role", "status");
        line.setAttribute("tabindex", "0");
        line.style.cssText = [
          "align-self:flex-start",
          "margin-top:6px",
          "max-width:100%",
          "color:var(--color-token-text-tertiary, #777780)",
          "font:500 11px/16px ui-sans-serif,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
          "font-variant-numeric:tabular-nums",
          "white-space:normal",
          "overflow-wrap:anywhere",
          "opacity:.82",
          "user-select:text",
        ].join(";");
        line.addEventListener("pointerenter", (event) => scheduleConversationTokenTooltip(line, event));
        line.addEventListener("pointermove", (event) => moveConversationTokenTooltip(line, event));
        line.addEventListener("pointerleave", (event) => {
          if (!isConversationTooltipArea(event.relatedTarget)) hideConversationTokenTooltip(line);
        });
        line.addEventListener("focus", () => showConversationTokenTooltip(line));
        line.addEventListener("blur", () => hideConversationTokenTooltip(line));
      }
      state.conversationUsageLines.set(turnId, line);
      placeConversationTokenUsageLine(line, host);
      line.__codexTokenUsage = usage;
      line.style.marginLeft = "0";
      const subagentLabel = conversationSubagentLabel(usage);
      const hasUsage = Number(usage.totalTokens) > 0;
      if (!hasUsage) {
        const statusText = usage.completed
          ? "本轮未获取到 Token 数据 · 价格无法计算"
          : "等待 Token 数据 · 价格待计算";
        const summary = subagentLabel ? `${subagentLabel} · ${statusText}` : statusText;
        if (line.textContent !== summary) line.textContent = summary;
        line.removeAttribute("title");
        if (line.getAttribute("aria-label") !== summary) line.setAttribute("aria-label", summary);
        continue;
      }
      const networkLatency = selectNetworkLatency(usage, state.data.network);
      const summary = usageSummaryText(usage, networkLatency, subagentLabel);
      if (line.textContent !== summary) line.textContent = summary;
      line.removeAttribute("title");
      const accessibilitySummary = `${summary}；缓存写入 ${formatTokenCount(usage.cacheWriteInputTokens)}；推理输出 ${formatTokenCount(usage.reasoningOutputTokens)}`;
      if (line.getAttribute("aria-label") !== accessibilitySummary) {
        line.setAttribute("aria-label", accessibilitySummary);
      }
    }

    for (const [turnId, line] of state.conversationUsageLines) {
      if (!visibleTurnIds.has(turnId) || !line.isConnected) {
        hideConversationTokenTooltip(line);
        const footer = line.parentElement?.matches?.("[data-codex-token-usage-footer]")
          ? line.parentElement
          : null;
        line.remove();
        if (footer && footer.childElementCount === 0) footer.remove();
        state.conversationUsageLines.delete(turnId);
      }
    }
  }

  function conversationSubagentLabel(usage) {
    if (!usage?.isSubagent) return "";
    const nickname = String(usage.agentNickname ?? "").trim();
    const path = String(usage.agentPath ?? "").trim();
    const pathName = path.split("/").filter(Boolean).at(-1) ?? "";
    const identity = nickname || pathName;
    const depth = Math.max(1, Number(usage.agentDepth) || 1);
    return `${depth > 1 ? `子智能体 L${depth}` : "子智能体"}${identity ? ` ${identity}` : ""}`;
  }

  function findConversationObserverRoot() {
    const firstTurn = document.querySelector(conversationTurnSelector);
    if (!firstTurn) return null;
    let candidate = firstTurn.parentElement;
    while (candidate && candidate !== document.body) {
      if (candidate.querySelectorAll(conversationTurnSelector).length > 1) return candidate;
      candidate = candidate.parentElement;
    }
    return firstTurn.parentElement;
  }

  function bindConversationObserver() {
    if (state.conversationObserverRoot?.isConnected) return;
    const root = findConversationObserverRoot();
    if (root === state.conversationObserverRoot) return;
    state.observer?.disconnect();
    state.conversationObserverRoot = root;
    if (root) {
      state.observer?.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-content-search-turn-key"],
      });
    }
  }

  function mutationTouchesConversation(mutations) {
    return mutations.some((mutation) => {
      if (mutation.type === "attributes" &&
        mutation.attributeName === "data-content-search-turn-key") return true;
      const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes]
        .filter((node) => node.nodeType === Node.ELEMENT_NODE);
      if (changedNodes.length > 0 && changedNodes.every((node) =>
        node.matches?.("[data-codex-token-usage], [data-codex-token-usage-footer]"))) {
        return false;
      }
      const target = mutation.target;
      if (target?.closest?.("[data-codex-token-usage], [data-codex-token-usage-footer]")) return false;
      const turnTarget = target?.closest?.(conversationTurnSelector);
      if (turnTarget) {
        const turnId = turnTarget.getAttribute("data-content-search-turn-key");
        return !state.conversationUsageLines.get(turnId)?.isConnected;
      }
      return changedNodes.some((node) =>
        node.matches?.(conversationTurnSelector) ||
        node.querySelector?.(conversationTurnSelector));
    });
  }

  return { scheduleConversationTokenUsageRender, conversationSubagentLabel, mutationTouchesConversation };
}

export { createConversationUsage };
