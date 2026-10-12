import assert from "node:assert/strict";
import test from "node:test";
import { SHADOW, startBrowser, fixtureData } from "./support/browser.mjs";
import { waitFor } from "../test/helpers.mjs";
import { startUpdateWindowServer } from "../src/app-update/window.mjs";

test("新旧额度入口小绿点不占行，右下角更新按钮在局部刷新后仍有效且保留表单", { timeout: 30_000 }, async t => {
  const b = await startBrowser(t);
  const update = { available: true, version: "0.1.295" };
  await b.update(fixtureData({ appUpdate: update }));
  await b.click('.quota-chip');
  assert.equal(await b.value('.app-update-open'), 'vtest → v0.1.295');
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelectorAll('.app-update-dot').length`), 1);
  await b.client.evaluate(`window.keptInput=${SHADOW}.querySelector('.api-key-form input[name="name"]');keptInput.value='kept';`);
  await b.update(fixtureData({ appUpdate: { ...update, version: "0.1.296" } }));
  assert.equal(await b.value('.app-update-open'), 'vtest → v0.1.296');
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelector('.api-key-form input[name="name"]')===keptInput`), true);
  await b.click('.app-update-open');
  assert.equal(await b.value('.app-update-open'), '正在打开更新窗口…');
  assert.equal(await b.value('.app-update-open', 'disabled'), true);
  const actions = await b.drain();
  assert.deepEqual(actions.map(({ type }) => ({ type })), [{ type: "app-update-open" }]);
  assert.ok(actions[0].requestId);
  await b.update(fixtureData({ appUpdate: { ...update, version: "0.1.296" } }));
  assert.equal(await b.value('.app-update-open', 'disabled'), true, '无关刷新不能清除尚未收到响应的点击');
  await b.update(fixtureData({ appUpdate: { ...update, version: "0.1.296", requestId: actions[0].requestId, opening: false } }));
  assert.equal(await b.value('.app-update-open', 'disabled'), false);
  assert.equal(await b.value('.app-update-open'), 'vtest → v0.1.296');
  await b.client.evaluate(`(()=>{const rail=document.createElement('nav');rail.setAttribute('data-app-navigation-rail','true');rail.style.cssText='position:fixed;top:40px;bottom:8px;left:0;width:52px;display:flex;flex-direction:column';const spacer=document.createElement('div');spacer.style.flex='1';const row=document.getElementById('profile-row');row.style.cssText='position:static;width:36px';rail.append(spacer,row);document.body.append(rail)})()`);
  await b.settled();
  assert.equal(await b.client.evaluate(`document.getElementById('codex-quota-injector-root').dataset.layout`), 'rail');
  assert.equal(await b.value('.app-update-open'), 'vtest → v0.1.296');
  const rect = await b.client.evaluate(`(()=>{const q=${SHADOW}.querySelector('.quota-chip').getBoundingClientRect(),d=${SHADOW}.querySelector('.app-update-dot').getBoundingClientRect();return {chipWidth:q.width,dotWidth:d.width,within:d.left>=q.left&&d.right<=q.right,position:getComputedStyle(${SHADOW}.querySelector('.app-update-dot')).position}})()`);
  assert.equal(rect.chipWidth, 36); assert.equal(rect.dotWidth, 5); assert.equal(rect.within, true); assert.equal(rect.position, 'absolute');
  await b.update(fixtureData({ appUpdate: { available: false } }));
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelector('.app-update-dot')`), null);
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelector('.app-update-open')`), null);
});

test("独立更新页面原地显示进度与终态；没有自动关闭，失败原因不会执行 HTML", { timeout: 30_000 }, async t => {
  const b = await startBrowser(t);
  let state = { status: "confirm", mode: "dev", currentVersion: "0.1.308", version: "0.1.295", message: "是否更新？", total: 100, received: 0 };
  let confirmed = 0, closed = 0;
  const window = await startUpdateWindowServer({ port: 0, state: () => state,
    confirm: () => { confirmed++; state = { ...state, status: "downloading", received: 50, message: "下载中" }; },
    close: () => { closed++; } });
  t.after(() => window.close());
  await b.client.request('Page.navigate', { url: window.url });
  await waitFor(() => b.client.evaluate(`document.querySelector('.primary')?.textContent==='立即更新'`));
  await waitFor(async () => (await fetch(`${window.url}state`).then(response => response.json())).windowReady === true);
  await b.client.evaluate(`document.querySelector('.primary').click()`);
  await waitFor(() => b.client.evaluate(`document.body.textContent.includes('50%')`));
  assert.equal(confirmed, 1);
  assert.equal(await b.client.evaluate(`document.querySelector('button').disabled`), true);
  state = { ...state, status: "launching", message: "已替换，等待正式版启动" };
  await waitFor(() => b.client.evaluate(`document.body.textContent.includes('等待正式版启动')`));
  assert.equal(closed, 0);
  state = { ...state, status: "success", message: "更新成功" };
  await waitFor(() => b.client.evaluate(`document.body.textContent.includes('窗口将保留')`));
  assert.equal(closed, 0);
  assert.equal(await b.client.evaluate(`document.querySelector('button').disabled`), false);
  state = { ...state, status: "failed", message: '<img src=x onerror="window.injected=true">下载失败' };
  await waitFor(() => b.client.evaluate(`document.body.textContent.includes('下载失败')`));
  assert.equal(await b.client.evaluate(`window.injected===true`), false);
  assert.equal(closed, 0);
});
