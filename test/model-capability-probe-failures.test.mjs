import assert from "node:assert/strict";
import test from "node:test";
import { probeModelCompatibility } from "../src/model-capability-probe.mjs";
import { TARGET, capabilityProvider, jsonResponse } from "./model-capability-probe/support.mjs";

test("Responses custom 转换遇到临时上游故障时不错误降级到 Chat", async () => {
  const provider = capabilityProvider({
    customTools: "ignored",
    bridgedCustom: "temporary-error",
  });
  await assert.rejects(
    probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch }),
    /Responses custom 工具转换检测失败：temporary unavailable/,
  );
  assert.equal(provider.requests.some(({ path }) => path.endsWith("/chat/completions")), false);
});

test("认证、限流和网络失败不会被误判为另一个协议", async () => {
  let requests = 0;
  await assert.rejects(
    probeModelCompatibility({
      ...TARGET,
      fetchImpl: async () => {
        requests += 1;
        return jsonResponse({ error: { message: "invalid key" } }, 401);
      },
    }),
    /Responses 能力检测失败：invalid key/,
  );
  assert.equal(requests, 1);
});

test("HTTP 200 错误包络仍按失败处理并移除不兼容的指定 tool_choice", async () => {
  const provider = capabilityProvider({
    responses: "missing",
    rejectSpecifiedToolChoiceWithSuccessStatus: true,
    image: "unsupported",
  });
  const result = await probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch });

  assert.equal(result.protocol, "chat");
  assert.equal(result.capabilities.toolChoice, "unsupported");
  assert.equal(result.codexConformance, "passed");
  const chatRequests = provider.requests.filter(({ path }) => path.endsWith("/chat/completions"));
  assert.ok(chatRequests.some(({ body }) => body.tool_choice?.function?.name === "codex_quota_capability_probe"));
  assert.ok(chatRequests.some(({ body }) =>
    body.tools?.length === 3 && body.tool_choice == null));
});
