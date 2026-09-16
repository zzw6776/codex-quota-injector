import assert from "node:assert/strict";
import test from "node:test";
import { MODEL_CAPABILITY_PROBE_VERSION, probeModelCompatibility } from "../src/model-capability-probe.mjs";
import { TARGET, capabilityProvider, imageReasoningReply, probeWithImageReplies } from "./model-capability-probe/support.mjs";

test("完整 Responses 能力必须逐项真实调用后才选择原生协议", async () => {
  const provider = capabilityProvider({
    responsesHistory: "full",
    customTools: "native",
    namespaceTools: "native",
    hostedWebSearch: "native",
    image: "supported",
  });
  const result = await probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch });

  assert.equal(result.protocol, "responses");
  assert.deepEqual(result.routes, { default: "responses", imageInput: "responses" });
  assert.equal(result.historyMode, "responses-full");
  assert.equal(result.codexConformance, "passed");
  assert.deepEqual(result.capabilities, {
    transport: { responses: "native", chat: "inconclusive" },
    streaming: "native",
    functionTools: "native",
    customTools: "native",
    namespaceTools: "native",
    nativeCustomTools: ["*"],
    parallelTools: "native",
    toolChoice: "native",
    reasoning: "native",
    reasoningToolChoice: "native",
    reasoningHistory: "native",
    imageInput: "native",
    hostedTools: { web_search: "native" },
  });
  assert.equal(result.supportsImage, true);
  assert.equal(result.probeVersion, MODEL_CAPABILITY_PROBE_VERSION);
  assert.deepEqual(result.reasoningEfforts, ["low", "medium", "high", "xhigh", "max"]);
  assert.ok(provider.requests.some(({ body }) =>
    body.tools?.some((tool) => tool.type === "custom")));
  assert.ok(provider.requests.some(({ body }) =>
    body.tools?.some((tool) => tool.type === "namespace")));
  assert.ok(provider.requests.some(({ body }) =>
    body.tools?.some((tool) => tool.type === "web_search")));
});

test("Responses 核心可用但仅原生支持 apply_patch 时保留 Responses 并局部转换工具", async () => {
  const provider = capabilityProvider({
    customTools: "apply-patch-only",
    namespaceTools: "ignored",
    hostedWebSearch: "native",
    image: "unsupported",
  });
  const result = await probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch });

  assert.equal(result.protocol, "responses");
  assert.equal(result.historyMode, "responses-full");
  assert.equal(result.capabilities.transport.responses, "native");
  assert.equal(result.capabilities.transport.chat, "native");
  assert.equal(result.capabilities.functionTools, "native");
  assert.equal(result.capabilities.customTools, "bridged");
  assert.equal(result.capabilities.namespaceTools, "bridged");
  assert.deepEqual(result.capabilities.nativeCustomTools, ["apply_patch"]);
  assert.equal(result.capabilities.hostedTools.web_search, "native");
  assert.equal(result.capabilities.imageInput, "unsupported");
  assert.equal(result.codexConformance, "passed");
  assert.deepEqual(result.routes, { default: "responses", imageInput: "responses" });
  assert.ok(provider.requests.some(({ body }) =>
    body.tools?.some((tool) => tool.type === "custom" && tool.name === "apply_patch")));
  assert.ok(provider.requests.some(({ body }) =>
    body.tools?.some((tool) => tool.type === "function" && /^cq_custom_/.test(tool.name))));
});

test("Responses 核心可用但 custom 转换不可靠时自动选择通过完整验收的 Chat", async () => {
  const provider = capabilityProvider({
    customTools: "ignored",
    bridgedCustom: "invalid-arguments",
    image: "unsupported",
    imageByProtocol: null,
    rejectReferenceSiblings: false,
  });
  const result = await probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch });

  assert.equal(result.protocol, "chat");
  assert.equal(result.capabilities.transport.responses, "native");
  assert.equal(result.capabilities.transport.chat, "native");
  assert.equal(result.capabilities.customTools, "bridged");
  assert.equal(result.capabilities.namespaceTools, "bridged");
  assert.equal(result.codexConformance, "passed");
  assert.ok(provider.requests.some(({ path }) => path.endsWith("/responses")));
  assert.ok(provider.requests.some(({ path }) => path.endsWith("/chat/completions")));
});

test("只有预算耗尽或假设性拒绝不能误判不支持，也不扩大预算重试", async () => {
  for (const protocol of ["responses", "chat"]) {
    for (const reasoning of ["Let me inspect the panels.", "If I cannot see the image, I should say so."]) {
      const { result, images } = await probeWithImageReplies(protocol, route =>
        imageReasoningReply(route, { reasoning }));
      assert.equal(result.imageStatus, "inconclusive");
      assert.equal(result.supportsImage, null);
      assert.match(result.imageDetail, /输出预算耗尽/);
      assert.equal(images.length, protocol === "responses" ? 2 : 1);
      assert.equal(result.codexConformance, "passed");
    }
  }
});
