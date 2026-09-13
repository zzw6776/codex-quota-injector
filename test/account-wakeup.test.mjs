import assert from "node:assert/strict";
import test from "node:test";

import { AccountStore } from "../src/account-store.mjs";
import { AccountWakeupManager } from "../src/account-wakeup.mjs";
import { useTempDir } from "./helpers.mjs";

function account(id, overrides = {}) {
  return {
    id,
    email: `${id}@example.com`,
    authMode: "oauth",
    tokens: { idToken: "id", accessToken: "access", refreshToken: "refresh" },
    accountId: `${id}-workspace`,
    ...overrides,
  };
}

async function createStore(t) {
  const dataDir = await useTempDir(t, "codex-wakeup-data-");
  const cockpitDir = await useTempDir(t, "codex-wakeup-cockpit-");
  const store = new AccountStore({ dataDir, cockpitDir });
  await store.initialize();
  return store;
}

test("唤醒设置仅接受 OAuth 账号和合法且非空的启用时间", async (t) => {
  const store = await createStore(t);
  await store.upsert(account("oauth"));
  await store.upsert(account("api", {
    authMode: "apiKey",
    openaiApiKey: "sk-test",
    tokens: {},
  }));
  await store.upsert(account("transferred", { authStatus: "transferred" }));
  let changes = 0;
  const wakeup = new AccountWakeupManager({ store }, () => { changes += 1; });
  t.after(() => wakeup.close());

  await wakeup.save("oauth", { enabled: true, times: ["18:30", "08:00", "18:30"] });
  assert.deepEqual(store.get("oauth").wakeup.times, ["08:00", "18:30"]);
  assert.equal(store.get("oauth").wakeup.enabled, true);
  assert.equal(wakeup.getViewModel("oauth").message.status, "success");

  await wakeup.save("oauth", { enabled: true, times: [] });
  assert.match(wakeup.getViewModel("oauth").message.text, /至少添加一个/);
  await wakeup.save("api", { enabled: true, times: ["08:00"] });
  assert.match(wakeup.getViewModel("api").message.text, /仅 OAuth/);
  await wakeup.save("transferred", { enabled: true, times: ["08:00"] });
  assert.match(wakeup.getViewModel("transferred").message.text, /已转出/);
  assert.equal(changes, 4);
});

test("启动时把未完成的 running 记录标成结果未知，不会伪报成功", async (t) => {
  const store = await createStore(t);
  await store.upsert(account("interrupted", {
    wakeup: {
      enabled: true,
      times: ["08:00"],
      updatedAt: 1,
      scheduledDate: null,
      scheduledTimes: [],
      lastRun: { status: "running", startedAt: 10, message: "旧状态" },
    },
  }));
  const wakeup = new AccountWakeupManager({ store }, () => {});
  t.after(() => wakeup.close());

  await wakeup.start();
  assert.equal(store.get("interrupted").wakeup.lastRun.status, "error");
  assert.match(store.get("interrupted").wakeup.lastRun.message, /结果未知/);
});

test("到点任务先持久化占位再触发，同一天同一时刻不会重复发送", async (t) => {
  const store = await createStore(t);
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const due = new Date(
    now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes(),
  ).getTime();
  await store.upsert(account("scheduled", {
    wakeup: {
      enabled: true,
      times: [time],
      updatedAt: due - 10_000,
      scheduledDate: null,
      scheduledTimes: [],
      lastRun: null,
    },
  }));
  const wakeup = new AccountWakeupManager({ store }, () => {});
  t.after(() => wakeup.close());
  const triggered = [];
  wakeup.trigger = (accountId, slot) => triggered.push({ accountId, slot });
  wakeup.lastCheckedAt = due - 1;

  await wakeup.checkSchedule();
  assert.equal(triggered.length, 1);
  assert.equal(triggered[0].accountId, "scheduled");
  assert.equal(triggered[0].slot.time, time);
  assert.deepEqual(store.get("scheduled").wakeup.scheduledTimes, [time]);

  wakeup.lastCheckedAt = due - 1;
  await wakeup.checkSchedule();
  assert.equal(triggered.length, 1);
});

test("休眠或时钟跳变超过一分钟时不补发错过的定时任务", async (t) => {
  const store = await createStore(t);
  await store.upsert(account("sleep", {
    wakeup: {
      enabled: true,
      times: ["00:00"],
      updatedAt: 1,
      scheduledDate: null,
      scheduledTimes: [],
      lastRun: null,
    },
  }));
  const wakeup = new AccountWakeupManager({ store }, () => {});
  t.after(() => wakeup.close());
  let triggered = false;
  wakeup.trigger = () => { triggered = true; };
  wakeup.lastCheckedAt = Date.now() - 61_000;

  await wakeup.checkSchedule();
  assert.equal(triggered, false);
  assert.deepEqual(store.get("sleep").wakeup.scheduledTimes, []);
});

test("模型已回复但额度刷新失败时仍记录成功，并明确刷新异常", async (t) => {
  const store = await createStore(t);
  await store.upsert(account("run"));
  const accountManager = {
    store,
    async withWakeupAccount(accountId, callback) {
      assert.equal(accountId, "run");
      return callback(async () => ({
        accessToken: "access",
        chatgptAccountId: "run-workspace",
      }));
    },
    async refreshAccount() {
      throw new Error("quota unavailable");
    },
  };
  const wakeup = new AccountWakeupManager(accountManager, () => {}, {
    async sendRequest(getCredentials, signal) {
      assert.equal(signal.aborted, false);
      const credentials = await getCredentials();
      assert.equal(credentials.chatgptAccountId, "run-workspace");
      return { model: "gpt-test", reply: "OK" };
    },
  });
  t.after(() => wakeup.close());

  await wakeup.run("run", null);
  const result = store.get("run").wakeup.lastRun;
  assert.equal(result.status, "success");
  assert.equal(result.model, "gpt-test");
  assert.equal(result.reply, "OK");
  assert.match(result.message, /额度刷新失败.*quota unavailable/);
});
