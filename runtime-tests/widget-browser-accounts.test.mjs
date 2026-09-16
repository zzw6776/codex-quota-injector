import assert from "node:assert/strict";
import test from "node:test";
import { fixtureData, startBrowser } from "./support/browser.mjs";

test("[A UI-02 ACC-01 ACC-02 ACC-05] 页面刷新、迁移、恢复、导入和授权取消产生唯一且完整的动作", { timeout: 30_000 }, async t => {
  const b = await startBrowser(t);
  await b.click(".quota-chip");
  for (const [selector, type] of [[".refresh-all", "refresh-all"], [".local-import", "local-import"], [".oauth-add", "oauth-add"]]) {
    await b.click(selector);
    const [action, ...extra] = await b.drain();
    assert.equal(action.type, type);
    assert.ok(action.id);
    assert.deepEqual(extra, []);
    assert.deepEqual(await b.drain(), []);
  }
  await b.click(".migration-open");
  assert.match(await b.value(".provider-note"), /access token 和 refresh token 都写回本机加密账户库/);
  await b.click('.migration-form button[type="submit"]');
  const [temporary] = await b.drain();
  assert.equal(temporary.type, "account-transfer");
  assert.equal(temporary.mode, "temporary");
  assert.deepEqual(temporary.accountIds, ["account-1"]);
  await b.click('.migration-mode[value="handoff"]');
  await b.client.evaluate("window.confirm=()=>true");
  await b.click('.migration-form button[type="submit"]');
  const [handoff] = await b.drain();
  assert.equal(handoff.type, "account-transfer");
  assert.equal(handoff.mode, "handoff");
  assert.deepEqual(handoff.accountIds, ["account-1"]);
  await b.click(".migration-back");
  await b.update(fixtureData({
    currentAccountId: null,
    accounts: [{ ...fixtureData().accounts[0], current: false, authStatus: "transferred",
      transferredAt: Date.now(), canTransfer: false, canTemporaryTransfer: false }],
  }));
  await b.client.evaluate("window.confirmMessages=[];window.confirm=message=>{confirmMessages.push(message);return false}");
  await b.click(".restore-transferred");
  assert.deepEqual(await b.drain(), []);
  assert.match(await b.client.evaluate("confirmMessages[0]"), /新设备已经停止使用/);
  assert.match(await b.client.evaluate("confirmMessages[0]"), /可能使新设备登录失效/);
  await b.client.evaluate("window.confirm=()=>true");
  await b.click(".restore-transferred");
  assert.equal((await b.drain())[0].type, "restore-transferred");
  await b.click("details:has(.token-form) > summary");
  await b.fill('.token-form [name="token"]', '{"fake":"凭据材料"}');
  await b.click('.token-form button[type="submit"]');
  assert.equal((await b.drain())[0].token, '{"fake":"凭据材料"}');
  await b.click("details:has(.api-key-form) > summary");
  await b.fill('.api-key-form [name="name"]', "测试账号");
  await b.fill('.api-key-form [name="apiKey"]', "sk-offline-fixture");
  await b.click('.api-key-form button[type="submit"]');
  const [added] = await b.drain();
  assert.equal(added.type, "api-key-add");
  assert.equal(added.name, "测试账号");
  assert.equal(added.apiKey, "sk-offline-fixture");
  await b.update(fixtureData({ operation: { state: "loading", cancellable: "oauth", message: "等待测试授权" } }));
  assert.equal(await b.value(".refresh-all", "disabled"), true);
  await b.click(".oauth-cancel");
  assert.equal((await b.drain())[0].type, "oauth-cancel");
});
