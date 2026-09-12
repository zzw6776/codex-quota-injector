import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { desktopFixture, startDesktopFixtureServer } from "../scripts/test-desktop-host.mjs";
import { startBrowser } from "./support/browser.mjs";
import { waitFor } from "../test/helpers.mjs";

test("[A TOOL-06 UI-02 IO-03] 桌面宿主验收材料实际导航、输入、点击和下载产生独立证据", { timeout: 30_000 }, async t => {
  const fixture = desktopFixture();
  const browser = await startBrowser(t);
  if (process.platform === "darwin") {
    assert.ok(browser.launchArguments.includes("--use-mock-keychain"), "隔离 Chrome 必须使用模拟钥匙串");
    assert.ok(browser.child.spawnargs.includes("--use-mock-keychain"), "实际浏览器进程必须收到模拟钥匙串参数");
  }
  await browser.client.request("Page.navigate", { url: fixture.dataUrl });
  const marker = await waitFor(() => browser.value("#marker", "textContent", false));
  assert.equal(marker, fixture.marker);
  await browser.fill("#value", "WRONG", { shadow: false });
  await browser.click("#submit", { shadow: false });
  assert.equal(await browser.value("#result", "textContent", false), "标记不匹配");
  await browser.fill("#value", marker, { shadow: false });
  await browser.click("#submit", { shadow: false });
  await waitFor(async () => (await browser.value("#result", "textContent", false)) === "已收到");
  const state = JSON.parse(await browser.value("#evidence", "textContent", false));
  assert.equal(state.submissions.length, 1);
  assert.equal(state.submissions[0].value, marker);
  await browser.client.request("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: browser.directory });
  await browser.click("#download", { shadow: false });
  const artifact = await waitFor(async () => readFile(join(browser.directory, "codex-fixture.txt"), "utf8").catch(() => null));
  assert.equal(artifact, `ARTIFACT_${marker}\n`);
});

test("[A TOOL-06 NET-05] 桌面宿主材料仅在本机 HTTP 提供页面与可核对产物", async t => {
  const hosted = await startDesktopFixtureServer();
  t.after(() => hosted.close());
  const url = new URL(hosted.url);
  assert.equal(url.hostname, "127.0.0.1");
  const page = await fetch(hosted.url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
  assert.match(await page.text(), new RegExp(hosted.fixture.marker));
  const artifact = await fetch(hosted.artifactUrl);
  assert.equal(artifact.status, 200);
  assert.equal(await artifact.text(), hosted.fixture.artifact);
  assert.equal((await fetch(new URL("missing", hosted.url))).status, 404);
});

test("[A HAR-04 OBS-03] CDP 已断开时截图诊断不能阻止测试浏览器和目录回收", { timeout: 20_000 }, async t => {
  let browser;
  await t.test("关闭本轮自己的 CDP 连接", async sub => {
    browser = await startBrowser(sub);
    browser.client.close();
  });
  assert.ok(browser.child.exitCode !== null || browser.child.signalCode !== null);
  await assert.rejects(access(browser.directory), { code: "ENOENT" });
  assert.doesNotThrow(() => process.kill(process.pid, 0), "测试控制进程保持可用");
});
