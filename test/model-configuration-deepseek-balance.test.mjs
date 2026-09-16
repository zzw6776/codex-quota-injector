import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { MODEL_CAPABILITY_PROBE_VERSION } from "../src/model-capability-probe.mjs";
import { useTempDir } from "./helpers.mjs";
import { extraModelManager, detectAndSave } from "./model-configuration/support.mjs";

test("模型配置平台统一持久化 DeepSeek 预设、余额和停用状态", async (t) => {
  const dataDir = await useTempDir(t);
  const requests = [];
  const manager = extraModelManager(dataDir, {
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), authorization: options.headers.Authorization });
      if (String(url).endsWith("/models")) {
        return new Response(JSON.stringify({
          data: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        is_available: true,
        balance_infos: [{
          currency: "CNY",
          total_balance: "10.00",
          granted_balance: "2.00",
          topped_up_balance: "8.00",
        }],
      }), { status: 200 });
    },
  });
  const initial = await manager.initialize();
  const preset = initial.platforms.find((platform) => platform.preset === "deepseek");
  await assert.rejects(
    manager.savePlatform({ ...preset, enabled: true, apiKey: "" }),
    /必须填写 API Key/,
  );
  const saved = await detectAndSave(manager, { ...preset, enabled: true, apiKey: " ds-key " });
  assert.equal(saved.platforms[0].enabled, true);
  assert.equal(saved.platforms[0].apiKey, "ds-key");
  assert.ok(saved.platforms[0].models.every((model) =>
    model.compatibility.status === "verified" &&
    model.compatibility.probeVersion === MODEL_CAPABILITY_PROBE_VERSION));
  const refreshed = await manager.refreshDeepSeekBalance();
  assert.equal(refreshed.deepSeekBalance.balance.items[0].totalBalance, "10.00");
  assert.ok(requests.every((request) => request.authorization === "Bearer ds-key"));
  assert.equal((await readFile(manager.settingsPath, "utf8")).includes("ds-key"), true);

  const reloaded = extraModelManager(dataDir, {
    fetchImpl: null,
    probeModel: async () => {
      throw new Error("初始化不得重新发送模型探测请求");
    },
  });
  const reloadedPreset = (await reloaded.initialize()).platforms[0];
  assert.equal(reloadedPreset.enabled, true);
  assert.equal(reloadedPreset.apiKey, "ds-key");
  assert.ok(reloadedPreset.models.every((model) =>
    model.compatibility.status === "verified" &&
    model.compatibility.probeVersion === MODEL_CAPABILITY_PROBE_VERSION),
  "同一探测版本的检测结果必须跨管理器进程重建保留");

  const applied = manager.markRestarted();
  assert.equal(applied.pendingRestart, false);
  assert.ok(applied.platforms[0].models.every((model) =>
    model.compatibility.status === "verified"),
  "重启完成只能清除待生效标记，不能清除模型检测结果");

  const cleared = await manager.savePlatform({
    ...saved.platforms[0],
    enabled: false,
    apiKey: "",
  });
  assert.equal(cleared.platforms[0].enabled, false);
  assert.equal(cleared.platforms[0].apiKey, "");
  assert.equal(cleared.deepSeekBalance.balance, null);
  assert.equal(cleared.deepSeekBalance.updatedAt, null);
  assert.equal(JSON.parse(await readFile(manager.settingsPath, "utf8")).platforms[0].apiKey, "");
  await assert.rejects(readFile(join(dataDir, "provider-settings.json"), "utf8"), /ENOENT/,
    "DeepSeek 不能再生成独立入口的配置文件");
  manager.close();
  reloaded.close();
});

test("模型管理中的 DeepSeek 余额使用预设 Key 查询并在换 Key 后清空", async (t) => {
  const dataDir = await useTempDir(t);
  const requests = [];
  const manager = extraModelManager(dataDir, {
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), authorization: options.headers.Authorization });
      return new Response(JSON.stringify({
        is_available: true,
        balance_infos: [{
          currency: "CNY",
          total_balance: "9.49",
          granted_balance: "0.50",
          topped_up_balance: "8.99",
        }],
      }), { status: 200 });
    },
  });
  const initial = await manager.initialize();
  const preset = initial.platforms.find((platform) => platform.preset === "deepseek");
  await manager.savePlatform({ ...preset, apiKey: " managed-key ", enabled: false });
  const changeStates = [];
  const stop = manager.onChange((view) => {
    changeStates.push(view.deepSeekBalance.refreshing);
  });

  const refreshed = await manager.refreshDeepSeekBalance();
  assert.deepEqual(changeStates, [true, false]);
  assert.equal(refreshed.deepSeekBalance.refreshing, false);
  assert.equal(refreshed.deepSeekBalance.updatedAt, 1234);
  assert.deepEqual(refreshed.deepSeekBalance.balance, {
    available: true,
    items: [{
      currency: "CNY",
      totalBalance: "9.49",
      grantedBalance: "0.50",
      toppedUpBalance: "8.99",
    }],
  });
  assert.deepEqual(requests, [{
    url: "https://api.deepseek.com/user/balance",
    authorization: "Bearer managed-key",
  }]);

  const savedPreset = manager.getViewModel().platforms.find((platform) => platform.preset === "deepseek");
  const changed = await manager.savePlatform({
    ...savedPreset,
    apiKey: "replacement-key",
    enabled: false,
  });
  assert.equal(changed.deepSeekBalance.balance, null);
  assert.equal(changed.deepSeekBalance.updatedAt, null);
  stop();
  manager.close();
});
