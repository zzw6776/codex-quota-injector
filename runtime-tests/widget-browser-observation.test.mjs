import assert from "node:assert/strict";
import test from "node:test";
import { fixtureData, SHADOW, startBrowser } from "./support/browser.mjs";

const usage = { status: "ready", turns: [{ turnId: "turn-a", totalTokens: 100,
  inputTokens: 90, outputTokens: 10, updatedAt: 1, completed: false, cost: { available: false } }] };

test("[OBS-01 UI-03] 流式正文和无关 DOM 变化不再逐帧扫描会话根节点", { timeout: 30_000 }, async t => {
  const b = await startBrowser(t);
  await b.update(fixtureData({ tokenUsage: usage }));
  const result = await b.client.evaluate(`(async () => {
    const originalQuery = document.querySelector;
    const originalQueryAll = document.querySelectorAll;
    let scans = 0;
    document.querySelector = function(selector) {
      if (selector === '[data-content-search-turn-key]') scans++;
      return originalQuery.call(this, selector);
    };
    document.querySelectorAll = function(selector) {
      if (selector === '[data-content-search-turn-key]') scans++;
      return originalQueryAll.call(this, selector);
    };
    const line = document.querySelector('[data-codex-token-usage="turn-a"]');
    try {
      for (let i = 0; i < 6; i++) {
        const word = document.createElement('span');
        word.textContent = 'stream ' + i;
        document.getElementById('conversation').querySelector('.answer').prepend(word);
        const unrelated = document.createElement('div');
        document.getElementById('native').append(unrelated);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        unrelated.remove();
      }
      return { scans, retained: line === document.querySelector('[data-codex-token-usage="turn-a"]'), tokens: line.__codexTokenUsage.totalTokens };
    } finally {
      document.querySelector = originalQuery;
      document.querySelectorAll = originalQueryAll;
    }
  })()`);
  assert.equal(result.scans, 0, "已有用量行的流式正文无需重新发现会话根");
  assert.equal(result.retained, true);
  assert.equal(result.tokens, 100);
});

test("[OBS-01 UI-03] 同一观察器恢复会话子树重建、侧栏重建及延迟出现的回合", { timeout: 30_000 }, async t => {
  const b = await startBrowser(t);
  await b.update(fixtureData({ tokenUsage: usage }));
  await b.client.evaluate(`(() => {
    const conversation = document.getElementById('conversation');
    const old = conversation.firstElementChild;
    const replacement = document.createElement('article');
    replacement.setAttribute('data-content-search-turn-key', 'turn-a');
    replacement.innerHTML = '<div class="answer">重建后的内容</div>';
    old.replaceWith(replacement);
    const profile = document.getElementById('profile-row');
    profile.replaceWith(profile.cloneNode(true));
    document.getElementById('codex-quota-injector-root')?.remove();
  })()`);
  await b.settled();
  assert.equal(await b.client.evaluate('document.querySelectorAll("[data-codex-token-usage]").length'), 1);
  assert.equal(await b.client.evaluate(`document.querySelector('[data-codex-token-usage]').closest('article').textContent.includes('重建后的内容')`), true);
  assert.equal(await b.value('.panel-version-text'), 'vtest');
  await b.client.evaluate(`document.getElementById('conversation').replaceChildren()`);
  await b.settled();
  assert.equal(await b.client.evaluate('document.querySelectorAll("[data-codex-token-usage]").length'), 0);
  await b.client.evaluate(`document.getElementById('conversation').innerHTML = '<article data-content-search-turn-key="turn-a"><div>延迟出现</div></article>'`);
  await b.settled();
  assert.equal(await b.client.evaluate('document.querySelectorAll("[data-codex-token-usage]").length'), 1);
  await b.click('.quota-chip');
  await b.click('.refresh-all');
  assert.deepEqual((await b.drain()).map(action => action.type), ['refresh-all']);
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelectorAll('.quota-chip').length`), 1);
});
