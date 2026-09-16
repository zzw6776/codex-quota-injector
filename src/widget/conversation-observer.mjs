function createConversationObserver(dependencies) {
  const { state, conversationTurnSelector } = dependencies;


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

  return { findConversationObserverRoot, bindConversationObserver, mutationTouchesConversation };
}

export { createConversationObserver };
