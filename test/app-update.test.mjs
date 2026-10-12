import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { releaseUpdate, fetchRelease } from "../src/app-update/releases.mjs";
import { AppUpdateManager } from "../src/app-update/manager.mjs";
import { downloadUpdate } from "../src/app-update/download.mjs";
import { createUpdateRun } from "../src/app-update/runner.mjs";
import { inspectUpdateHistory } from "../src/app-update/history.mjs";
import { startUpdateWindowServer, updateWindowFragment } from "../src/app-update/window.mjs";
import { cleanUpdateEnvironment, loadedFileMatches } from "../src/app-update/native-install.mjs";
import { useTempDir } from "./helpers.mjs";
import { resolveDevUpdateWindow } from "../src/app-update/window-executable.mjs";
import { activeUpdate, waitForUpdateWindow } from "../src/app-update/launch.mjs";

function release(version = "0.1.295", platform = "macos-arm64.dmg") {
  const name = `Codex-Quota-Injector-${version}-${platform}`;
  return { tag_name: `v${version}`, assets: [{ id: 10, name, state: "uploaded", size: 12,
    digest: `sha256:${"a".repeat(64)}`,
    browser_download_url: `https://github.com/zzw6776/codex-quota-injector/releases/download/v${version}/${name}` }] };
}

test("dev 忽略同版本/低版本比较，正式版按语义版本比较；仍必须匹配正式发布和架构", () => {
  const base = { version: "0.1.308", platform: "darwin", arch: "arm64" };
  for (const version of ["0.1.295", "0.1.308", "0.1.309"]) {
    assert.equal(releaseUpdate(release(version), { ...base, mode: "dev" }).version, version);
    assert.equal(releaseUpdate(release(version), { ...base, mode: "formal" })?.version ?? null, version === "0.1.309" ? version : null);
  }
  assert.equal(releaseUpdate(release("0.1.9"), { ...base, version: "0.1.10", mode: "formal" }), null);
  for (const bad of [{ ...release(), draft: true }, { ...release(), prerelease: true },
    release("0.1.295", "macos-x64.dmg"), { tag_name: "v1.2.3", assets: [] }]) {
    assert.equal(releaseUpdate(bad, { ...base, mode: "dev" }), null);
  }
  const wrongSource = release(); wrongSource.assets[0].browser_download_url = "https://example.com/pkg.dmg";
  assert.equal(releaseUpdate(wrongSource, { ...base, mode: "dev" }), null);
  assert.equal(releaseUpdate(release("0.1.295", "windows-x64-Setup.exe"), { ...base, mode: "dev", platform: "win32", arch: "x64" }).version, "0.1.295");
});

test("检查合并、ETag 304 保留结果；网络异常不清除候选，重复点击只开一个更新窗口", async t => {
  let calls = 0, launches = 0, resolveWindow;
  const manager = new AppUpdateManager({ version: "0.1.308", mode: "dev", platform: "darwin", arch: "arm64",
    async fetchLatest({ etag }) { calls++; if (!etag) return { release: release(), etag: "cached" };
      if (calls === 2) return { unchanged: true }; throw new Error("offline"); },
    readOwner: async () => ({ pid: process.pid, mode: "dev", version: "0.1.308" }),
    launch: async () => { launches++; return new Promise(resolve => { resolveWindow = resolve; }); },
  });
  t.after(() => manager.close());
  await Promise.all([manager.check(), manager.check()]); assert.equal(calls, 1);
  assert.equal(manager.getViewModel().available, true);
  await manager.check(); await manager.check();
  assert.equal(manager.getViewModel().available, true);
  assert.equal(manager.getViewModel().error, null);
  const first = manager.open(), second = manager.open();
  assert.equal(manager.getViewModel().opening, true);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(launches, 1); resolveWindow("window");
  assert.deepEqual(await Promise.all([first, second]), ["window", "window"]);
  assert.equal(manager.getViewModel().opening, false);
  const headers = [];
  const unchanged = await fetchRelease({ etag: "cached", fetchImpl: async (_url, options) => {
    headers.push(options.headers); return new Response(null, { status: 304 }); } });
  assert.equal(unchanged.unchanged, true); assert.equal(headers[0]["If-None-Match"], "cached");
});

