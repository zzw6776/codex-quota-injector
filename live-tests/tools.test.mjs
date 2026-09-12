import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  approved,
  liveBudget,
  liveProfiles,
  selectLiveProfiles,
  startLiveRuntime,
} from "./runtime.mjs";

const exec = promisify(execFile);
const profiles = approved ? selectLiveProfiles(await liveProfiles()) : [];
let failed = false;

if (!approved) test("真实工具定向测试未获授权，不读取当前账号或发送模型请求", { skip: true }, () => {});
for (const profile of profiles) test(`[B MOD-03 TOOL-01 TOOL-03 TOOL-07 INT-02] ${profile.id} 真实工作区与 MCP 工具`, { timeout: 180_000 }, async t => {
  if (failed) { t.skip("前一配置失败；停止付费用例，保留尚未执行状态"); return; }
  const budget = liveBudget();
  let r;
  let stage = "启动隔离运行时";
  try {
    r = await startLiveRuntime(t, profile, budget);
    const marker = `TOOLS_${randomBytes(6).toString("hex")}`;
    await exec("/usr/bin/git", ["init", "-q", r.cwd]);
    await writeFile(join(r.cwd, "source.txt"), `${marker}\nBEFORE\n`);

    stage = "文件读取与补丁";
    const fileThread = (await r.thread({ approvalPolicy: "never" })).thread;
    const reply = await r.turn(fileThread.id,
      "这是隔离的兼容性测试。读取 source.txt，记住第一行口令，用 apply_patch 把第二行 BEFORE 改成 AFTER。核对文件后只回复第一行口令。只允许操作当前测试目录，不访问其他文件或网络。");
    assert.equal(await readFile(join(r.cwd, "source.txt"), "utf8"), `${marker}\nAFTER\n`);
    assert.match(reply, new RegExp(marker));

    stage = "MCP 就绪与直调预检";
    const mcpThread = (await r.thread({ approvalPolicy: "on-request" })).thread;
    const status = await r.rpc.request("mcpServerStatus/list", {
      threadId: mcpThread.id,
      detail: "toolsAndAuthOnly",
    });
    assert.match(JSON.stringify(status), /record/, "fixture MCP 未发现 record 工具");
    const preflight = `PREFLIGHT_${marker}`;
    const direct = await r.rpc.request("mcpServer/tool/call", {
      threadId: mcpThread.id,
      server: "fixture",
      tool: "record",
      arguments: { text: preflight },
    });
    assert.match(JSON.stringify(direct), new RegExp(preflight));
    assert.equal(await readFile(join(r.cwd, "mcp-marker.txt"), "utf8"), preflight);
    await unlink(join(r.cwd, "mcp-marker.txt"));

    stage = "模型驱动 MCP 调用";
    let approvals = 0;
    r.rpc.onRequest = async request => {
      assert.equal(request.method, "mcpServer/elicitation/request", `未支持的 MCP 审批请求 ${request.method}`);
      assert.equal(request.params.serverName, "fixture");
      assert.equal(request.params._meta?.codex_approval_kind, "mcp_tool_call");
      assert.equal(request.params._meta?.tool_params?.text, marker);
      approvals++;
      return { action: "accept", content: {} };
    };
    const beforeMcp = r.rpc.events.length;
    const mcpReply = await r.turn(mcpThread.id,
      `必须实际调用名为 mcp__fixture__record 的工具一次，参数 text 必须原样等于 ${marker}。工具成功后只回复 ${marker}，不要调用其他工具。`);
    const mcpItem = r.rpc.events.slice(beforeMcp).find(event =>
      event.method === "item/completed" && event.params?.item?.type === "mcpToolCall" &&
      event.params.item.server === "fixture" && event.params.item.tool === "record")?.params.item;
    assert.ok(mcpItem, "没有模型实际调用 MCP record 的事件");
    assert.equal(mcpItem.status, "completed",
      `模型 MCP record 调用失败：${r.sanitize(mcpItem.error?.message ?? "无错误详情")}`);
    assert.equal(approvals, 1, "写入型 MCP 工具必须只审批一次");
    assert.equal(await readFile(join(r.cwd, "mcp-marker.txt"), "utf8"), marker);
    assert.match(mcpReply, new RegExp(marker));
    const mcp = (await readFile(join(r.cwd, "mcp-events.jsonl"), "utf8"))
      .trim().split("\n").map(JSON.parse);
    assert.equal(mcp.filter(event =>
      event.method === "tools/call" && event.params.name === "record").length, 2,
    "应分别只有一次直调预检和一次模型驱动 MCP 调用");
    stage = "完成";
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (r) t.diagnostic(`真实工具证据 ${JSON.stringify(await r.diagnostics(stage))}；在途请求可能超过停止阈值。`);
  }
});
