import assert from "node:assert/strict";
import test from "node:test";
import { SHADOW, startBrowser, fixtureData } from "./support/browser.mjs";

async function installRail(b) {
  await b.client.evaluate(`(() => {
    const rail = document.createElement('nav');
    rail.id = 'rail'; rail.setAttribute('data-app-navigation-rail', 'true');
    rail.style.cssText = 'position:fixed;top:44px;bottom:8px;left:0;width:52px;padding:8px;display:flex;flex-direction:column;align-items:center;gap:8px';
    rail.innerHTML = '<div style="flex:1;min-height:0"></div><div id="rail-bottom" style="display:flex;flex-direction:column;gap:8px;width:36px"><button id="rail-tool" style="width:36px;height:36px" aria-label="Native navigation tool">T</button></div>';
    document.body.append(rail);
    const row = document.getElementById('profile-row');
    row.style.cssText = 'position:static;width:36px;height:36px;display:flex;justify-content:center;gap:0';
    const profile = document.getElementById('profile');
    profile.textContent = 'JY';
    profile.style.cssText = 'width:36px;height:36px;min-width:36px;flex:0 0 36px';
    document.getElementById('rail-bottom').append(row);
  })()`);
  await b.settled();
}

function quotaData(credits = { usdAmount: 2500, formattedUsd: "US$2500.00", creditQuantity: 62500 }) {
  const data = fixtureData();
  return fixtureData({ accounts: [{ ...data.accounts[0], credits }],
    windows: [{ label: "Weekly", remainingPercent: 2, windowDurationMins: 10080 },
      { label: "5h", remainingPercent: 1, windowDurationMins: 300 }] });
}

test("[UI-01 UI-02] 新导航栏三行额度完整显示，头像与官方导航项不受挤压", { timeout: 30000 }, async t => {
  const b = await startBrowser(t);
  await b.update(quotaData());
  assert.equal(await b.value('.quota-chip'), '2%·1%·US$2500.00', '旧 UI 保留完整横栏及原顺序');
  await installRail(b);
  assert.deepEqual(await b.client.evaluate(`[...${SHADOW}.querySelectorAll('.quota-chip-item')].map(e=>e.textContent)`), ['2', '1', '$2500'], '新版与旧横栏使用相同的周期顺序，金额显示原值');
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelector('.quota-chip').hasAttribute('title')`), false);
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelectorAll('.quota-chip-item[title]').length`), 0);
  const layout = await b.client.evaluate(`(() => {
    const root = document.getElementById('codex-quota-injector-root');
    const chip = root.shadowRoot.querySelector('.quota-chip').getBoundingClientRect();
    const rail = document.getElementById('rail').getBoundingClientRect();
    const avatar = document.getElementById('profile').getBoundingClientRect();
    const rows = [...root.shadowRoot.querySelectorAll('.quota-chip-item')].map(e => e.getBoundingClientRect());
    return { layout:root.dataset.layout, parent:root.parentElement.id,
      chip:{left:chip.left,right:chip.right,top:chip.top,bottom:chip.bottom,width:chip.width,height:chip.height},
      rail:{left:rail.left,right:rail.right}, avatar:{left:avatar.left,right:avatar.right,width:avatar.width},
      rows:rows.map(r=>({left:r.left,right:r.right,top:r.top,bottom:r.bottom})),
      toolWidth:document.getElementById('rail-tool').getBoundingClientRect().width,
      immediatelyAboveProfile:root.nextElementSibling === document.getElementById('profile-row') };
  })()`);
  assert.equal(layout.layout, 'rail');
  assert.equal(layout.parent, 'rail-bottom');
  assert.equal(layout.immediatelyAboveProfile, true);
  assert.equal(layout.chip.width, 36);
  assert.ok(layout.chip.height >= 64 && layout.chip.height <= 90, '三行额度使用独立高度，保留清晰行距');
  assert.equal(layout.avatar.width, 36);
  assert.equal(layout.toolWidth, 36);
  assert.ok(layout.avatar.left >= layout.rail.left && layout.avatar.right <= layout.rail.right);
  for (const row of layout.rows) {
    assert.ok(row.left >= layout.chip.left && row.right <= layout.chip.right);
    assert.ok(row.top >= layout.chip.top && row.bottom <= layout.chip.bottom);
  }
  assert.ok(layout.rows[0].bottom + 5 <= layout.rows[1].top && layout.rows[1].bottom + 5 <= layout.rows[2].top);
  await b.click('.quota-chip');
  const panel = await b.client.evaluate(`(() => {
    const r=${SHADOW}.querySelector('.quota-popover').getBoundingClientRect();
    return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};
  })()`);
  assert.ok(panel.left >= layout.rail.right && panel.right <= 1280 - 12);
  assert.ok(panel.top >= 44 && panel.bottom <= layout.chip.top);
});

