import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import {
  approved,
  liveBudget,
  liveProfiles,
  selectLiveProfiles,
  startLiveRuntime,
} from "./runtime.mjs";

const profiles = approved ? selectLiveProfiles(await liveProfiles()) : [];
let failed = false;

if (!approved) test("真实历史定向测试未获授权，不读取当前账号或发送模型请求", { skip: true }, () => {});
for (const profile of profiles) test(`[B MOD-03 SES-01 SES-02] ${profile.id} 真实历史恢复与分叉`, { timeout: 180_000 }, async t => {
  if (failed) { t.skip("前一配置失败；停止付费用例，保留尚未执行状态"); return; }
  const budget = liveBudget();
  let r;
  let stage = "启动隔离运行时";
  try {
    r = await startLiveRuntime(t, profile, budget);
    const marker = `HISTORY_${randomBytes(6).toString("hex")}`;
    const { thread } = await r.thread({ approvalPolicy: "never", sandbox: "read-only" });
    stage = "建立短历史";
    assert.match(await r.turn(thread.id,
      `这是隔离的历史测试。不要调用任何工具，只回复 ${marker}。`), new RegExp(marker));
    stage = "恢复任务";
    await r.rpc.request("thread/resume", { threadId: thread.id });
    assert.match(await r.turn(thread.id,
      "不要调用任何工具，只回复上一轮口令。"), new RegExp(marker));
    stage = "分叉任务";
    const fork = await r.rpc.request("thread/fork", { threadId: thread.id, cwd: r.cwd });
    assert.notEqual(fork.thread.id, thread.id);
    assert.match(await r.turn(fork.thread.id,
      "不要调用任何工具，只回复此前口令。"), new RegExp(marker));
    stage = "完成";
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (r) t.diagnostic(`真实历史证据 ${JSON.stringify(await r.diagnostics(stage))}；在途请求可能超过停止阈值。`);
  }
});
