import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  browserEnvironment,
  browserLaunchDirectory,
  browserPlatform,
  bridgeWebSocketUrl,
  wslWindowsHostAddress,
} from "../runtime-tests/support/browser.mjs";
import { stopChild, removeRuntimeDirectory } from "../runtime-tests/support/offline-runtime.mjs";
import { waitFor } from "./helpers.mjs";

test("[platform:windows-native] [HAR-01] Windows 浏览器隔离保留真实用户目录并继续隔离浏览器数据", () => {
  const directory = join(tmpdir(), "isolated-browser");
  const env = browserEnvironment(directory, "win32", { USERPROFILE: "C:\\Users\\fixture" }, "win32");
  assert.equal(env.USERPROFILE, "C:\\Users\\fixture");
  assert.equal(env.HOME, directory);
  assert.equal(env.CODEX_HOME, join(directory, "codex-home"));
});

test("[platform:wsl-native] [HAR-01] WSL 浏览器桥接保留互操作变量并把临时目录转换成 Windows 路径", async () => {
  const directory = "/mnt/c/Users/fixture/AppData/Local/Temp/quota-browser";
  const environment = {
    WSL_INTEROP: "/run/WSL/123_interop",
    WSL_DISTRO_NAME: "Ubuntu-24.04",
    WSLENV: "FIXTURE/u",
    OPENAI_API_KEY: "must-not-leak",
  };
  const env = browserEnvironment(directory, "win32", environment, "linux");
  assert.equal(env.WSL_INTEROP, environment.WSL_INTEROP);
  assert.equal(env.WSL_DISTRO_NAME, environment.WSL_DISTRO_NAME);
  assert.equal(env.WSLENV, environment.WSLENV);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(browserPlatform({ CODEX_TEST_BROWSER_PLATFORM: "win32" }, "linux"), "win32");
  assert.equal(await browserLaunchDirectory(directory, "win32", {
    hostPlatform: "linux",
    convertPath: async path => {
      assert.equal(path, directory);
      return "C:\\Users\\fixture\\AppData\\Local\\Temp\\quota-browser\n";
    },
  }), "C:\\Users\\fixture\\AppData\\Local\\Temp\\quota-browser");
  assert.equal(await wslWindowsHostAddress({
    readRoute: async () => "default via 172.31.128.1 dev eth0 proto kernel\n",
  }), "172.31.128.1");
  assert.equal(bridgeWebSocketUrl(
    "ws://127.0.0.1:49317/devtools/page/fixture",
    { host: "172.31.128.1", port: 50428 },
  ), "ws://172.31.128.1:50428/devtools/page/fixture");
});

test("[HAR-01 OBS-03] 测试子进程停止后不会留下占用临时项目的进程", async t => {
  const directory = await mkdtemp(join(tmpdir(), "offline-process-tree-"));
  const marker = join(directory, "ready.txt");
  let child = null;
  t.after(async () => {
    await stopChild(child).catch(() => undefined);
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const worker = `require("node:fs").writeFileSync(process.argv[1], "ready");setInterval(()=>{},1000);`;
  const script = process.platform === "win32"
    ? `const {spawn}=require("node:child_process");spawn(process.execPath,["-e",${JSON.stringify(worker)},process.argv[1]],{cwd:process.cwd(),stdio:"ignore"});setInterval(()=>{},1000);`
    : worker;
  child = spawn(process.execPath, ["-e", script, marker], {
    cwd: directory,
    stdio: "ignore",
  });
  await waitFor(async () => {
    try { return (await readFile(marker, "utf8")) === "ready" || null; }
    catch { return null; }
  }, { timeoutMs: 2_000 });

  await stopChild(child);
  await rm(directory, { recursive: true, force: false });
});

if (process.platform === "win32") test("[platform:windows-native] [HAR-01 OBS-03] 子进程自行退出与 taskkill 失败竞态不会中断后续清理", async t => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 40)"], { stdio: "ignore" });
  t.after(() => stopChild(child).catch(() => undefined));
  await stopChild(child, {
    terminateWindowsTree: async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
      throw new Error("process already exited");
    },
  });
  assert.notEqual(child.exitCode, null);
});

if (process.platform === "win32") test("[platform:windows-native] [HAR-01 OBS-03] 模型测试清理在真实文件锁释放后成功删除临时目录", async t => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-cleanup-lock-"));
  const executable = join(directory, "codex-upstream.exe");
  await writeFile(executable, "sandbox executable fixture");
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = "$stream=[System.IO.File]::Open($env:QUOTA_LOCK_FIXTURE,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::Read); try {[Console]::WriteLine('locked'); [Console]::ReadLine() | Out-Null} finally {$stream.Dispose()}";
  const locker = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, QUOTA_LOCK_FIXTURE: executable },
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  let output = "";
  locker.stdout.on("data", chunk => { output += chunk; });
  let release;
  t.after(async () => {
    clearTimeout(release);
    locker.stdin.end("release\n");
    await stopChild(locker);
    await removeRuntimeDirectory(directory);
  });
  await waitFor(() => output.includes("locked"), { timeoutMs: 5_000 });
  // 先证明这是真实删除失败，而非只模拟 rm 的返回值。
  await assert.rejects(rm(directory, { recursive: true, force: true }),
    error => ["EBUSY", "EPERM", "EACCES"].includes(error.code));
  release = setTimeout(() => locker.stdin.end("release\n"), 150);
  await removeRuntimeDirectory(directory);
  await assert.rejects(stat(directory), { code: "ENOENT" });
});

test("[HAR-01 OBS-03] 已退出父进程的管道被孤儿后代占用时清理仍有界完成", async t => {
  const child = Object.assign(new EventEmitter(), {
    exitCode: 0,
    signalCode: null,
    stdio: [new PassThrough(), new PassThrough(), new PassThrough()],
  });
  child.stdin = child.stdio[0];
  child.stdout = child.stdio[1];
  child.stderr = child.stdio[2];

  const startedAt = Date.now();
  await stopChild(child, { closeTimeoutMs: 50 });
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
});