test("[UI-01 UI-02] 5h 耗尽仍显示美元或点数，缺失周期不借用其他周期", { timeout: 30000 }, async t => {
  const b = await startBrowser(t);
  await installRail(b);
  for (const [credits, expected] of [
    [{ usdAmount: 25, creditQuantity: 80, formattedUsd: 'US$25.00' }, '$25'],
    [{ usdAmount: 0, creditQuantity: 80, formattedUsd: 'US$0.00' }, '80点'],
    [{ creditQuantity: 2500 }, '2500点'],
    [{ unlimited: true }, '无限'],
    [{ usdAmount: 0, creditQuantity: 0 }, '--'],
    [null, '--'],
  ]) {
    const data = quotaData(credits);
    data.windows = [{ label:'5h',remainingPercent:0,windowDurationMins:300 }];
    await b.update(data);
    assert.deepEqual(await b.client.evaluate(`[...${SHADOW}.querySelectorAll('.quota-chip-item')].map(e=>e.textContent)`), expected === '--' ? ['0'] : ['0', expected]);
  }
  await b.update({ ...quotaData(), windows: [{ label:'Weekly',remainingPercent:64,windowDurationMins:10080 }] });
  assert.deepEqual(await b.client.evaluate(`[...${SHADOW}.querySelectorAll('.quota-chip-item')].map(e=>e.textContent)`), ['64', '$2500']);
  await b.update({ ...quotaData(null), windows: [{ label:'Weekly',remainingPercent:64,windowDurationMins:10080 }] });
  assert.deepEqual(await b.client.evaluate(`[...${SHADOW}.querySelectorAll('.quota-chip-item')].map(e=>e.textContent)`), ['64']);
  await b.update({ ...quotaData(), windows: [] });
  assert.deepEqual(await b.client.evaluate(`[...${SHADOW}.querySelectorAll('.quota-chip-item')].map(e=>e.textContent)`), ['$2500']);
  await b.update({ ...quotaData(null), windows: [] });
  assert.deepEqual(await b.client.evaluate(`[...${SHADOW}.querySelectorAll('.quota-chip-item')].map(e=>e.textContent)`), ['--']);
});

