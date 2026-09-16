function unavailableProbe(failure, toolChoice = "inconclusive") {
  return { state: capabilityFromFailure(failure), toolChoice };
}

function isOutputTokenLimitIncomplete(response, path) {
  if (!response?.ok) return false;
  if (path === "responses") {
    return response.payload?.status === "incomplete" &&
      response.payload?.incomplete_details?.reason === "max_output_tokens";
  }
  return response.payload?.choices?.some((choice) => choice?.finish_reason === "length") ?? false;
}

function continuationFailure(response, path, message) {
  const detail = isOutputTokenLimitIncomplete(response, path)
    ? `${message}（扩大输出预算后仍达到 Token 上限）`
    : message;
  return contractFailure(response?.status, detail);
}

function normalizeTarget({ baseUrl, apiKey, modelId }) {
  const key = String(apiKey ?? "").trim();
  const model = String(modelId ?? "").trim();
  if (!key) throw new Error("自动检测需要 API Key");
  if (!model) throw new Error("自动检测需要模型 ID");
  let url;
  try {
    url = new URL(String(baseUrl ?? ""));
  } catch {
    throw new Error("自动检测的 API Base URL 无效");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  url.search = "";
  url.hash = "";
  return { baseUrl: url, apiKey: key, modelId: model };
}

function canTryAlternateProtocol(failure) {
  return capabilityFromFailure(failure) === "unsupported";
}

function canTryAlternateAfterProbeError(error) {
  const failures = Array.isArray(error?.probeFailures) ? error.probeFailures : [];
  return failures.length === 0 || failures.every(canTryAlternateProtocol);
}

function capabilityFromFailure(failure) {
  if (!failure) return "inconclusive";
  if ([400, 404, 405, 415, 422, 501, 505].includes(failure.status)) return "unsupported";
  return "inconclusive";
}

function hasProviderError(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  if (typeof payload.error === "string") return payload.error.trim().length > 0;
  return Boolean(payload.error && typeof payload.error === "object");
}

function isExplicitImageRejection(response) {
  return response?.ok === false
    && capabilityFromFailure(response) === "unsupported"
    && /image|vision|multimodal|input_image|image_url|modality/i.test(String(response.message ?? ""));
}

function isReasoningEnvelopeRejection(response) {
  return response?.ok === false
    && /summary|encrypted_content|encrypted content|reasoning/i.test(String(response?.message ?? ""));
}

function isToolChoiceRejection(response) {
  return response?.ok === false
    && /tool[_ ]choice|thinking mode[^.]*tool/i.test(String(response?.message ?? ""));
}

function contractFailure(status, message) {
  return {
    ok: false,
    kind: "contract",
    status: 422,
    upstreamStatus: Number(status) || null,
    payload: null,
    message,
  };
}

function probeError(message, ...failures) {
  const relevantFailures = failures.filter(Boolean);
  const details = relevantFailures.map((failure) => failure?.message).filter(Boolean);
  const error = new Error(`${message}${details.length ? `：${details.join("；")}` : ""}`);
  error.probeFailures = relevantFailures;
  return error;
}

function upstreamMessage(payload, raw, status, apiKey) {
  const message = payload?.error?.message ?? payload?.message ?? raw ?? `HTTP ${status}`;
  const secret = String(apiKey ?? "");
  const sanitized = secret
    ? String(message).replaceAll(secret, "[凭据已隐藏]")
    : String(message);
  return sanitized.replace(/\s+/g, " ").trim().slice(0, 500) || `HTTP ${status}`;
}

export { unavailableProbe, normalizeTarget, canTryAlternateProtocol, canTryAlternateAfterProbeError, capabilityFromFailure, contractFailure, probeError, continuationFailure, isReasoningEnvelopeRejection, isToolChoiceRejection, isExplicitImageRejection, hasProviderError, upstreamMessage };
