import assert from "node:assert/strict";
import test from "node:test";

import { createSafeRestartCoordinator } from "../src/injector/safe-restart.mjs";

test("安全重启复用单次请求并在历史稳定后重启", async () => {
  const states = [];
  const calls = [];
  let closeCount = 0;
  const coordinator = createSafeRestartCoordinator({
    getLaunchOptions: () => ({ relay: { wslNative: false } }),
    getThreadId: () => "thread",
    createInspector: async (options) => {
      assert.equal(options.threadId, "thread");
      calls.push("inspect-created");
      return { inspect: async () => ({ ready: true, tracked: [] }), close: async () => { closeCount++; } };
    },
    waitForReady: async ({ onStatus, timeoutMs }) => {
      assert.equal(timeoutMs, Number.POSITIVE_INFINITY);
      await onStatus({ ready: false, reason: "等待当前任务结束" });
      await onStatus({ ready: false, reason: "等待任务历史投影落盘" });
      await onStatus({ ready: true });
      calls.push("history-ready");
    },
    restart: async () => { calls.push("restart"); },
    onChange: (state) => states.push(state),
  });
  const first = coordinator.request();
  assert.equal(coordinator.request(), first);
  await first;
  assert.deepEqual(calls, ["inspect-created", "history-ready", "restart"]);
  assert.equal(closeCount, 1);
  assert.deepEqual(states.map((state) => state?.phase ?? null), [
    "waiting", "waiting", "waiting", "waiting", "restarting", null,
  ]);
  assert.equal(coordinator.getViewModel(), null);
});

test("安全重启失败后保留可重试错误状态", async () => {
  const coordinator = createSafeRestartCoordinator({
    createInspector: async () => ({ inspect: async () => ({ ready: true }), async close() {} }),
    waitForReady: async () => {},
    restart: async () => { throw new Error("launch failed"); },
  });
  await assert.rejects(coordinator.request(), /launch failed/);
  assert.deepEqual(coordinator.getViewModel(), {
    phase: "failed",
    message: "安全重启失败：launch failed",
  });
});

test("等待期间确认强制重启会停止检查并只重启一次", async () => {
  const waitStarted = Promise.withResolvers();
  let closeCount = 0;
  let restartCount = 0;
  const coordinator = createSafeRestartCoordinator({
    createInspector: async () => ({
      inspect: async () => ({ ready: false }),
      close: async () => { closeCount++; },
    }),
    waitForReady: async ({ signal }) => {
      waitStarted.resolve();
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
    restart: async () => { restartCount++; },
  });
  const safe = coordinator.request();
  await waitStarted.promise;
  const forced = coordinator.force();
  assert.equal(forced, safe);
  await forced;
  assert.equal(closeCount, 1);
  assert.equal(restartCount, 1);
  assert.equal(coordinator.getViewModel(), null);
});

test("强制重启失败后进入失败状态，重试使用新等待信号并可成功", async () => {
  const starts = [Promise.withResolvers(), Promise.withResolvers()];
  const signals = [];
  const states = [];
  let restartCount = 0;
  let closeCount = 0;
  const coordinator = createSafeRestartCoordinator({
    createInspector: async () => ({
      inspect: async () => ({ ready: false }),
      close: async () => { closeCount++; },
    }),
    waitForReady: async ({ signal }) => {
      assert.equal(signal.aborted, false);
      const index = signals.push(signal) - 1;
      starts[index].resolve();
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
    restart: async () => {
      if (++restartCount === 1) throw new Error("launch failed");
    },
    onChange: state => states.push(state),
  });
  const first = coordinator.request();
  await starts[0].promise;
  assert.equal(coordinator.force(), first);
  await assert.rejects(first, /launch failed/);
  assert.deepEqual(coordinator.getViewModel(), {
    phase: "failed", message: "安全重启失败：launch failed",
  });
  assert.equal(coordinator.pending, null);
  assert.equal(closeCount, 1);

  const retry = coordinator.request();
  await starts[1].promise;
  assert.equal(coordinator.getViewModel().phase, "waiting");
  assert.notEqual(signals[1], signals[0]);
  assert.equal(coordinator.force(), retry);
  await retry;
  assert.equal(restartCount, 2);
  assert.equal(closeCount, 2);
  assert.equal(coordinator.pending, null);
  assert.equal(coordinator.getViewModel(), null);
  assert.equal(states.filter(state => state?.phase === "failed").length, 1);
});

for (const forced of [false, true]) {
  test(`关闭协调器会取消${forced ? "已确认强制重启的" : "普通"}等待，不重启也不发布失败`, async () => {
    const started = Promise.withResolvers();
    const states = [];
    let restartCount = 0;
    let closeCount = 0;
    const coordinator = createSafeRestartCoordinator({
      createInspector: async () => ({
        inspect: async () => ({ ready: false }),
        close: async () => { closeCount++; },
      }),
      waitForReady: async ({ signal }) => {
        started.resolve();
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      restart: async () => { restartCount++; },
      onChange: state => states.push(state),
    });
    const pending = coordinator.request();
    await started.promise;
    if (forced) assert.equal(coordinator.force(), pending);
    coordinator.close();
    await assert.rejects(pending);
    assert.equal(coordinator.pending, null);
    assert.equal(restartCount, 0);
    assert.equal(closeCount, 1);
    assert.equal(states.some(state => state?.phase === "failed"), false);
  });
}
