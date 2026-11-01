import assert from "node:assert/strict";
import test from "node:test";

import { MAX_STORED_TURN_SUMMARIES } from "../src/token-usage/contract.mjs";
import { createConversationUsage } from "../src/widget/conversation-usage.mjs";
import { MAX_CONVERSATION_USAGE_CACHE } from "../src/widget/contract.mjs";

test("页面逐回合缓存覆盖后端轻量摘要上限", () => {
  assert.equal(MAX_CONVERSATION_USAGE_CACHE, MAX_STORED_TURN_SUMMARIES * 2);
  const state = {
    data: {
      tokenUsage: {
        status: "ready",
        turns: Array.from({ length: MAX_CONVERSATION_USAGE_CACHE }, (_, index) => ({
          turnId: `turn-${index}`,
          updatedAt: index,
        })),
      },
    },
    conversationRenderFrame: null,
    conversationUsageByTurn: new Map(),
    conversationTurnNodes: new Map(),
    conversationUsageLines: new Map(),
    conversationDomDirty: false,
  };
  const previousWindow = globalThis.window;
  globalThis.window = {
    requestAnimationFrame(callback) {
      callback();
      return 1;
    },
  };
  try {
    const usage = createConversationUsage({
      usageSummaryText: () => "",
      selectNetworkLatency: () => null,
      MAX_CONVERSATION_USAGE_CACHE,
      state,
      showConversationTokenTooltip: () => {},
      scheduleConversationTokenTooltip: () => {},
      moveConversationTokenTooltip: () => {},
      isConversationTooltipArea: () => false,
      hideConversationTokenTooltip: () => {},
      formatTokenCount: String,
      conversationTurnSelector: "[data-content-search-turn-key]",
    });
    usage.scheduleConversationTokenUsageRender();
    assert.equal(state.conversationUsageByTurn.size, MAX_CONVERSATION_USAGE_CACHE);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
