import assert from "node:assert/strict";
import test from "node:test";
import { probeModelCompatibility } from "../src/model-capability-probe.mjs";
import { TARGET, capabilityProvider, isImageRequest, jsonResponse, imageReasoningReply, probeWithImageReplies } from "./model-capability-probe/support.mjs";

test("Responses 文本工具可用而图片不可用时自动验证并选择 Chat 图片路由", async () => {
  const provider = capabilityProvider({
    customTools: "native",
    namespaceTools: "native",
    imageByProtocol: { responses: "unsupported", chat: "supported" },
  });
  const result = await probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch });

  assert.equal(result.protocol, "responses");
  assert.deepEqual(result.routes, { default: "responses", imageInput: "chat" });
  assert.equal(result.supportsImage, true);
  assert.equal(result.capabilities.imageInput, "bridged");
  assert.equal(result.capabilities.transport.chat, "native");
  assert.ok(provider.requests.some(({ path, body }) =>
    path.endsWith("/chat/completions") && isImageRequest(body)));
});

test("图片检测的临时上游故障不会被保存成不支持", async () => {
  const provider = capabilityProvider({
    customTools: "native",
    namespaceTools: "native",
    parallelTools: "native",
    image: "temporary-error",
  });
  const result = await probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch });
  assert.equal(result.status, "verified");
  assert.equal(result.imageStatus, "inconclusive");
  assert.equal(result.supportsImage, null);
  assert.match(result.imageDetail, /连续 3 次/);
  assert.equal(result.capabilities.imageInput, "inconclusive");
});

test("错误信息提到图片时，认证、限流和服务故障仍不能保存成不支持图片", async () => {
  for (const protocol of ["responses", "chat"]) {
    for (const status of [401, 403, 429, 500, 503]) {
      const provider = capabilityProvider({
        responses: protocol === "chat" ? "missing" : "native",
        customTools: "native",
        namespaceTools: "native",
        parallelTools: "native",
        image: "supported",
      });
      const fetchImpl = (url, init) => isImageRequest(JSON.parse(init.body))
        ? jsonResponse({ error: { message: "image service unavailable" } }, status)
        : provider.fetch(url, init);
      if (status === 401 || status === 403) {
        await assert.rejects(probeModelCompatibility({ ...TARGET, fetchImpl }), /图片能力检测失败/);
      } else {
        const result = await probeModelCompatibility({ ...TARGET, fetchImpl });
        assert.equal(result.imageStatus, "inconclusive");
        assert.equal(result.supportsImage, null);
      }
    }
  }
});

test("图片首次答案未命中时必须再次校验，不能因 HTTP 200 直接通过", async () => {
  let imageAttempt = 0;
  const provider = capabilityProvider({
    customTools: "native",
    namespaceTools: "native",
    image: () => {
      imageAttempt += 1;
      return imageAttempt === 1 ? "ambiguous" : "supported";
    },
  });
  const result = await probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch });

  assert.equal(result.supportsImage, true);
  assert.equal(result.imageStatus, "supported");
  assert.equal(result.capabilities.imageInput, "native");
  assert.equal(imageAttempt, 2);
});

test("生产探针的四颜色图片必须按实际内容校验通过", async () => {
  const provider = capabilityProvider({
    customTools: "native",
    namespaceTools: "native",
    image: "four-colors",
  });
  const result = await probeModelCompatibility({
    ...TARGET,
    imageChallenge: {
      ...TARGET.imageChallenge,
      expected: "red-yellow-blue-green",
    },
    fetchImpl: provider.fetch,
  });

  assert.equal(result.supportsImage, true);
  assert.equal(result.imageStatus, "supported");
  assert.equal(result.capabilities.imageInput, "native");
});

test("图片连续返回 HTTP 200 但内容校验失败时判定不支持而不影响其他能力", async () => {
  let imageAttempt = 0;
  const provider = capabilityProvider({
    customTools: "native",
    namespaceTools: "native",
    image: () => {
      imageAttempt += 1;
      return "ambiguous";
    },
  });

  const result = await probeModelCompatibility({ ...TARGET, fetchImpl: provider.fetch });

  assert.equal(result.supportsImage, false);
  assert.equal(result.imageStatus, "unsupported");
  assert.equal(result.capabilities.imageInput, "unsupported");
  assert.match(result.imageDetail, /连续两次图片请求成功/);
  assert.equal(result.codexConformance, "passed");
  assert.equal(imageAttempt, 4, "Responses 与 Chat 图片链路必须各自完成两次内容校验");
});

test("图片预算统一为 256，两次明确无法读图的推理即使耗尽预算仍判当前链路不支持", async () => {
  for (const protocol of ["responses", "chat"]) {
    const { result, images } = await probeWithImageReplies(protocol, route =>
      imageReasoningReply(route, { reasoning: "We cannot see the image. The input is [Unsupported Image]." }));
    assert.equal(result.imageStatus, "unsupported");
    assert.equal(result.supportsImage, false);
    assert.match(result.imageDetail, /连续两次明确/);
    assert.equal(result.codexConformance, "passed");
    assert.equal(images.length, protocol === "responses" ? 4 : 2);
  }
});

