import assert from "node:assert/strict";
import test from "node:test";
import { activateLifecycleTaskTools, bindLifecycleTask } from "../scripts/lifecycle-task-tools.mjs";
import { waitForWindowsTargetHost } from "../scripts/lifecycle-windows/host.mjs";
import { waitForTargetHost } from "../scripts/lifecycle-macos.mjs";

const threadId = "01a0aa58-e184-7023-818a-9bf792b318c4";
const control = { sessionCheckpoint: { turns: [{ path: `/sessions/rollout-${threadId}.jsonl`, turnId: "origin-turn" }] } };
const host = { codexPids: [42], injectorPids: [43], relay: { pid: 44, wslNative: true },
  readiness: { coreReady: true, ready: false, hostToolsReady: false },
  hostHealth: { required: true, status: "idle", threadId: null } };

test("[LCH-04] 只激活检查点唯一绑定的发起任务，多个任务必须明确指定", () => {
  assert.equal(bindLifecycleTask(control).threadId, threadId);
  const other = "01a0aa58-e184-7023-818a-9bf792b318c5";
  const multiple = { sessionCheckpoint: { turns: [...control.sessionCheckpoint.turns,
    { path: `/sessions/rollout-${other}.jsonl`, turnId: "other-turn" }] } };
  assert.throws(() => bindLifecycleTask(multiple), /无法唯一绑定/);
  assert.equal(bindLifecycleTask(multiple, threadId).turnId, "origin-turn");
  assert.throws(() => bindLifecycleTask(control, other), /无法唯一绑定/);
});

for (const platform of ["win32", "darwin"]) {
  test(`[LCH-04] ${platform} 用当前桌面官方深链接激活任务，不发模型请求或打开新实例`, async () => {
    const calls = [];
    const executable = platform === "win32" ? String.raw`C:\Current Clone\ChatGPT.exe` : "/Applications/Current Codex.app/Contents/MacOS/Codex";
    const result = await activateLifecycleTaskTools(control, host, { platform,
      environment: { CODEX_APP_TOOLS_PIPE_PATH: "stale", TASK_FIXTURE: "keep" },
      execFileImpl: async (...args) => { calls.push(args); return { stdout: executable }; } });
    assert.equal(calls.length, 2);
    assert.equal(calls[1][1].at(-1), `codex://threads/${threadId}`);
    assert.equal(calls[1][2].windowsHide, true);
    if (platform === "win32") {
      assert.equal(calls[1][0], executable);
      assert.equal(calls[1][2].env.CODEX_APP_TOOLS_PIPE_PATH, undefined);
      assert.equal(calls[1][2].env.TASK_FIXTURE, "keep");
    } else {
      assert.deepEqual(calls[1].slice(0, 2), ["/usr/bin/open", ["-a", "/Applications/Current Codex.app", `codex://threads/${threadId}`]]);
    }
    assert.equal(result.modelRequests, 0);
    assert.equal(result.codexPid, 42);
  });
}

for (const [platform, wait] of [["Windows/WSL", waitForWindowsTargetHost], ["macOS", waitForTargetHost]]) {
  test(`[LCH-04] ${platform} 主页等待会自动激活一次，并等待发起任务完整工具证据`, async () => {
    let reads = 0;
    let activations = 0;
    const result = await wait(control, { timeoutMs: 1000, pollIntervalMs: 0,
      inspectHost: async () => {
        reads++;
        const ready = reads >= 4;
        return { ...host, hostHealth: { required: true, threadId: ready ? threadId : "other", status: ready ? "ready" : "idle" },
          readiness: { coreReady: true, ready: reads >= 2, hostToolsReady: reads >= 2 } };
      },
      activateTaskTools: async () => { activations++; return { codexPid: 42, threadId, modelRequests: 0 }; } });
    assert.equal(activations, 1);
    assert.equal(reads, 4, "其他任务已就绪不能代替发起任务的工具证据");
    assert.ok(result.taskToolsActivation.verifiedAt);
    assert.equal(result.hostHealth.threadId, threadId);
  });
  test(`[LCH-04] ${platform} 激活任务后工具仍不完整必须失败`, async () => {
    let activations = 0;
    await assert.rejects(wait(control, { timeoutMs: 15, pollIntervalMs: 0,
      inspectHost: async () => host,
      activateTaskTools: async () => { activations++; return { codexPid: 42, threadId }; } }), /就绪超时/);
    assert.equal(activations, 1);
  });
}