test("[UI-01 UI-03] 活节点迁移、导航栏替换及新旧结构动态切换保留表单和单一入口", { timeout: 30000 }, async t => {
  const b = await startBrowser(t);
  await b.update(quotaData());
  await b.click('.quota-chip');
  await b.client.evaluate(`(() => {
    window.retainedQuotaInput = ${SHADOW}.querySelector('.api-key-form input[name="name"]');
    retainedQuotaInput.value = 'unsaved account';
  })()`);
  await installRail(b);
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelector('.api-key-form input[name="name"]') === retainedQuotaInput`), true);
  assert.equal(await b.client.evaluate('retainedQuotaInput.value'), 'unsaved account');
  await b.client.evaluate(`(() => {
    const old=document.getElementById('rail');
    const next=old.cloneNode(false);
    next.append(document.getElementById('rail-bottom'));
    old.replaceWith(next);
  })()`);
  await b.settled();
  assert.equal(await b.client.evaluate('document.querySelectorAll("#codex-quota-injector-root").length'), 1);
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelector('.api-key-form input[name="name"]') === retainedQuotaInput`), true);
  // Both attribute changes and a retained profile node must be detected.
  await b.client.evaluate(`document.getElementById('rail').removeAttribute('data-app-navigation-rail')`);
  await b.settled();
  assert.equal(await b.client.evaluate('document.getElementById("codex-quota-injector-root").dataset.layout'), 'legacy');
  assert.equal(await b.value('.quota-chip'), '2%·1%·US$2500.00');
  await b.client.evaluate(`document.getElementById('rail').setAttribute('data-app-navigation-rail', 'true')`);
  await b.settled();
  assert.equal(await b.client.evaluate('document.getElementById("codex-quota-injector-root").dataset.layout'), 'rail');
  assert.equal(await b.client.evaluate('document.querySelectorAll("#codex-quota-injector-root").length'), 1);
  await b.client.evaluate('window.__codexQuotaWidget.destroy()');
  await b.client.evaluate(`document.getElementById('rail').removeAttribute('data-app-navigation-rail')`);
  await b.settled();
  assert.equal(await b.client.evaluate('document.querySelectorAll("#codex-quota-injector-root").length'), 0);
});

test("[UI-03] 新导航栏弹层在窄窗口和明暗主题中仍可操作", { timeout: 30000 }, async t => {
  const b = await startBrowser(t);
  await b.update(quotaData());
  await installRail(b);
  await b.client.request('Emulation.setDeviceMetricsOverride', { width:480,height:420,deviceScaleFactor:1,mobile:false });
  await b.settled();
  await b.click('.quota-chip');
  for (const theme of ['electron-light','electron-dark']) {
    await b.client.evaluate(`document.documentElement.className=${JSON.stringify(theme)}`);
    await b.settled();
    const bounds = await b.client.evaluate(`(() => {
      const p=${SHADOW}.querySelector('.quota-popover');const r=p.getBoundingClientRect();
      return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,background:getComputedStyle(p).backgroundColor};
    })()`);
    assert.ok(bounds.left >= 12 && bounds.right <= 480 - 12 + 1, JSON.stringify(bounds));
    assert.ok(bounds.top >= 44 && bounds.bottom <= 420 - 12, JSON.stringify(bounds));
    assert.equal(bounds.background, theme === 'electron-light' ? 'rgb(255, 255, 255)' : 'rgb(25, 25, 35)');
    await b.click('.extra-models-open');
    const edge = await b.client.evaluate(`(() => {
      const r=${SHADOW}.querySelector('.quota-popover').getBoundingClientRect();
      return {x:r.right-2,y:r.top+r.height/2};
    })()`);
    await b.client.request('Input.dispatchMouseEvent', {type:'mouseMoved',...edge,button:'none',buttons:0});
    await b.client.request('Input.dispatchMouseEvent', {type:'mousePressed',...edge,button:'left',buttons:1,clickCount:1});
    // Keep the real pointer inside the 480px viewport so Chromium delivers the drag.
    await b.client.request('Input.dispatchMouseEvent', {type:'mouseMoved',x:476,y:edge.y,button:'left',buttons:1});
    await b.client.request('Input.dispatchMouseEvent', {type:'mouseReleased',x:476,y:edge.y,button:'left',buttons:0,clickCount:1});
    const resized = await b.client.evaluate(`(() => {
      const r=${SHADOW}.querySelector('.quota-popover').getBoundingClientRect();
      return {left:r.left,right:r.right,width:r.width};
    })()`);
    assert.ok(resized.width > 430 && resized.left >= 12 && resized.right <= 480-12+1, JSON.stringify(resized));
    await b.click('.extra-models-back');
  }
});
