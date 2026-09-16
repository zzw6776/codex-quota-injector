import assert from "node:assert/strict";
import test from "node:test";
import { MODEL_CAPABILITY_PROBE_TIMEOUT_MS, probeModelCompatibility } from "../src/model-capability-probe.mjs";
import { TARGET, capabilityProvider } from "./model-capability-probe/support.mjs";

test("模型能力探测默认允许慢推理请求等待 90 秒", () => {
  assert.equal(MODEL_CAPABILITY_PROBE_TIMEOUT_MS, 90_000);
});

test("Chat 普通模式支持指定工具且推理模式只允许 auto 时分别记录能力", async () => {
  const provider = capabilityProvider({
    responses: "missing",
    thinkingByDefault: true,
    reasoningToolChoice: "auto-only",
    image: "unsupported",
  });
  const result = await probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch });

  assert.equal(result.protocol, "chat");
  assert.equal(result.capabilities.toolChoice, "native");
  assert.equal(result.capabilities.reasoning, "native");
  assert.equal(result.capabilities.reasoningToolChoice, "auto-only");
  assert.equal(result.supportsReasoning, true);
  assert.deepEqual(result.reasoningEfforts, ["low", "medium", "high", "xhigh", "max"]);
  assert.ok(provider.requests.some(({ body }) =>
    body.reasoning_effort === "none" && body.tool_choice?.function?.name === "codex_quota_capability_probe"),
  "普通模式必须真实验证指定工具选择");
  assert.ok(provider.requests.some(({ body }) =>
    body.reasoning_effort === "high" && body.tool_choice === "auto"),
  "推理模式必须真实验证自动工具选择");
});

test("推理参数未产生推理内容时不发布推理能力和强度", async () => {
  const provider = capabilityProvider({
    customTools: "native",
    bridgedCustom: "valid",
    namespaceTools: "native",
    reasoningEfforts: [],
    image: "supported",
  });
  const result = await probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch });

  assert.equal(result.capabilities.reasoning, "unsupported");
  assert.equal(result.capabilities.reasoningToolChoice, "unsupported");
  assert.equal(result.supportsReasoning, false);
  assert.deepEqual(result.reasoningEfforts, []);
});

test("reasoning 私有信封被拒绝后使用纯文本历史，且 tool_choice 能力独立记录", async () => {
  const provider = capabilityProvider({
    responsesHistory: "text-only",
    customTools: "native",
    namespaceTools: "native",
    rejectToolChoice: true,
    image: "supported",
  });
  const result = await probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch });

  assert.equal(result.protocol, "responses");
  assert.equal(result.historyMode, "reasoning-text-only");
  assert.equal(result.capabilities.toolChoice, "unsupported");
  assert.equal(result.capabilities.reasoningHistory, "bridged");
  const strippedContinuation = provider.requests.find(({ body }) =>
    Array.isArray(body.input) && body.input.some((item) => item?.type === "custom_tool_call_output"));
  assert.ok(strippedContinuation);
  assert.equal(strippedContinuation.body.input.some((item) => item?.encrypted_content), false);
});

test("没有实际产生 reasoning 项时不把推理历史能力误标为原生", async () => {
  const provider = capabilityProvider({
    responsesReasoning: false,
    customTools: "native",
    namespaceTools: "native",
    image: "supported",
  });
  const result = await probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch });

  assert.equal(result.protocol, "responses");
  assert.equal(result.capabilities.reasoningHistory, "inconclusive");
  assert.equal(result.historyMode, "reasoning-text-only");
});

test("基础工具请求不含 reasoning 时用推理工具续接检测选择纯文本历史", async () => {
  const provider = capabilityProvider({
    responsesReasoning: false,
    reasoningToolOutput: true,
    responsesHistory: "text-only",
    customTools: "native",
    namespaceTools: "native",
    image: "supported",
  });
  const result = await probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch });

  assert.equal(result.protocol, "responses");
  assert.equal(result.historyMode, "reasoning-text-only");
  assert.equal(result.capabilities.reasoningHistory, "bridged");
  const fullContinuation = provider.requests.find(({ body }) =>
    body.reasoning?.effort === "high" && Array.isArray(body.input) &&
    body.input.some((item) => item?.type === "function_call_output") &&
    body.input.some((item) => item?.encrypted_content));
  assert.ok(fullContinuation, "必须先真实提交完整推理历史");
  const strippedContinuation = provider.requests.find(({ body }) =>
    body.reasoning?.effort === "high" && Array.isArray(body.input) &&
    body.input.some((item) => item?.type === "function_call_output") &&
    body.input.some((item) => item?.type === "reasoning") &&
    !body.input.some((item) => item?.encrypted_content));
  assert.ok(strippedContinuation, "完整历史失败后必须真实验证纯文本历史");
});

test("推理历史续接默认提供 1024 Token 输出预算且不误降级历史格式", async () => {
  const provider = capabilityProvider({
    responsesReasoning: false,
    reasoningToolOutput: true,
    reasoningHistoryContinuation: "budget-once",
    customTools: "native",
    namespaceTools: "native",
    image: "supported",
  });
  const result = await probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch });

  assert.equal(result.protocol, "responses");
  assert.equal(result.historyMode, "responses-full");
  assert.equal(result.capabilities.reasoningHistory, "native");
  const continuations = provider.requests.filter(({ body }) =>
    body.reasoning?.effort === "high" && Array.isArray(body.input) &&
    body.input.some((item) => item?.type === "function_call_output"));
  assert.deepEqual(continuations.map(({ body }) => body.max_output_tokens), [1_024]);
  assert.ok(continuations.every(({ body }) => body.input.some((item) => item?.encrypted_content)),
    "输出预算不足不能触发 reasoning 历史降级");
});
