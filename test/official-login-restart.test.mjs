import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { authenticationRecoveryUsesOfficialLogin } from "../src/injector.mjs";
import { recoverLauncherAuthentication } from "../src/launcher-authentication.mjs";
import {
  recoverWithOfficialCodexLogin,
  runOfficialCodexLogin,
  safeLoginDiagnostic,
} from "../src/official-login.mjs";

test("只有无可用账号的恢复结果进入官方登录", () => {
  assert.equal(authenticationRecoveryUsesOfficialLogin({ kind: "login" }), true);
  assert.equal(authenticationRecoveryUsesOfficialLogin({ kind: "switched" }), false);
  assert.equal(authenticationRecoveryUsesOfficialLogin({ kind: "refreshed" }), false);
  assert.equal(authenticationRecoveryUsesOfficialLogin(null), false);
});

test("官方登录调用当前 Codex CLI 并等待成功退出", async () => {
  const child = fakeChild();
  let invocation = null;
  const completed = runOfficialCodexLogin({
    executable: "C:\\Codex\\resources\\codex.exe",
    codexHome: "C:\\Users\\test\\.codex",
    timeoutMs: 1_000,
    spawnProcess(command, args, options) {
      invocation = { command, args, options };
      return child;
    },
  });
  child.stderr.write("Starting local login server\n");
  child.emit("close", 0, null);
  await completed;

  assert.equal(invocation.command, "C:\\Codex\\resources\\codex.exe");
  assert.deepEqual(invocation.args, ["login"]);
  assert.equal(invocation.options.env.CODEX_HOME, "C:\\Users\\test\\.codex");
  assert.equal(invocation.options.windowsHide, true);
  assert.deepEqual(invocation.options.stdio, ["ignore", "pipe", "pipe"]);
});

test("停止注入器会立即取消仍在等待的官方登录", async () => {
  const child = fakeChild();
  const controller = new AbortController();
  const completed = runOfficialCodexLogin({
    executable: "codex.exe",
    codexHome: "C:\\Users\\test\\.codex",
    signal: controller.signal,
    timeoutMs: 1_000,
    spawnProcess: () => child,
  });

  controller.abort();

  await assert.rejects(completed, /官方登录已取消/);
  assert.equal(child.killed, true);
});

test("官方登录恢复先停止桌面，成功落盘后才接受新账号", async () => {
  const calls = [];
  const account = { id: "new-session", authStatus: "active" };
  const manager = {
    codexHome: "C:\\Users\\test\\.codex",
    store: {
      index: { currentAccountId: null },
      get: (id) => id === account.id ? account : null,
    },
    async syncCurrentAccountFromOfficialCredentials() {
      calls.push("sync");
      this.store.index.currentAccountId = account.id;
    },
  };

  const result = await recoverWithOfficialCodexLogin(manager, {
    executable: "codex.exe",
    stop: async () => { calls.push("stop"); },
    login: async (options) => {
      calls.push(["login", options.executable, options.codexHome]);
    },
  });

  assert.deepEqual(calls, [
    "stop",
    ["login", "codex.exe", "C:\\Users\\test\\.codex"],
    "sync",
  ]);
  assert.equal(result, account);
});

test("官方登录错误不会把授权 URL 写入诊断", () => {
  const diagnostic = safeLoginDiagnostic(
    "If your browser did not open\nhttps://auth.openai.com/oauth/authorize?secret=value\nnetwork failed\n",
  );
  assert.equal(diagnostic, "If your browser did not open；network failed");
  assert.doesNotMatch(diagnostic, /secret|auth\.openai\.com/);
});

test("启动器在准备 Relay 前恢复账号，并在无当前账号时进入官方登录", async () => {
  const calls = [];
  const manager = {
    store: {
      list: () => [{ id: "expired" }],
      index: { currentAccountId: "expired" },
    },
    async refreshAll(options) {
      calls.push(options);
      return { authenticationRecovery: { kind: "login" } };
    },
  };

  const result = await recoverLauncherAuthentication(manager);

  assert.deepEqual(calls, [{ recoverCurrentSession: true }]);
  assert.equal(result.officialLoginRequired, true);
  assert.equal(result.refresh.authenticationRecovery.kind, "login");
});

test("启动器成功切换备用账号后继续正常注入启动", async () => {
  const manager = {
    store: {
      list: () => [{ id: "expired" }, { id: "fallback" }],
      index: { currentAccountId: "expired" },
    },
    async refreshAll() {
      this.store.index.currentAccountId = "fallback";
      return { authenticationRecovery: { kind: "switched" } };
    },
  };

  const result = await recoverLauncherAuthentication(manager);

  assert.equal(result.officialLoginRequired, false);
  assert.equal(result.refresh.authenticationRecovery.kind, "switched");
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}
