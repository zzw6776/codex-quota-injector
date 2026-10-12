import assert from "node:assert/strict";
import { readFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createHostHealthTracker } from "../src/host-health.mjs";
import { useTempDir } from "./helpers.mjs";
import { proveHostTools } from "./host-tool-fixtures.mjs";

async function readState(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function fileError(code) {
  return Object.assign(new Error(`rename: ${code}`), { code });
}

test("Windows 临时替换错误不会丢失最后一次工具就绪状态", async (t) => {
  const directory = await useTempDir(t, "health-persist-");
  const path = join(directory, "health.json");
  const errors = t.mock.method(console, "error", () => {});
  const transientErrors = ["EPERM", "EACCES", "EBUSY"];
  let readyAttempts = 0;
  const tracker = await createHostHealthTracker({
    path, platform: "win32",
    renameFile: async (source, destination) => {
      if ((await readState(source)).tasks?.task?.toolsVerified) {
        const code = transientErrors[readyAttempts++];
        if (code) throw fileError(code);
      }
      await rename(source, destination);
    },
  });
  proveHostTools(tracker, "task");
  // 排空最后一次状态写入；没有后续事件替失败写入补发状态。
  await tracker.close({ disconnected: false });
  const state = await readState(path);
  assert.equal(state.tasks.task.toolsVerified, true);
  assert.equal(state.tasks.task.status, "ready");
  assert.equal(readyAttempts, 4);
  assert.equal(errors.mock.callCount(), 0);
  assert.deepEqual(await readdir(directory), ["health.json"]);
});

for (const duringClaim of [false, true]) {
  test(`Windows 替换重试期间接管不会被旧${duringClaim ? "登记" : "状态"}覆盖`, async (t) => {
    const directory = await useTempDir(t, "health-owner-");
    const path = join(directory, "health.json");
    const errors = t.mock.method(console, "error", () => {});
    let successor;
    let attempts = 0;
    const tracker = await createHostHealthTracker({
      path, platform: "win32", sessionId: "old-session",
      renameFile: async (source, destination) => {
        const state = await readState(source);
        if (duringClaim || state.tasks?.task?.toolsVerified) {
          attempts += 1;
          successor = await createHostHealthTracker({ path, sessionId: "new-session" });
          throw fileError("EPERM");
        }
        await rename(source, destination);
      },
    });
    if (!duringClaim) proveHostTools(tracker, "task");
    await tracker.close({ disconnected: false });
    assert.equal((await readState(path)).sessionId, "new-session");
    assert.equal(attempts, 1, "接管后旧会话不得再次替换");
    assert.equal(errors.mock.callCount(), 0);
    await successor.close({ disconnected: false });
    assert.deepEqual(await readdir(directory), ["health.json"]);
  });
}

test("Windows 持续替换失败有限结束、清理临时文件且后续更新仍可写入", async (t) => {
  const directory = await useTempDir(t, "health-exhausted-");
  const path = join(directory, "health.json");
  const errors = t.mock.method(console, "error", () => {});
  let fail = false;
  let attempts = 0;
  const tracker = await createHostHealthTracker({
    path, platform: "win32",
    renameFile: async (source, destination) => {
      if (fail) {
        attempts += 1;
        throw fileError("EPERM");
      }
      await rename(source, destination);
    },
  });
  const previous = await readState(path);
  fail = true;
  await tracker.update({ message: "first-update" });
  assert.deepEqual(await readState(path), previous, "失败保留完整旧状态");
  assert.equal(attempts, 5);
  assert.equal(errors.mock.callCount(), 1);
  assert.deepEqual(await readdir(directory), ["health.json"]);
  fail = false;
  await tracker.update({ message: "recovered-update" });
  await tracker.close({ disconnected: false });
  assert.equal((await readState(path)).message, "recovered-update");
});

for (const [platform, code] of [["win32", "ENOSPC"], ["darwin", "EPERM"]]) {
  test(`${platform} 的 ${code} 不进入临时替换重试`, async (t) => {
    const directory = await useTempDir(t, "health-no-retry-");
    const path = join(directory, "health.json");
    const errors = t.mock.method(console, "error", () => {});
    let attempts = 0;
    const tracker = await createHostHealthTracker({
      path, platform,
      renameFile: async () => { attempts += 1; throw fileError(code); },
    });
    await tracker.close({ disconnected: false });
    assert.equal(attempts, 1);
    assert.equal(errors.mock.callCount(), 1);
    assert.deepEqual(await readdir(directory), []);
  });
}