test("推理中匹配颜色不能当最终答案，单次拒绝后正确回答仍支持图片", async () => {
  for (const protocol of ["responses", "chat"]) {
    const onlyReasoning = await probeWithImageReplies(protocol, route =>
      imageReasoningReply(route, { reasoning: "red-blue", exhausted: false }));
    assert.equal(onlyReasoning.result.imageStatus, "inconclusive");
    assert.match(onlyReasoning.result.imageDetail, /最终答案/);
    const recovered = await probeWithImageReplies(protocol, (route, images) =>
      imageReasoningReply(route, images.length === 1
        ? { reasoning: "I cannot view the image." }
        : { answer: "red-blue", reasoning: "I cannot view the image.", exhausted: false }));
    assert.equal(recovered.result.imageStatus, "supported");
    assert.equal(recovered.images.length, 2);
  }
});

test("Responses 不支持但 Chat 图片预算耗尽时保留未确认结果", async () => {
  const { result, images } = await probeWithImageReplies("responses", route => route === "responses"
    ? jsonResponse({ error: { message: "image modality is unsupported" } }, 400)
    : imageReasoningReply(route, { reasoning: "Let me inspect the panels." }));
  assert.equal(result.imageStatus, "inconclusive");
  assert.equal(result.supportsImage, null);
  assert.match(result.imageDetail, /Chat：图片检测未完成：输出预算耗尽/);
  assert.equal(result.capabilities.imageInput, "inconclusive");
  assert.equal(images.length, 2);
});

test("Responses 图片只有推理或预算耗尽时仍验证 Chat 并选择可用图片路由", async () => {
  for (const exhausted of [false, true]) {
    const { result, images } = await probeWithImageReplies("responses", route => route === "responses"
      ? imageReasoningReply(route, { reasoning: "The image is omitted in this transcript.", exhausted })
      : imageReasoningReply(route, { answer: "red-blue", exhausted: false }));
    assert.equal(result.protocol, "responses");
    assert.deepEqual(result.routes, { default: "responses", imageInput: "chat" });
    assert.equal(result.supportsImage, true);
    assert.equal(result.imageStatus, "supported");
    assert.equal(result.capabilities.imageInput, "bridged");
    assert.equal(result.capabilities.transport.chat, "native");
    assert.equal(result.codexConformance, "passed");
    assert.deepEqual(images.map(item => item.route), ["responses", "chat"]);
  }
});

test("Responses 图片未完成且 Chat 拒绝图片时不能把整体判为不支持", async () => {
  const { result } = await probeWithImageReplies("responses", route => route === "responses"
    ? imageReasoningReply(route, { reasoning: "Let me inspect the image." })
    : jsonResponse({ error: { message: "image modality is unsupported" } }, 400));
  assert.equal(result.imageStatus, "inconclusive");
  assert.equal(result.supportsImage, null);
  assert.equal(result.routes.imageInput, "responses");
  assert.match(result.imageDetail, /Responses：.*输出预算耗尽.*Chat：.*unsupported/);
});

test("Responses 图片未完成时仍须通过 Chat 组合工具验收才能探测和启用图片", async () => {
  const provider = capabilityProvider();
  let imageCalls = 0;
  let conformanceCalls = 0;
  const result = await probeModelCompatibility({ ...TARGET, fetchImpl: (url, init) => {
    const body = JSON.parse(init.body);
    const chat = new URL(url).pathname.endsWith("/chat/completions");
    if (isImageRequest(body)) {
      imageCalls += 1;
      assert.equal(chat, false, "Chat 组合验收未通过时不能继续图片检测");
      return imageReasoningReply("responses", { reasoning: "Let me inspect the image." });
    }
    if (chat && body.tools?.length === 3) {
      conformanceCalls += 1;
      return jsonResponse({ error: { message: "unsupported combined tools" } }, 400);
    }
    return provider.fetch(url, init);
  } });
  assert.equal(conformanceCalls, 1);
  assert.equal(imageCalls, 1);
  assert.equal(result.supportsImage, null);
  assert.equal(result.imageStatus, "inconclusive");
  assert.equal(result.routes.imageInput, "responses");
  assert.equal(result.protocol, "responses");
});

test("图片请求超时会有限重试，恢复后按内容判断，耗尽后完成其余检测", async () => {
  for (const recover of [true, false]) {
    const provider = capabilityProvider({ customTools: "native", namespaceTools: "native", image: "supported" });
    let imageRequests = 0;
    const progress = [];
    const result = await probeModelCompatibility({ ...TARGET, timeoutMs: 5,
      onProgress: event => progress.push(event),
      fetchImpl: (url, init) => {
        if (!isImageRequest(JSON.parse(init.body))) return provider.fetch(url, init);
        imageRequests += 1;
        if (recover && imageRequests === 3) return provider.fetch(url, init);
        return new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
      },
    });
    assert.equal(imageRequests, recover ? 3 : 6);
    assert.equal(progress.filter(event => event.retry && event.stage === "image").length, 2);
    assert.equal(progress.at(-1).stage, "complete");
    assert.equal(result.codexConformance, "passed");
    assert.equal(result.imageStatus, recover ? "supported" : "inconclusive");
    assert.equal(result.supportsImage, recover ? true : null);
    if (!recover) assert.match(result.warnings.join(" "), /连续 3 次.*超时/);
  }
});
