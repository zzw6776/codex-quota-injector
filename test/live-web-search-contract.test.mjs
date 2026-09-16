import assert from "node:assert/strict";
import test from "node:test";
import { findOfficialAppServerUrl, findOfficialSearchSourceUrl } from "../live-tests/web-search-contract.mjs";

test("[TOOL-03] 真实网页搜索接受 OpenAI 官方文档站和 Codex 官方仓库中的 app-server 文档", () => {
  assert.equal(findOfficialAppServerUrl(
    "[App server](https://developers.openai.com/codex/app-server/)",
  ), "https://developers.openai.com/codex/app-server/");
  assert.equal(findOfficialAppServerUrl(
    "[App server](https://learn.chatgpt.com/zh-Hans/docs/app-server)",
  ), "https://learn.chatgpt.com/zh-Hans/docs/app-server");
  assert.equal(findOfficialAppServerUrl(
    "[codex-app-server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)",
  ), "https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md");
});

test("[TOOL-03] 桌面文档契约拒绝介绍文章、仿冒域名和非 app-server 文档链接", () => {
  assert.equal(findOfficialAppServerUrl(
    "[Unlocking the Codex harness: how we built the App Server](https://openai.com/index/unlocking-the-codex-harness/)",
  ), null);
  assert.equal(findOfficialAppServerUrl("https://developers.openai.com.example.org/codex/app-server/"), null);
  assert.equal(findOfficialAppServerUrl("https://github.com/someone/codex/blob/main/codex-rs/app-server/README.md"), null);
  assert.equal(findOfficialAppServerUrl("https://github.com/openai/codex"), null);
  assert.equal(findOfficialAppServerUrl("https://learn.chatgpt.com/docs/codex"), null);
});

test("[TOOL-03] 后台搜索接受本次 官方模型测试 返回的官方技术文章，同时拒绝非官方来源和没有链接的回答", () => {
  assert.equal(findOfficialSearchSourceUrl(
    "[Unlocking the Codex harness: how we built the App Server](https://openai.com/index/unlocking-the-codex-harness/)",
  ), "https://openai.com/index/unlocking-the-codex-harness/");
  assert.equal(findOfficialSearchSourceUrl("https://learn.chatgpt.com/docs/app-server"),
    "https://learn.chatgpt.com/docs/app-server");
  assert.equal(findOfficialSearchSourceUrl("https://github.com/openai/codex"),
    "https://github.com/openai/codex");
  assert.equal(findOfficialSearchSourceUrl("https://openai.com.example.org/index/app-server/"), null);
  assert.equal(findOfficialSearchSourceUrl("https://github.com/someone/codex/blob/main/app-server/README.md"), null);
  assert.equal(findOfficialSearchSourceUrl("已搜索到官方 App Server 介绍文章"), null);
});
