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

if (!approved) test("真实压缩定向测试未获授权，不读取当前账号或发送模型请求", { skip: true }, () => {});
for (const profile of profiles) test(`[B MOD-03 SES-06] ${profile.id} 真实显式压缩与恢复`, { timeout: 180_000 }, async t => {
  if (failed) { t.skip("前一配置失败；停止付费用例，保留尚未执行状态"); return; }
  const budget = liveBudget();
  let r;
  let stage = "启动隔离运行时";
  try {
    r = await startLiveRuntime(t, profile, budget);
    const marker = `COMPACT_${randomBytes(6).toString("hex")}`;
    const { thread } = await r.thread({ approvalPolicy: "never", sandbox: "read-only" });
    stage = "建立压缩前历史";
    assert.match(await r.turn(thread.id,
      `这是隔离的压缩测试。不要调用任何工具，记住并只回复口令 ${marker}。`), new RegExp(marker));
    stage = "执行显式压缩";
    const after = r.rpc.events.length;
    await r.rpc.request("thread/compact/start", { threadId: thread.id });
    const compacted = await r.rpc.event("turn/completed", p => p.threadId === thread.id,
      { after, timeoutMs: 90_000 });
    assert.equal(compacted.turn.status, "completed", "显式压缩失败不能视作支持");
    assert.ok(r.rpc.events.slice(after).some(event =>
      event.method === "item/completed" && event.params?.threadId === thread.id &&
      event.params?.item?.type === "contextCompaction"), "没有收到压缩完成事件");
    stage = "验证压缩后历史";
    assert.match(await r.turn(thread.id,
      "不要调用任何工具，只回复压缩前记住的口令。"), new RegExp(marker));
    stage = "完成";
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (r) t.diagnostic(`真实压缩证据 ${JSON.stringify(await r.diagnostics(stage))}；在途请求可能超过停止阈值。`);
  }
});
