import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, readlinkSync } from "node:fs";
import { mkdir, open, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
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

test("DMG 同时包含应用和应用程序快捷方式，完成后清理暂存并验证镜像", { skip: process.platform !== "darwin" }, async t => {
  const appPath = await useTempDir(t, "mac-dmg-command-");
  await writeFile(join(appPath, "Worker"), "worker");
  const dmgPath = join(appPath, "result.dmg");
  const commands = [], logs = [];
  const plan = await createMacDmg({ appPath, dmgPath,
    run: (...args) => {
      commands.push(args);
      if (args[1][0] === "create") {
        const stagingDir = args[1][4];
        assert.equal(readlinkSync(join(stagingDir, "Applications")), "/Applications");
        assert.ok(lstatSync(join(stagingDir, basename(appPath))).isDirectory());
        const original = lstatSync(join(appPath, "Worker"));
        const staged = lstatSync(join(stagingDir, basename(appPath), "Worker"));
        assert.ok(staged.isFile());
        assert.equal(staged.dev, original.dev);
        assert.equal(staged.ino, original.ino);
      }
    }, log: value => logs.push(value) });
  const stagingDir = commands[0][1][4];
  assert.deepEqual(commands.map(([command, args]) => [command, args]), [
    ["/usr/bin/hdiutil", ["create", "-volname", "Codex Quota Injector", "-srcfolder", stagingDir,
      "-fs", "HFS+", "-size", `${plan.imageMiB}m`, "-ov", "-format", "UDZO", dmgPath]],
    ["/usr/bin/hdiutil", ["verify", dmgPath]],
  ]);
  assert.throws(() => lstatSync(stagingDir), { code: "ENOENT" });
  const evidence = JSON.parse(logs[0].slice("[dmg] ".length));
  assert.equal(evidence.diskSpace.length, 2);
  assert.ok(evidence.diskSpace.every(item => item.availableBytes >= 0));
});

test("DMG 创建失败保留原错误和磁盘证据，不盲目重试或验证残缺镜像", { skip: process.platform !== "darwin" }, async t => {
  const appPath = await useTempDir(t, "mac-dmg-error-");
  const failure = new Error("No space left on device");
  const logs = [];
  let calls = 0;
  let stagingDir;
  await assert.rejects(createMacDmg({ appPath, dmgPath: join(appPath, "failed.dmg"),
    run(_command, args) { calls++; stagingDir = args[4]; throw failure; },
    log: value => logs.push(value) }), error => error === failure);
  assert.equal(calls, 1);
  assert.throws(() => lstatSync(stagingDir), { code: "ENOENT" });
  assert.equal(logs.length, 2);
  assert.match(logs[1], /failed; diskSpace=/);
});

test("真实 DMG 挂载后可见应用及指向系统应用程序目录的快捷方式", { skip: process.platform !== "darwin" }, async t => {
  const directory = await useTempDir(t, "mac-dmg-mounted-");
  const appPath = join(directory, "Example.app");
  const mountPath = join(directory, "mounted");
  const dmgPath = join(directory, "Example.dmg");
  await mkdir(appPath);
  await mkdir(mountPath);
  await writeFile(join(appPath, "Worker"), "worker");
  await createMacDmg({ appPath, dmgPath, log: () => {} });
  execFileSync("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mountPath, dmgPath]);
  try {
    assert.ok(lstatSync(join(mountPath, "Example.app", "Worker")).isFile());
    assert.ok(lstatSync(join(mountPath, "Applications")).isSymbolicLink());
    assert.equal(readlinkSync(join(mountPath, "Applications")), "/Applications");
  } finally {
    execFileSync("/usr/bin/hdiutil", ["detach", mountPath]);
  }
});
