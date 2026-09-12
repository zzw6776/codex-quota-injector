import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, get } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { AccountManager } from "../src/account-manager.mjs";
import { AccountStore } from "../src/account-store.mjs";
import { createJwt, useTempDir, waitFor } from "./helpers.mjs";

async function setup(t, oauth = {}) {
  const directory = await useTempDir(t);
  const store = new AccountStore({ dataDir: join(directory, "store"), cockpitDir: join(directory, "empty") });
  await store.initialize();
  const opened = [];
  const manager = new AccountManager({ store, codexHome: join(directory, "official"), exportDirectory: join(directory, "export"),
    oauth: { callbackPort: 0, timeoutMs: 2000, openExternal: url => opened.push(new URL(url)), ...oauth } });
  t.after(() => manager.close());
  return { directory, store, manager, opened };
}

function callback(authUrl, values) {
  const url = new URL(authUrl.searchParams.get("redirect_uri"));
  url.hostname = "127.0.0.1";
  url.search = new URLSearchParams({ state: authUrl.searchParams.get("state"), ...values }).toString();
  return new Promise((resolve, reject) => get(url, response => {
    response.resume(); response.on("end", () => resolve(response.statusCode));
  }).on("error", reject));
}

function fakeTokens() {
  return { access_token: createJwt({ exp: Math.floor(Date.now()/1000)+3600, "https://api.openai.com/profile": { email: "fixture@example.invalid" },
    "https://api.openai.com/auth": { chatgpt_account_id: "fixture-workspace" } }), refresh_token: "offline-refresh" };
}

test("[A ACC-01 ACC-02] OAuth 回调验证 state 和 PKCE，凭据加密保存，导出再导入保持可用", async t => {
  const { directory, store, manager, opened } = await setup(t);
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith("/oauth/token")) return Response.json(fakeTokens());
    if (String(url).endsWith("/wham/usage")) return Response.json({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 17, limit_window_seconds: 18000 } } });
    if (String(url).includes("/accounts/check/")) return Response.json({ accounts: { "fixture-workspace": { account: { id: "fixture-workspace", plan_type: "plus" }, entitlement: { expires_at: "2028-01-01T00:00:00Z" } } } });
    throw new Error(`非预期网络访问 ${url}`);
  });
  manager.beginOAuthLogin();
  const finished = manager.oauthPromise;
  await waitFor(() => opened.length);
  assert.throws(() => manager.beginOAuthLogin(), /已有 OAuth/);
  assert.equal(await callback(opened[0], { state: "wrong-state", code: "bad" }), 400);
  assert.equal(requests.length, 0);
  assert.equal(await callback(opened[0], { code: "offline-code" }), 200);
  await finished;
  assert.equal(manager.operation.state, "success");
  assert.equal(store.list().length, 1);
  const exchange = requests.find(r => r.url.endsWith("/oauth/token"));
  assert.equal(exchange.options.body.get("code"), "offline-code");
  assert.equal(createHash("sha256").update(exchange.options.body.get("code_verifier")).digest("base64url"), opened[0].searchParams.get("code_challenge"));
  assert.equal(store.list()[0].quota.windows[0].usedPercent, 17);
  await assert.rejects(readFile(join(manager.codexHome, "auth.json")), { code: "ENOENT" });
  await assert.rejects(callback(opened[0], { code: "replay" }));
  await manager.addApiKey("sk-offline-api-key", "Fixture API");
  await manager.exportAccounts();
  const path = join(directory, "export", (await readdir(join(directory, "export")))[0]);
  const backup = await readFile(path, "utf8");
  // Windows exposes synthetic POSIX permission bits; access is governed by the
  // inherited ACL there. Exact 0600 is an observable contract only on POSIX.
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  const other = await setup(t);
  await other.manager.importTokenInput(backup);
  assert.deepEqual(other.store.list().map(a => [a.authMode, a.email]).sort(), store.list().map(a => [a.authMode, a.email]).sort());
  assert.equal(other.store.list().find(a => a.authMode === "apiKey").openaiApiKey, "sk-offline-api-key");
});

test("[A ACC-02] OAuth 取消、超时和回调端口冲突均释放流程，错误不创建账号", async t => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("此场景不得发送凭据请求"); });
  for (const kind of ["cancel", "timeout", "port"]) await t.test(kind, async t => {
    let server;
    if (kind === "port") {
      server = createServer();
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      t.after(() => new Promise(resolve => server.close(resolve)));
    }
    const { store, manager, opened } = await setup(t, { timeoutMs: kind === "timeout" ? 50 : 2000, ...(server ? { callbackPort: server.address().port } : {}) });
    manager.beginOAuthLogin();
    const completed = manager.oauthPromise;
    if (kind === "cancel") { await waitFor(() => opened.length); assert.equal(manager.cancelOAuthLogin(), true); }
    await completed;
    assert.equal(store.list().length, 0);
    assert.equal(manager.oauthPromise, null);
    assert.equal(manager.cancelOAuthLogin(), false);
    assert.match(manager.operation.message, kind === "cancel" ? /已取消/ : kind === "timeout" ? /超时/ : /已被占用/);
    if (opened[0]) await assert.rejects(callback(opened[0], { code: "late" }));
  });
});

test("[A ACC-02] OAuth 在 Token 交换阶段取消会终止请求，迟到响应不保存账号", async t => {
  const { manager, store, opened } = await setup(t);
  let entered = false;
  t.mock.method(globalThis, "fetch", (_url, options) => new Promise((_resolve, reject) => {
    entered = true;
    options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
  }));
  manager.beginOAuthLogin();
  const completed = manager.oauthPromise;
  await waitFor(() => opened.length);
  await callback(opened[0], { code: "cancel-exchange" });
  await waitFor(() => entered);
  manager.cancelOAuthLogin();
  await completed;
  assert.match(manager.operation.message, /已取消/);
  assert.equal(store.list().length, 0);
});
