import assert from "node:assert/strict";
import test from "node:test";
import { createWidgetSession } from "../src/injector/widget-session.mjs";
import * as widget from "../src/widget.mjs";
import { fixtureData, startBrowser } from "./support/browser.mjs";

test("[UI-03 OBS-01] 真实页面接收同批多通道更新，重连和重装均恢复完整数据", { timeout: 30_000 }, async t => {
  const b = await startBrowser(t);
  let data = fixtureData({ tokenUsage: { status: 'ready', turns: [{ turnId: 'turn-a',
    totalTokens: 100, inputTokens: 90, outputTokens: 10, updatedAt: 1 }] } });
  let sends = 0;
  const cdp = { get isConnected() { return b.client.isConnected; }, evaluate(expression) {
    sends++;
    return b.client.evaluate(expression);
  } };
  const session = createWidgetSession({
    cdp, widget, appDisplayVersion: 'session-test', injectionMode: null,
    accountManager: { getViewModel: () => data },
    contextManager: { getViewModel: () => data.context },
    extraModelManager: { getViewModel: () => data.extraModels },
    modelRouterManager: { getNetworkViewModel: () => data.network },
    tokenUsageManager: { getViewModel: () => data.tokenUsage },
    wakeupManager: { getViewModel: () => null },
  });
  await b.client.evaluate('window.__codexQuotaWidget.update({version:"old-sender"}, 1)');
  assert.equal(await session.requestWidgetUpdate(), true);
  await b.settled();
  assert.equal(await b.value('.panel-version-text'), 'vsession-test');
  assert.deepEqual(await b.client.evaluate('[...document.querySelectorAll("[data-codex-token-usage]")].map(line => line.dataset.codexTokenUsage)'), ['turn-a']);
  sends = 0;
  data = { ...data, windows: [{ remainingPercent: 42 }], network: { latencyMs: 888 },
    tokenUsage: { status: 'ready', turns: [{ turnId: 'turn-b', totalTokens: 200,
      inputTokens: 180, outputTokens: 20, updatedAt: 2 }] } };
  session.markWidgetDataDirty();
  await session.requestWidgetUpdate();
  assert.equal(sends, 1);
  await b.settled();
  assert.match(await b.value('.quota-chip'), /42%/);
  assert.deepEqual(await b.client.evaluate('[...document.querySelectorAll("[data-codex-token-usage]")].map(line => line.dataset.codexTokenUsage)'), ['turn-b']);
  // A surviving page may have changes that were not produced by this sender.
  await b.client.evaluate('window.__codexQuotaWidget.update({windows:[{remainingPercent:5}],tokenUsage:{status:"ready",turns:[]}})');
  session.reset();
  await session.requestWidgetUpdate();
  await b.settled();
  assert.match(await b.value('.quota-chip'), /42%/);
  assert.equal(await b.client.evaluate('document.querySelectorAll("[data-codex-token-usage]").length'), 1);
  await b.client.evaluate('window.__codexQuotaWidget.destroy()');
  data = { ...data, windows: [{ remainingPercent: 33 }] };
  session.markWidgetDataDirty();
  assert.equal(await session.requestWidgetUpdate(), true);
  await b.settled();
  assert.equal(await b.client.evaluate(widget.widgetRuntimeVersionExpression()), widget.WIDGET_RUNTIME_VERSION);
  assert.match(await b.value('.quota-chip'), /33%/);
  assert.equal(await b.client.evaluate('document.querySelectorAll("[data-codex-token-usage]").length'), 1);
});
