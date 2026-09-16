import assert from "node:assert/strict";
import test from "node:test";
import { probeModelCompatibility } from "../src/model-capability-probe.mjs";
import { TARGET, capabilityProvider, hasReferenceSibling, hasReference } from "./model-capability-probe/support.mjs";

test("组合验收使用 Codex 复杂引用 schema，并在发送前统一规范化", async () => {
  const provider = capabilityProvider({
    customTools: "native",
    namespaceTools: "native",
    image: "supported",
    rejectReferenceSiblings: true,
  });
  const result = await probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch });

  assert.equal(result.codexConformance, "passed");
  const conformance = provider.requests.find(({ body }) =>
    body.tools?.some((tool) =>
      tool.parameters?.properties?.value?.description === "Codex-style referenced tool parameter."));
  assert.ok(conformance, "探针必须编译与真实 Codex 同类的 $defs/$ref 工具 schema");
  assert.equal(hasReferenceSibling(conformance.body), false);
  assert.equal(hasReference(conformance.body), false);
});

test("Responses 不可用时通过 Chat 的工具、流式和组合请求检测", async () => {
  const provider = capabilityProvider({ responses: "missing", image: "unsupported" });
  const result = await probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch });

  assert.equal(result.protocol, "chat");
  assert.equal(result.capabilities.transport.responses, "unsupported");
  assert.equal(result.capabilities.transport.chat, "native");
  assert.equal(result.capabilities.streaming, "native");
  assert.equal(result.capabilities.customTools, "bridged");
  assert.equal(result.capabilities.namespaceTools, "bridged");
  assert.deepEqual(result.capabilities.nativeCustomTools, []);
});

test("Responses 工具结果后返回结构正确的下一次工具调用也算续接成功", async () => {
  const provider = capabilityProvider({
    responsesContinuation: "next-tool",
    customTools: "native",
    namespaceTools: "native",
    image: "supported",
  });
  const result = await probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch });

  assert.equal(result.protocol, "responses");
  assert.equal(result.codexConformance, "passed");
  assert.equal(result.capabilities.functionTools, "native");
});

test("Chat 工具结果后返回结构正确的下一次工具调用也算续接成功", async () => {
  const provider = capabilityProvider({
    responses: "missing",
    chatContinuation: "next-tool",
    image: "unsupported",
  });
  const result = await probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch });

  assert.equal(result.protocol, "chat");
  assert.equal(result.codexConformance, "passed");
  assert.equal(result.capabilities.functionTools, "native");
});

test("Responses 工具握手首次缺少有效后续输出时完整重试一次", async () => {
  const progress = [];
  const provider = capabilityProvider({
    responsesContinuation: "empty-once",
    customTools: "native",
    namespaceTools: "native",
    image: "supported",
  });
  const result = await probeModelCompatibility({
    ...TARGET,
    fetchImpl: provider.fetch,
    onProgress: (event) => progress.push(event),
  });

  assert.equal(result.protocol, "responses");
  assert.equal(result.codexConformance, "passed");
  assert.equal(provider.counts.responsesEmptyContinuations, 1);
  assert.equal(provider.counts.responsesCoreContinuations, 2);
  assert.ok(progress.some((event) => event.stage === "responses-retry" && event.retry));
  assert.deepEqual(progress.at(-1), {
    current: 8,
    total: 8,
    stage: "complete",
    message: "检测完成，正在整理能力结果",
    retry: false,
  });
});

test("Chat 工具握手首次缺少有效后续输出时完整重试一次", async () => {
  const provider = capabilityProvider({
    responses: "missing",
    chatContinuation: "empty-once",
    image: "unsupported",
  });
  const result = await probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch });

  assert.equal(result.protocol, "chat");
  assert.equal(result.codexConformance, "passed");
  assert.equal(provider.counts.chatEmptyContinuations, 1);
  assert.equal(provider.counts.chatCoreContinuations, 2);
});

test("并行工具的临时故障记录为 inconclusive 且不跳过组合验收", async () => {
  const provider = capabilityProvider({
    customTools: "native",
    namespaceTools: "native",
    parallelTools: "temporary-error",
    image: "supported",
  });
  const result = await probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch });

  assert.equal(result.capabilities.parallelTools, "inconclusive");
  assert.equal(result.codexConformance, "passed");
});
