import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
import { IMAGE_OUTPUT_TOKENS } from "./contract.mjs";
import { isExplicitImageRejection } from "./failures.mjs";
import { imageReasoningText, responsesOutputText, chatOutputText } from "./payloads.mjs";

async function probeImage(request, modelId, protocol, challengeFactory, onResult) {
  const attempts = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const challenge = challengeFactory();
    const result = await probeImageOnce(request, modelId, protocol, challenge);
    onResult?.({ event: "image-result", protocol, imageAttempt: attempt + 1,
      expectedAnswer: challenge.expected, status: result.status, detail: result.detail });
    if (result.status === "inconclusive") {
      return { supportsImage: null, status: "inconclusive", detail: result.detail };
    }
    if (result.status === "supported" || result.status === "rejected") {
      return {
        supportsImage: result.status === "supported",
        status: result.status === "supported" ? "supported" : "unsupported",
        detail: result.detail,
      };
    }
    attempts.push(result);
  }
  if (attempts.every((result) => result.status === "denied")) {
    return {
      supportsImage: false,
      status: "unsupported",
      detail: "模型连续两次明确回复无法识别图片",
    };
  }
  return {
    supportsImage: false,
    status: "unsupported",
    detail: "连续两次图片请求成功，但模型均未正确识别图片内容",
  };
}

async function probeImageOnce(request, modelId, protocol, challenge) {
  const response = protocol === "chat"
    ? await request("chat/completions", {
        model: modelId,
        messages: [{ role: "user", content: [
          { type: "text", text: challenge.prompt },
          { type: "image_url", image_url: { url: challenge.dataUrl } },
        ] }],
        max_tokens: IMAGE_OUTPUT_TOKENS,
        stream: false,
      })
    : await request("responses", {
        model: modelId,
        input: [{ role: "user", content: [
          { type: "input_text", text: challenge.prompt },
          { type: "input_image", image_url: challenge.dataUrl, detail: "high" },
        ] }],
        max_output_tokens: IMAGE_OUTPUT_TOKENS,
        store: false,
      });
  if (!response.ok) {
    if (isExplicitImageRejection(response)) {
      return { status: "rejected", detail: response.message };
    }
    if (response.retryExhausted) {
      return { status: "inconclusive", detail: `图片暂不可用：连续 3 次请求失败（${response.message}），未确认模型不支持图片` };
    }
    throw new Error(`图片能力检测失败：${response.message}`);
  }
  const payload = response.payload;
  const answer = (protocol === "chat" ? chatOutputText(payload) : responsesOutputText(payload)).trim();
  const budgetExhausted = protocol === "chat"
    ? payload?.choices?.[0]?.finish_reason === "length"
    : payload?.incomplete_details?.reason === "max_output_tokens";
  const incomplete = budgetExhausted ||
    (protocol === "responses" && ["incomplete", "failed", "cancelled", "in_progress"].includes(payload?.status));
  if (!incomplete && matchesImageChallenge(answer, challenge.expected)) {
    return { status: "supported", detail: null };
  }
  // Reasoning is never a successful answer. Only use an explicit inability
  // statement when there is no final answer; probeImage requires two denials.
  const denialText = answer || imageReasoningText(payload, protocol);
  if (explicitImageDenial(denialText)) {
    return { status: "denied", detail: "模型明确表示无法识别图片" };
  }
  if (incomplete || !answer) {
    return {
      status: "inconclusive",
      detail: budgetExhausted
        ? "图片检测未完成：输出预算耗尽（256 Token）"
        : "图片检测未完成：未返回完整的最终答案",
    };
  }
  return { status: "mismatch", detail: "图片请求已成功，但回答内容未通过校验" };
}

function explicitImageDenial(text) {
  return String(text).split(/[.!?。！？\n]+/).some(sentence => {
    // Hypotheses about a possible failure are not evidence of this failure.
    if (/\b(?:if|whether|maybe|perhaps|might)\b|如果|假如|是否|可能/i.test(sentence)) return false;
    return /\b(?:cannot|can't|unable to)\s+(?:see|view|read|access|process|recognize)\s+(?:(?:the|this|provided|attached|input)\s+)?(?:image|picture)\b|\b(?:image|picture)(?:\s+is)?\s+unsupported\b|\[unsupported image\]|(?:无法|不能|不支持)(?:读取|查看|识别|处理|访问|看见|看到)?(?:这张|该|输入的|提供的|所附的)?(?:图片|图像)/i.test(sentence);
  });
}

function matchesImageChallenge(answer, expected) {
  const expectedColors = String(expected ?? "").toLowerCase().split("-").filter(Boolean);
  const allowedColors = new Set(["red", "green", "blue", "yellow", "magenta", "cyan"]);
  if (expectedColors.length < 2 ||
    expectedColors.some((color) => !allowedColors.has(color))) return false;
  const answerColors = (String(answer ?? "").toLowerCase().match(/[a-z]+/g) ?? [])
    .filter((word) => allowedColors.has(word));
  if (answerColors.length < expectedColors.length) return false;
  return answerColors.some((_, index) => expectedColors.every(
    (color, offset) => answerColors[index + offset] === color,
  ));
}

function createImageChallenge() {
  const colors = [
    { name: "red", rgb: [255, 0, 0] },
    { name: "green", rgb: [0, 180, 0] },
    { name: "blue", rgb: [0, 0, 255] },
    { name: "yellow", rgb: [255, 255, 0] },
  ];
  const ordered = [...colors];
  const seed = randomBytes(ordered.length - 1);
  for (let index = ordered.length - 1; index > 0; index -= 1) {
    const swapIndex = seed[index - 1] % (index + 1);
    [ordered[index], ordered[swapIndex]] = [ordered[swapIndex], ordered[index]];
  }
  return {
    dataUrl: `data:image/png;base64,${colorStripPng(ordered.map((item) => item.rgb), 320, 128).toString("base64")}`,
    prompt: "The image contains four vertical color panels. Read them from left to right and reply only with four lowercase basic English color names joined by hyphens.",
    expected: ordered.map((item) => item.name).join("-"),
  };
}

function colorStripPng(colors, width = 64, height = 32) {
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const color = colors[Math.min(
        colors.length - 1,
        Math.floor(x * colors.length / width),
      )];
      const offset = row + 1 + x * 3;
      raw[offset] = color[0];
      raw[offset + 1] = color[1];
      raw[offset + 2] = color[2];
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])) >>> 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export { probeImage, createImageChallenge };
