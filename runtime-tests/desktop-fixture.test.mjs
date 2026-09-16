import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  isWslRuntime,
  startDesktopFixtureServer,
  verifyDesktopFixtureEvidence,
} from "../scripts/test-desktop-host.mjs";
import { browserLaunchDirectory, startBrowser } from "./support/browser.mjs";
import { waitFor } from "../test/helpers.mjs";

test("[TOOL-06 UI-02 IO-03] 桌面宿主验收材料实际导航、输入、点击和下载产生独立证据", { timeout: 30_000 }, async t => {
  const hosted = await startDesktopFixtureServer();
  t.after(() => hosted.close());
  const browser = await startBrowser(t);
  if (process.platform === "darwin") {
    assert.ok(browser.launchArguments.includes("--use-mock-keychain"), "隔离 Chrome 必须使用模拟钥匙串");
    assert.ok(browser.child.spawnargs.includes("--use-mock-keychain"), "实际浏览器进程必须收到模拟钥匙串参数");
  }
  await browser.client.request("Page.navigate", { url: hosted.url });
  const marker = await waitFor(() => browser.value("#marker", "textContent", false));
  assert.equal(marker, hosted.fixture.marker);
  await browser.fill("#value", "WRONG", { shadow: false });
  await browser.click("#submit", { shadow: false });
  assert.equal(await browser.value("#result", "textContent", false), "标记不匹配");
  assert.equal(hosted.getEvidence().submissions.length, 0, "页面拒绝的错误值不得伪造服务端提交证据");
  await browser.fill("#value", marker, { shadow: false });
  await browser.click("#submit", { shadow: false });
  await waitFor(async () => (await browser.value("#result", "textContent", false)) === "已收到");
  const state = JSON.parse(await browser.value("#evidence", "textContent", false));
  assert.equal(state.submissions.length, 1);
  assert.equal(state.submissions[0].value, marker);
  assert.equal(hosted.getEvidence().submissions.length, 1);
  assert.equal(hosted.getEvidence().invalidSubmissions, 0);
  const downloadPath = await browserLaunchDirectory(browser.directory);
  await browser.client.request("Browser.setDownloadBehavior", { behavior: "allow", downloadPath });
  await browser.click("#download", { shadow: false });
  const artifact = await waitFor(async () => readFile(join(browser.directory, "codex-fixture.txt"), "utf8").catch(() => null));
  assert.equal(artifact, `ARTIFACT_${marker}\n`);
  await waitFor(() => hosted.getEvidence().artifactRequests === 1);
  const summary = verifyDesktopFixtureEvidence({ marker, evidence: hosted.getEvidence() });
  assert.ok(summary.pageRequests >= 1);
  assert.equal(summary.submissionCount, 1);
  assert.equal(summary.artifactRequests, 1);
});

test("[TOOL-06 NET-05] 桌面宿主材料仅在本机 HTTP 提供页面与可核对产物", async t => {
  const hosted = await startDesktopFixtureServer();
  t.after(() => hosted.close());
  const url = new URL(hosted.url);
  assert.equal(url.hostname, "127.0.0.1");
  const page = await fetch(hosted.url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
  assert.match(await page.text(), new RegExp(hosted.fixture.marker));
  const submission = await fetch(hosted.submitUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: hosted.fixture.marker }),
  });
  assert.equal(submission.status, 200);
  const artifact = await fetch(hosted.artifactUrl);
  assert.equal(artifact.status, 200);
  assert.equal(await artifact.text(), hosted.fixture.artifact);
  const invalid = await fetch(new URL("submission", hosted.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: "WRONG" }),
  });
  assert.equal(invalid.status, 400);
  assert.equal(hosted.getEvidence().invalidSubmissions, 1);
  const evidence = await (await fetch(hosted.evidenceUrl)).json();
  assert.deepEqual(evidence, hosted.getEvidence());
  assert.equal((await fetch(hosted.submitUrl)).status, 405);
  assert.equal((await fetch(new URL("missing", hosted.url))).status, 404);
});

test("[HAR-04] 桌面宿主证据拒绝模型自述、错误值和重复操作", () => {
  const marker = "DESKTOP_contract";
  assert.throws(() => verifyDesktopFixtureEvidence({
    marker,
    evidence: { pageRequests: 1, submissions: [], artifactRequests: 1 },
  }), /恰好一次提交/);
  assert.throws(() => verifyDesktopFixtureEvidence({
    marker,
    evidence: { pageRequests: 1, submissions: [{ value: "WRONG" }], artifactRequests: 1 },
  }), /随机标记不一致/);
  assert.throws(() => verifyDesktopFixtureEvidence({
    marker,
    evidence: { pageRequests: 1, submissions: [{ value: marker }], artifactRequests: 2 },
  }), /恰好一次产物请求/);
});

test("[ENV-03] 桌面夹具按运行环境识别 WSL，不依赖盘符、用户目录或项目路径", () => {
  assert.equal(isWslRuntime({
    platform: "linux",
    environment: { WSL_DISTRO_NAME: "Ubuntu" },
    releaseValue: "6.6.0-generic",
  }), true);
  assert.equal(isWslRuntime({
    platform: "linux",
    environment: {},
    releaseValue: "5.15.153.1-microsoft-standard-WSL2",
  }), true);
  assert.equal(isWslRuntime({
    platform: "linux",
    environment: {},
    releaseValue: "6.8.0-generic",
  }), false);
  assert.equal(isWslRuntime({
    platform: "win32",
    environment: { WSL_DISTRO_NAME: "unexpected" },
    releaseValue: "microsoft",
  }), false);
});

test("[HAR-04 OBS-03] CDP 已断开时截图诊断不能阻止测试浏览器和目录回收", { timeout: 20_000 }, async t => {
  let browser;
  await t.test("关闭本轮自己的 CDP 连接", async sub => {
    browser = await startBrowser(sub);
    browser.client.close();
  });
  assert.ok(browser.child.exitCode !== null || browser.child.signalCode !== null);
  await assert.rejects(access(browser.directory), { code: "ENOENT" });
  assert.doesNotThrow(() => process.kill(process.pid, 0), "测试控制进程保持可用");
});
