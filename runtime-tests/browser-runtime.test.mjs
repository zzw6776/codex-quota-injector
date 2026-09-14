import assert from "node:assert/strict";
import test from "node:test";

import { startBrowser } from "./support/browser.mjs";

test("[A HAR-01 TOOL-04] 当前原生运行环境可启动并清理隔离浏览器", { timeout: 30_000 }, async t => {
  const browser = await startBrowser(t);
  assert.equal(await browser.client.evaluate("document.title"), "");
  assert.equal(await browser.value("#profile", "textContent", false), "Fixture profile");
});
