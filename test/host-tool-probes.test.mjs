import assert from "node:assert/strict";
import test from "node:test";
import { classifyHostToolResult, hostToolArguments } from "../src/host-tool-probes.mjs";
import { successfulHostToolResult } from "./host-tool-fixtures.mjs";

test("四项探针验证业务返回结构，空列表和当前活动回合允许", () => {
  for (const tool of ["list_threads", "read_thread", "list_projects", "get_usage_limits"]) {
    assert.equal(classifyHostToolResult(tool, successfulHostToolResult(tool, "current"), null,
      { targetThreadId: "current" }).status, "passed");
  }
  assert.equal(hostToolArguments("read_thread", "current").threadId, "current");
  assert.equal(hostToolArguments("read_thread", "current").turnLimit, 1);
  assert.equal(classifyHostToolResult("read_thread", successfulHostToolResult("read_thread", "wrong"), null,
    { targetThreadId: "current" }).status, "unconfirmed");
});

test("无错误不等于通过：损坏返回、缺失额度、超时和显式错误分别处理", () => {
  for (const value of [null, {}, { content: {} }, { content: [{ type: "text", text: "not json" }] }]) {
    assert.equal(classifyHostToolResult("list_projects", value).status, "unconfirmed");
  }
  assert.equal(classifyHostToolResult("get_usage_limits", {
    structuredContent: { rateLimits: null, rateLimitsByLimitId: null } }).status, "unconfirmed");
  assert.equal(classifyHostToolResult("list_projects", null, { message: "timed out" }).status, "unconfirmed");
  assert.equal(classifyHostToolResult("list_projects", { isError: true }).status, "failed");
  assert.equal(classifyHostToolResult("list_projects", null, { message: "Unknown tool" }).status, "failed");
});
