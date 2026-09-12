import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { decodeJwt, parseTokenInput } from "../src/account-manager.mjs";
import { sendWakeupRequest } from "../src/wakeup-client.mjs";

test("当前机器账号可通过隔离的官方 Codex app-server 完成最小文本请求", { skip: process.env.CODEX_TEST_LIVE_APPROVED !== "current-run" }, async () => {
  const codexHome = String(process.env.CODEX_HOME ?? "").trim() || join(homedir(), ".codex");
  const raw = await readFile(join(codexHome, "auth.json"), "utf8");
  const credentials = JSON.parse(raw);
  assert.ok(!credentials.OPENAI_API_KEY, "真实账号冒烟测试当前只支持 Codex OAuth 登录");
  const tokens = parseTokenInput(raw)[0];
  assert.ok(tokens?.accessToken, "当前 Codex auth.json 缺少 access_token");
  const claims = decodeJwt(tokens.idToken) ?? decodeJwt(tokens.accessToken) ?? {};
  const auth = claims["https://api.openai.com/auth"] ?? {};
  const accountId = tokens.accountId ?? auth.chatgpt_account_id;
  assert.ok(accountId, "当前 Codex auth.json 缺少 account_id");

  const abortController = new AbortController();
  const result = await sendWakeupRequest(async () => ({
    accessToken: tokens.accessToken,
    chatgptAccountId: accountId,
    chatgptPlanType: auth.chatgpt_plan_type ?? null,
  }), abortController.signal);
  assert.ok(result.model);
  assert.match(result.reply.trim(), /^OK[。.!！]?$/i);
});
