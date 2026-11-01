import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { RolloutWorkerClient } from "../src/token-usage/rollout-worker.mjs";

class FakeWorker extends EventEmitter {
  messages = [];
  terminateCalls = 0;

  postMessage(message) {
    this.messages.push(message);
  }

  terminate() {
    this.terminateCalls += 1;
    return Promise.resolve(0);
  }
}

test("rollout 解析 Worker 完成请求后空闲退出，后续按需重建", async () => {
  const workers = [];
  const timers = new Set();
  const client = new RolloutWorkerClient({
    idleTimeoutMs: 30_000,
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    setTimer: (callback) => { timers.add(callback); return callback; },
    clearTimer: (callback) => timers.delete(callback),
  });
  const state = { path: "/tmp/rollout.jsonl", offset: 0, pending: "" };
  const first = client.readRolloutInWorker(state, false);
  workers[0].emit("message", { id: workers[0].messages[0].id, ok: true, offset: 0 });
  await first;
  assert.equal(timers.size, 1);
  const terminate = [...timers][0];
  timers.delete(terminate);
  terminate();
  assert.equal(workers[0].terminateCalls, 1);

  const second = client.readRolloutInWorker(state, false);
  assert.equal(workers.length, 2);
  workers[1].emit("message", { id: workers[1].messages[0].id, ok: true, offset: 0 });
  await second;
  client.closeRolloutWorker();
});
