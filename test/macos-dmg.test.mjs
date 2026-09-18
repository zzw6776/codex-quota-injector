import assert from "node:assert/strict";
import { mkdir, open, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createMacDmg, planMacDmg } from "../scripts/package-macos-dmg.mjs";
import { useTempDir } from "./helpers.mjs";

const MIB = 1024 * 1024;

test("DMG 容量按稀疏文件逻辑大小计算并为大应用保留比例余量", async t => {
  const directory = await useTempDir(t, "mac-dmg-size-");
  const appPath = join(directory, "Example.app");
  await mkdir(join(appPath, "Contents"), { recursive: true });
  const file = await open(join(appPath, "Contents", "Worker"), "w");
  try { await file.truncate(300 * MIB + 1); } finally { await file.close(); }
  const plan = await planMacDmg(appPath);
  assert.equal(plan.logicalBytes, 300 * MIB + 1);
  assert.equal(plan.entries, 3);
  assert.equal(plan.imageMiB, 376);
});

test("DMG 容量不跟随包内符号链接并保留最小文件系统余量", { skip: process.platform === "win32" }, async t => {
  const appPath = await useTempDir(t, "mac-dmg-link-");
  await writeFile(join(appPath, "Worker"), "worker");
  await symlink(".", join(appPath, "loop"));
  const plan = await planMacDmg(appPath);
  assert.equal(plan.entries, 3);
  assert.equal(plan.logicalBytes, 7);
  assert.equal(plan.imageMiB, 65);
});

test("DMG 创建显式容量和 HFS+，完成后验证镜像并输出磁盘证据", async t => {
  const appPath = await useTempDir(t, "mac-dmg-command-");
  const dmgPath = join(appPath, "result.dmg");
  const commands = [], logs = [];
  const plan = await createMacDmg({ appPath, dmgPath,
    run: (...args) => commands.push(args), log: value => logs.push(value) });
  assert.deepEqual(commands.map(([command, args]) => [command, args]), [
    ["/usr/bin/hdiutil", ["create", "-volname", "Codex Quota Injector", "-srcfolder", appPath,
      "-fs", "HFS+", "-size", `${plan.imageMiB}m`, "-ov", "-format", "UDZO", dmgPath]],
    ["/usr/bin/hdiutil", ["verify", dmgPath]],
  ]);
  const evidence = JSON.parse(logs[0].slice("[dmg] ".length));
  assert.equal(evidence.diskSpace.length, 2);
  assert.ok(evidence.diskSpace.every(item => item.availableBytes >= 0));
});

test("DMG 创建失败保留原错误和磁盘证据，不盲目重试或验证残缺镜像", async t => {
  const appPath = await useTempDir(t, "mac-dmg-error-");
  const failure = new Error("No space left on device");
  const logs = [];
  let calls = 0;
  await assert.rejects(createMacDmg({ appPath, dmgPath: join(appPath, "failed.dmg"),
    run() { calls++; throw failure; }, log: value => logs.push(value) }), error => error === failure);
  assert.equal(calls, 1);
  assert.equal(logs.length, 2);
  assert.match(logs[1], /failed; diskSpace=/);
});
