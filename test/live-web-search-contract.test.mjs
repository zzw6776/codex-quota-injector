import assert from "node:assert/strict";
import test from "node:test";
import { findOfficialAppServerUrl } from "../live-tests/web-search-contract.mjs";

test("[A TOOL-03] 真实网页搜索接受 OpenAI 官方文档站和 Codex 官方仓库中的 app-server 文档", () => {
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

test("[A TOOL-03] 真实网页搜索拒绝仿冒域名和与 app-server 无关的链接", () => {
  assert.equal(findOfficialAppServerUrl("https://developers.openai.com.example.org/codex/app-server/"), null);
  assert.equal(findOfficialAppServerUrl("https://github.com/someone/codex/blob/main/codex-rs/app-server/README.md"), null);
  assert.equal(findOfficialAppServerUrl("https://github.com/openai/codex"), null);
  assert.equal(findOfficialAppServerUrl("https://learn.chatgpt.com/docs/codex"), null);
});
