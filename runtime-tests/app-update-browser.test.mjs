import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SHADOW, startBrowser, fixtureData } from "./support/browser.mjs";
import { waitFor } from "../test/helpers.mjs";
import { startUpdateWindowServer } from "../src/app-update/window.mjs";
import { createUpdateRun } from "../src/app-update/runner.mjs";

test("更新确认页随窗口伸缩，长短空日志框等大且按钮贴近底部", { timeout: 30_000 }, async t => {
  const b = await startBrowser(t);
  await b.client.request('Emulation.setDeviceMetricsOverride', { width: 500, height: 510, deviceScaleFactor: 1, mobile: false });
  const notes = "## 更新内容\n" + Array.from({ length: 30 }, (_, index) => `- 改进 ${index + 1}：更新功能展示版本说明`).join('\n') + '\n<img src=x onerror="window.injected=true">';
  const run = createUpdateRun({ asset: { version: "0.1.322", size: 1, releaseNotes: notes },
    owner: { version: "0.1.321", mode: "formal" } });
  let state = run.state;
  const window = await startUpdateWindowServer({ state: () => state, confirm() {}, close() {} });
  t.after(() => window.close());
  await b.client.request('Page.navigate', { url: window.url });
  await waitFor(() => b.client.evaluate(`document.querySelector('.release-notes-content') != null`));
  assert.equal(await b.client.evaluate(`document.querySelector('.release-notes-content').textContent`), notes);
  assert.equal(await b.client.evaluate(`document.querySelector('.release-notes-content img')`), null);
  assert.equal(await b.client.evaluate(`window.injected===true`), false);
  const layout = await b.client.evaluate(`(()=>{const notes=document.querySelector('.release-notes-content'),button=document.querySelector('.primary'),rect=button.getBoundingClientRect();notes.scrollTop=notes.scrollHeight;return {scrollable:notes.scrollHeight>notes.clientHeight,scrolled:notes.scrollTop>0,buttonVisible:rect.bottom<=innerHeight&&rect.top>=0,wrap:getComputedStyle(notes).whiteSpace}})()`);
  assert.deepEqual(layout, { scrollable: true, scrolled: true, buttonVisible: true, wrap: 'pre-wrap' });
  const dimensions = [];
  for (const [width, height] of [[500, 510], [800, 700], [420, 460]]) {
    await b.client.request('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    let baseline;
    for (const content of [notes, '- 更新窗口支持调整大小。', '']) {
      state = { ...state, releaseNotes: content };
      await waitFor(() => b.client.evaluate(`document.querySelector('.release-notes-content').textContent===${JSON.stringify(content || '该版本暂无更新日志')}`));
      const bounds = await b.client.evaluate(`(()=>{const n=document.querySelector('.release-notes-content').getBoundingClientRect(),a=document.querySelector('.actions').getBoundingClientRect(),b=document.querySelector('.primary').getBoundingClientRect();return {width:n.width,height:n.height,gap:a.top-n.bottom,bottomGap:innerHeight-b.bottom,visible:b.top>=0&&b.bottom<=innerHeight,noPageOverflow:document.documentElement.scrollHeight<=innerHeight}})()`);
      assert.equal(bounds.visible, true);
      assert.equal(bounds.noPageOverflow, true);
      assert.ok(bounds.gap >= 14 && bounds.gap <= 18, JSON.stringify(bounds));
      assert.ok(bounds.bottomGap >= 22 && bounds.bottomGap <= 26, JSON.stringify(bounds));
      if (baseline) assert.deepEqual(bounds, baseline, '日志数量不能改变展示框和按钮的位置');
      else baseline = bounds;
      if (width === 800 && content.length < 100 && content) {
        const directory = join(import.meta.dirname, '..', '.runtime', 'update-resize-20261012');
        await mkdir(directory, { recursive: true });
        const screenshot = await b.client.request('Page.captureScreenshot');
        await writeFile(join(directory, 'preview.png'), Buffer.from(screenshot.data, 'base64'));
      }
    }
    dimensions.push(baseline);
  }
  assert.ok(dimensions[1].height > dimensions[0].height + 150, '拉高窗口后日志框必须同步增高');
  assert.ok(dimensions[1].width > dimensions[0].width + 250, '拉宽窗口后日志框必须同步增宽');
  assert.ok(dimensions[2].height < dimensions[0].height && dimensions[2].width < dimensions[0].width);
  state = { ...state, status: 'downloading' };
  await waitFor(() => b.client.evaluate(`document.querySelector('.release-notes')===null`));
});

test("新旧额度入口小绿点不占行，右下角更新按钮在局部刷新后仍有效且保留表单", { timeout: 30_000 }, async t => {
  const b = await startBrowser(t);
  const update = { available: true, version: "0.1.295" };
  await b.update(fixtureData({ appUpdate: update }));
  await b.click('.quota-chip');
  assert.deepEqual((await b.drain()).map(({ type }) => type), ['app-update-check']);
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
  assert.equal(await b.value('.app-update-open'), 'vtest');
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelector('.app-update-open').matches('.panel-version-text')`), true);
  assert.equal(await b.client.evaluate(`getComputedStyle(${SHADOW}.querySelector('.app-update-open')).color === getComputedStyle(${SHADOW}.querySelector('.panel-version')).color`), true);
  await b.click('.app-update-open');
  assert.equal(await b.value('.app-update-open'), '正在检查更新…');
  assert.equal(await b.value('.app-update-open', 'disabled'), true);
  const [check] = await b.drain();
  assert.equal(check.type, 'app-update-open'); assert.ok(check.requestId);
  await b.update(fixtureData({ appUpdate: { available: false, requestId: check.requestId, opening: false } }));
  assert.equal(await b.value('.app-update-open'), 'vtest');
  assert.equal(await b.value('.app-update-open', 'disabled'), false);
  assert.equal(await b.client.evaluate(`${SHADOW}.querySelector('.app-update-error')`), null);
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
  assert.equal(await b.client.evaluate(`document.querySelector('.actions button:last-child').disabled`), true);
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

test("终止按钮中断本次更新，保留已终止状态且允许手动关闭", { timeout: 30_000 }, async t => {
  const b = await startBrowser(t);
  let closed = 0;
  const run = createUpdateRun({ id: "cancel-test", directory: "/fixture", owner: { mode: "dev", version: "0.1.314" },
    asset: { version: "0.1.295", name: "pkg", size: 100 } }, {
    history: async () => ({ tracked: [], ready: true }),
    download: async (_asset, _path, { signal, onProgress }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }); onProgress(50, 100);
    }),
    prepare: async () => { throw new Error("终止后不应校验或安装"); },
  });
  const window = await startUpdateWindowServer({ state: () => run.state,
    confirm: () => { void run.confirm(); }, terminate: () => { void run.terminate(); }, close: () => { closed++; } });
  t.after(() => window.close());
  await b.client.request('Page.navigate', { url: window.url });
  await waitFor(() => b.client.evaluate(`document.querySelector('.primary')?.textContent==='立即更新'`));
  await b.client.evaluate(`document.querySelector('.primary').click()`);
  await waitFor(() => b.client.evaluate(`document.querySelector('.danger')?.textContent==='终止更新'`));
  assert.equal(await b.client.evaluate(`document.querySelector('.actions button:last-child').disabled`), true);
  assert.equal((await fetch(`${window.url}terminate`, { method: "POST", headers: { Origin: "https://other.example" } })).status, 403);
  assert.equal(run.state.status, "downloading");
  await b.client.evaluate(`document.querySelector('.danger').click()`);
  await waitFor(() => b.client.evaluate(`document.body.textContent.includes('更新已终止')`));
  assert.equal(run.state.status, "cancelled"); assert.equal(closed, 0);
  assert.equal(await b.client.evaluate(`document.querySelector('.actions button').disabled`), false);
  await b.client.evaluate(`document.querySelector('.actions button').click()`);
  await waitFor(() => closed === 1);
});
