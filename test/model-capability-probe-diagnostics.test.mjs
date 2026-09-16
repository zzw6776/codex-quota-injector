import assert from "node:assert/strict";
import test from "node:test";
import { probeModelCompatibility } from "../src/model-capability-probe.mjs";
import { TARGET, capabilityProvider, isImageRequest, jsonResponse } from "./model-capability-probe/support.mjs";

test("检测诊断保留图片判定证据且先脱敏再截断摘要", async () => {
  const events = [];
  const provider = capabilityProvider({ customTools: "native", namespaceTools: "native", image: "supported" });
  const reasoning = "x".repeat(505) + TARGET.apiKey + " " + TARGET.imageChallenge.dataUrl;
  const result = await probeModelCompatibility({ ...TARGET, onDiagnostic: event => events.push(event),
    fetchImpl: (url, init) => {
      if (new URL(url).pathname.endsWith("/responses") && isImageRequest(JSON.parse(init.body))) {
        return jsonResponse({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
          output: [{ type: "reasoning", content: [{ type: "reasoning_text", text: reasoning }] }],
          usage: { input_tokens: 100, output_tokens: 256, output_tokens_details: { reasoning_tokens: 256 } } });
      }
      if (isImageRequest(JSON.parse(init.body))) {
        return jsonResponse({ choices: [{ message: { content:
          `red-blue ${TARGET.apiKey} ${TARGET.imageChallenge.dataUrl}` }, finish_reason: "stop" }] });
      }
      return provider.fetch(url, init);
    } });
  assert.equal(result.supportsImage, true, "诊断不能改变备用 Chat 图片成功的结论");
  const image = events.find(event => event.event === "request-end" && event.stage === "image");
  assert.equal(image.httpStatus, 200);
  assert.equal(image.outputBudget, 256);
  assert.equal(image.answerChars, 0);
  assert.equal(image.reasoningChars, reasoning.length);
  assert.equal(image.reasoningSummary, ("x".repeat(505) + "[凭据已隐藏]").slice(0, 512));
  assert.equal(image.usage.reasoningTokens, 256);
  assert.equal(image.incompleteReason, "max_output_tokens");
  assert.deepEqual(image.outputShape[0].contentTypes, ["reasoning_text"]);
  assert.ok(events.some(event => event.event === "image-result" && event.status === "inconclusive"));
  assert.ok(events.some(event => event.event === "image-result" && event.protocol === "chat" && event.status === "supported"));
  assert.ok(events.some(event => event.answerSummary === "red-blue [凭据已隐藏] [图片内容已隐藏]"));
  assert.ok(!JSON.stringify(events).includes(TARGET.apiKey));
  assert.ok(!JSON.stringify(events).includes(TARGET.imageChallenge.dataUrl));
  for (const start of events.filter(event => event.event === "request-start")) {
    assert.equal(events.filter(event => event.sequence === start.sequence && event.event === "request-end").length, 1);
  }
});

test("图片正文超时日志保留已收到的 HTTP 状态、请求 ID 和重试顺序", async () => {
  const events = [];
  const provider = capabilityProvider({ customTools: "native", namespaceTools: "native", image: "supported" });
  let count = 0;
  const result = await probeModelCompatibility({ ...TARGET, timeoutMs: 5,
    onDiagnostic: event => events.push(event),
    fetchImpl: (url, init) => {
      if (!isImageRequest(JSON.parse(init.body)) || ++count > 2) return provider.fetch(url, init);
      return Promise.resolve({ ok: true, status: 200,
        headers: new Headers({ "content-type": "application/json", "x-request-id": `image-${count}` }),
        text: () => new Promise((resolve, reject) =>
          init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })) });
    } });
  assert.equal(result.supportsImage, true);
  const requests = events.filter(event => event.event === "request-end" && event.stage === "image");
  assert.deepEqual(requests.map(event => event.attempt), [1, 2, 3]);
  assert.deepEqual(requests.map(event => event.failurePhase), ["body", "body", null]);
  assert.equal(requests[0].httpStatus, 200);
  assert.equal(requests[0].providerRequestId, "image-1");
  assert.ok(requests[0].headersMs >= 0);
  assert.ok(requests[0].elapsedMs >= requests[0].headersMs);
  assert.equal(requests[0].bodyParsed, false);
  assert.equal(events.filter(event => event.event === "request-retry" && event.stage === "image").length, 2);
});

test("诊断回调失败不改变模型检测结果", async () => {
  const provider = capabilityProvider({ image: "supported" });
  const result = await probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch,
    onDiagnostic: () => { throw new Error("log unavailable"); } });
  assert.equal(result.status, "verified");
  assert.equal(result.supportsImage, true);
});
