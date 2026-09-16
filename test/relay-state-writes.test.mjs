import assert from "node:assert/strict";
import { readFile, stat, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { claimRelayState } from "../src/app-server-relay/ownership.mjs";
import { useTempDir } from "./helpers.mjs";

test("同一 Relay 身份重复认领不替换状态文件，身份或代次变化仍更新", async (t) => {
  const directory = await useTempDir(t);
  const path = join(directory, "relay-state.json");
  const identity = { pid: process.pid, processStartedAt: Date.now() - 1_000 };
  for (const owner of [identity, { ...identity, bootId: "fixture-boot", processStartTicks: 123 }]) {
    assert.equal(await claimRelayState(path, "first", owner), true);
    const before = await readFile(path, "utf8");
    const info = await stat(path);
    for (let i = 0; i < 3; i++) assert.equal(await claimRelayState(path, "first", owner), true);
    assert.equal(await readFile(path, "utf8"), before);
    const after = await stat(path);
    assert.equal(after.ino, info.ino, "原子替换即使写入相同内容也会触发健康监听");
    assert.equal(after.mtimeMs, info.mtimeMs);
  }
  const next = { ...identity, processStartedAt: identity.processStartedAt + 10 };
  await claimRelayState(path, "second", next);
  const changed = JSON.parse(await readFile(path, "utf8"));
  assert.equal(changed.generation, "second");
  assert.equal(changed.processStartedAt, next.processStartedAt);
  assert.equal(Object.hasOwn(changed, "bootId"), false);
  await unlink(path);
  assert.equal(await claimRelayState(path, "second", next), true, "状态被删除后仍能重建");
});

test("其他存活所有者不被覆盖，陈旧结构和已退出所有者仍可恢复", async (t) => {
  const directory = await useTempDir(t);
  const path = join(directory, "relay-state.json");
  const current = { pid: process.pid, processStartedAt: 100 };
  await claimRelayState(path, "fixture", current);
  const before = await readFile(path, "utf8");
  assert.equal(await claimRelayState(path, "fixture", { pid: 2_147_483_647, processStartedAt: 200 }), false);
  assert.equal(await readFile(path, "utf8"), before);
  await writeFile(path, JSON.stringify({ ...JSON.parse(before), pid: 2_147_483_647 }));
  assert.equal(await claimRelayState(path, "fixture", current), true);
  await writeFile(path, JSON.stringify({ ...JSON.parse(before), version: 0 }));
  assert.equal(await claimRelayState(path, "fixture", current), true);
  assert.equal(await readFile(path, "utf8").then(JSON.parse).then(value => value.version > 0), true);
});
