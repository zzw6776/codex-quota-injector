import { hasProviderError, upstreamMessage } from "./failures.mjs";
import { imageReasoningText, responsesOutputText, chatOutputText } from "./payloads.mjs";

async function postJson({ url, apiKey, body, fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("模型能力检测超时")), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    const providerRejected = hasProviderError(payload);
    return {
      ok: response.ok && !providerRejected,
      status: response.status,
      payload,
      message: response.ok && !providerRejected
        ? null
        : upstreamMessage(payload, text, response.status, apiKey),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      payload: null,
      message: error?.name === "AbortError" ? "模型能力检测超时" : `网络请求失败：${error.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function postStream({ url, apiKey, body, fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("模型能力检测超时")), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await response.text();
    let payload = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      payload = null;
    }
    const providerRejected = hasProviderError(payload);
    return {
      ok: response.ok && !providerRejected,
      status: response.status,
      raw,
      payload,
      contentType: response.headers.get("content-type"),
      message: response.ok && !providerRejected
        ? null
        : upstreamMessage(payload, raw, response.status, apiKey),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      raw: "",
      contentType: null,
      message: error?.name === "AbortError" ? "模型能力检测超时" : `网络请求失败：${error.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function summarizeProbeResponse(response, protocol) {
  let payload = response.payload;
  const events = [];
  let deltaText = "";
  if (!payload && typeof response.raw === "string") {
    for (const line of response.raw.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      try {
        const event = JSON.parse(line.slice(5).trim());
        if (typeof event.type === "string" && events.length < 12 && !events.includes(event.type)) events.push(event.type);
        const delta = event.type === "response.output_text.delta" ? event.delta : event.choices?.[0]?.delta?.content;
        if (typeof delta === "string") deltaText += delta;
        if (event.response) payload = event.response;
        else if (event.choices || event.usage) payload = { ...payload, ...event,
          choices: event.choices?.length ? event.choices : payload?.choices };
      } catch { /* [DONE] and malformed frames are not JSON payloads. */ }
    }
  }
  const output = Array.isArray(payload?.output) ? payload.output : [];
  const choice = payload?.choices?.[0];
  const text = parts => typeof parts === "string" ? parts : Array.isArray(parts)
    ? parts.map(part => typeof part?.text === "string" ? part.text : "").join("\n") : "";
  const answer = protocol === "chat" ? text(choice?.message?.content) || deltaText
    : typeof payload?.output_text === "string" ? payload.output_text
      : output.filter(item => item?.type === "message").map(item => text(item.content)).join("\n") || deltaText;
  const reasoning = imageReasoningText(payload, protocol);
  const usage = payload?.usage;
  const number = value => typeof value === "number" && Number.isFinite(value) ? value : null;
  return {
    responseStatus: payload?.status ?? null,
    finishReason: choice?.finish_reason ?? null,
    incompleteReason: payload?.incomplete_details?.reason ?? null,
    usage: {
      inputTokens: number(usage?.input_tokens ?? usage?.prompt_tokens),
      outputTokens: number(usage?.output_tokens ?? usage?.completion_tokens),
      reasoningTokens: number(usage?.output_tokens_details?.reasoning_tokens ?? usage?.completion_tokens_details?.reasoning_tokens),
      totalTokens: number(usage?.total_tokens),
    },
    answerChars: answer.length, answerSummary: answer,
    reasoningChars: reasoning.length, reasoningSummary: reasoning,
    recognizedAnswerChars: (protocol === "chat" ? chatOutputText(payload) : responsesOutputText(payload)).length,
    outputShape: output.slice(0, 16).map(item => ({ type: item?.type ?? null, role: item?.role ?? null,
      status: item?.status ?? null, contentTypes: Array.isArray(item?.content) ? item.content.slice(0, 16).map(part => part?.type ?? null) : typeof item?.content })),
    chatMessageKeys: choice?.message ? Object.keys(choice.message) : [],
    streamEvents: events,
    bodyParsed: payload != null,
  };
}

export { postJson, postStream, summarizeProbeResponse };