test("dev 只跳过版本比较，下载仍校验全部字节；网络/摘要/大小异常不产生可安装文件", async t => {
  const directory = await useTempDir(t, "update-download-");
  const bytes = Buffer.from("actual-release-package");
  const asset = { url: "https://github.com/fixture", size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") };
  const path = join(directory, "package.dmg");
  await downloadUpdate(asset, path, { fetchImpl: async () => new Response(bytes) });
  assert.deepEqual(await readFile(path), bytes);
  for (const [label, patch, response] of [["hash", { sha256: "0".repeat(64) }, new Response(bytes)],
    ["size", { size: 1 }, new Response(bytes)], ["missing", { sha256: null }, new Response(bytes)],
    ["http", {}, new Response("failed", { status: 500 })]]) {
    await assert.rejects(downloadUpdate({ ...asset, ...patch }, join(directory, label), { fetchImpl: async () => response }));
  }
  assert.deepEqual(await readdir(directory), ["package.dmg"]);
});

function fakeRun(overrides = {}) {
  const calls = [], states = [];
  let probes = 0, readiness = 0;
  const run = createUpdateRun({ id: "job", directory: "/temporary", owner: { mode: "dev", version: "0.1.308" },
    asset: { version: "0.1.295", name: "pkg.dmg", size: 12, platform: "darwin" } }, {
    onState: state => states.push({ ...state }),
    download: async (_asset, path, options) => { calls.push("download"); options.onProgress(12, 12); return path; },
    prepare: async () => { calls.push("prepare"); return {}; },
    history: async () => { probes++; return { ready: probes >= 3, reason: "等待任务结束", tracked: ["turn"] }; },
    stop: async () => { calls.push("stop"); return "lock"; },
    releaseLock: async () => { calls.push("release"); },
    install: async () => { calls.push("install"); }, launch: async () => { calls.push("launch"); },
    ready: async () => ++readiness >= 2, sleep: async () => {}, ...overrides,
  });
  return { run, calls, states };
}

test("确认前不下载，重复确认不重跑；任务落盘后接管，启动核验后保留成功状态", async () => {
  const { run, calls, states } = fakeRun();
  assert.deepEqual(calls, []); assert.equal(run.state.status, "confirm");
  const first = run.confirm(); assert.equal(run.confirm(), first);
  await first;
  assert.deepEqual(calls, ["download", "prepare", "stop", "install", "release", "launch"]);
  assert.equal(run.state.status, "success");
  assert.ok(states.some(state => state.status === "waiting" && state.message === "等待任务结束"));
  assert.match(updateWindowFragment(run.state), /窗口将保留/);
  assert.doesNotMatch(updateWindowFragment(run.state), /disabled/);
});

test("下载/校验失败不关闭应用；安装或正式进程核验失败不假报成功，保留错误窗口", async () => {
  for (const stage of ["download", "prepare", "install", "ready"]) {
    const f = fakeRun({ [stage]: async () => { throw new Error(`${stage} failed`); } });
    await f.run.confirm();
    assert.equal(f.run.state.status, "failed");
    assert.match(f.run.state.message, new RegExp(stage));
    if (["download", "prepare"].includes(stage)) assert.ok(!f.calls.includes("stop"));
    assert.doesNotMatch(updateWindowFragment(f.run.state), /disabled/);
  }
});

test("活动回合、历史投影落后或结构损坏均阻止更新；新任务被纳入原检查集合", async () => {
  let active = true, durable = false;
  const deps = { capture: async () => ({ turns: active ? [{ path: "/rollout.jsonl", turnId: "turn" }] : [] }),
    inspectHistory: async () => ({ lastOrdinal: 10, repairRequired: false }),
    inspectStore: async options => { assert.deepEqual(options.turnIds, ["turn"]); return { healthy: durable }; },
  };
  let result = await inspectUpdateHistory({}, [], deps);
  assert.equal(result.ready, false);
  active = false;
  result = await inspectUpdateHistory({}, result.tracked, deps);
  assert.equal(result.ready, false); assert.match(result.reason, /投影/);
  durable = true;
  assert.equal((await inspectUpdateHistory({}, result.tracked, deps)).ready, true);
  await assert.rejects(inspectUpdateHistory({}, result.tracked, { ...deps,
    inspectHistory: async () => ({ repairRequired: true }) }), /历史结构不完整/);
});

test("独立状态窗口在终态前拒绝关闭，终态不会自动关闭；外部网页不能触发更新", async t => {
  let status = "confirm", confirmations = 0, closes = 0;
  const window = await startUpdateWindowServer({ port: 0,
    state: () => ({ status, version: "0.1.295", message: "<script>bad</script>" }),
    confirm: () => { confirmations++; status = "downloading"; }, close: () => { closes++; } });
  t.after(() => window.close());
  const html = await fetch(window.url).then(r => r.text());
  assert.match(html, /setInterval\(refresh/);
  const body = await fetch(`${window.url}fragment`).then(r => r.text());
  assert.match(body, /&lt;script&gt;/); assert.doesNotMatch(body, /<script>bad/);
  assert.equal((await fetch(`${window.url}confirm`, { method: "POST", headers: { Origin: "https://other.example" } })).status, 403);
  assert.equal(confirmations, 0);
  await fetch(`${window.url}confirm`, { method: "POST" });
  assert.equal((await fetch(`${window.url}close`, { method: "POST" })).status, 409);
  assert.equal(closes, 0);
  status = "success";
  assert.equal((await fetch(`${window.url}state`)).status, 200);
  assert.equal(closes, 0);
  assert.equal((await fetch(`${window.url}close`, { method: "POST" })).status, 200);
  await new Promise(resolve => setTimeout(resolve, 125));
  assert.equal(closes, 1);
});

test("更新后的正式入口清除开发启动和 Relay 角色，防止落入错误启动模式", () => {
  assert.deepEqual(cleanUpdateEnvironment({ PATH: "path", HOME: "home", CODEX_QUOTA_ROLE: "app-updater",
    CODEX_QUOTA_RELAY_CONFIG: "relay", CODEX_CLI_PATH: "cli", NODE_OPTIONS: "--import old", CODEX_APP_TOOLS_PIPE_PATH: "pipe" }),
  { PATH: "path", HOME: "home" });
});

test("启动确认核对实际加载的可执行文件 inode，不能由同名旧文件冒充成功", () => {
  const output = "p100\nftxt\nD0x10\ni20\nn/Applications/Worker\nftxt\nD0x11\ni21\nn/library\n";
  assert.equal(loadedFileMatches(output, { dev: 16n, ino: 20n }), true);
  assert.equal(loadedFileMatches(output, { dev: 16n, ino: 21n }), false);
  assert.equal(loadedFileMatches("ftxt\nDinvalid\ni20", { dev: 16n, ino: 20n }), false);
});

test("dev 窗口预编译与点击共享同一构建；相同源码复用，变化后重建，失败不留下缓存", async t => {
  const root = await useTempDir(t, "update-window-cache-");
  await mkdir(join(root, "src"));
  const source = join(root, "src", "macos-update-window.swift");
  await writeFile(source, "first");
  let compilations = 0;
  const options = { root, arch: "arm64", async compile(input, output) {
    compilations++; await writeFile(output, await readFile(input));
  } };
  const [first, duplicate] = await Promise.all([resolveDevUpdateWindow(options), resolveDevUpdateWindow(options)]);
  assert.equal(first, duplicate); assert.equal(compilations, 1);
  assert.equal(await resolveDevUpdateWindow(options), first); assert.equal(compilations, 1);
  await writeFile(source, "changed");
  const changed = await resolveDevUpdateWindow(options);
  assert.notEqual(changed, first); assert.equal(compilations, 2);
  await writeFile(source, "failed");
  await assert.rejects(resolveDevUpdateWindow({ ...options, compile: async () => { throw new Error("compiler failed"); } }));
  assert.deepEqual((await readdir(join(root, "build"))).sort(), [first, changed].map(path => path.split('/').pop()).sort());
});

test("独立更新实例自动分配不同端口；登记服务不等于窗口就绪，登记必须匹配任务", async t => {
  const directory = await useTempDir(t, "update-ports-");
  const windows = await Promise.all(["one", "two"].map(id => startUpdateWindowServer({
    state: () => ({ id, status: "confirm" }), confirm() {}, close() {},
  })));
  t.after(() => Promise.all(windows.map(window => window.close())));
  assert.notEqual(new URL(windows[0].url).port, new URL(windows[1].url).port);
  for (const [index, id] of ["one", "two"].entries()) {
    const path = join(directory, `${id}.json`);
    await writeFile(path, JSON.stringify({ id, pid: process.pid, url: windows[index].url }));
    assert.equal((await activeUpdate(path)).windowReady, false);
    assert.equal((await fetch(`${windows[index].url}ready`, { method: "POST", headers: { Origin: "https://other.example" } })).status, 403);
    assert.equal((await activeUpdate(path)).windowReady, false);
    await fetch(`${windows[index].url}ready`, { method: "POST" });
    assert.equal((await activeUpdate(path)).windowReady, true);
    await writeFile(path, JSON.stringify({ id: "different", pid: process.pid, url: windows[index].url }));
    assert.equal(await activeUpdate(path), null);
  }
});

test("慢启动超过旧六秒限制仍等待页面就绪，不接受其他任务或尚未渲染的服务", async () => {
  let time = 0;
  const descriptor = { id: "expected", windowReady: true };
  const result = await waitForUpdateWindow({ id: "expected", logPath: "fixture.log" }, {
    now: () => time, sleep: async ms => { time += ms; },
    readActive: async () => time < 1000 ? { id: "other", windowReady: true }
      : time < 9000 ? { id: "expected", windowReady: false } : descriptor,
  });
  assert.equal(result, descriptor); assert.equal(time, 9000);
});

test("窗口进程早退立即报告退出原因；页面未就绪超时保留日志位置", async () => {
  let time = 0;
  const options = { now: () => time, sleep: async ms => { time += ms; }, readActive: async () => null };
  await assert.rejects(waitForUpdateWindow({ id: "expected", logPath: "fixture.log",
    childState: () => time >= 200 ? "退出码 1" : null }, options), /退出码 1.*fixture.log/);
  assert.equal(time, 200);
  time = 0;
  await assert.rejects(waitForUpdateWindow({ id: "expected", logPath: "fixture.log" }, {
    ...options, timeoutMs: 300, readActive: async () => ({ id: "expected", windowReady: false }),
  }), /启动超时.*fixture.log/);
  assert.equal(time, 300);
});
