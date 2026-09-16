import { applyResponsesCapabilityPolicy } from "../responses-tool-adapter.mjs";
import { readCodexDelegationInput } from "../codex-delegation.mjs";
import { httpError, nonEmptyString } from "./contract.mjs";

function prepareCustomRequest(body, target) {
  if (containsImageInput(body.input) && !target.supportsImage) {
    throw httpError(400, `${target.displayName} 的当前配置未启用图片输入`);
  }
  const next = structuredClone(body);
  if (target.canonicalModelId) next.model = target.canonicalModelId;
  next.input = normalizeCodexDelegationInput(next.input);
  stripCodexInternalInputMetadata(next.input);
  if (target.historyMode === "reasoning-text-only") {
    stripUnsupportedDeepSeekReasoningFields(next.input);
  }
  next.store = false;
  delete next.service_tier;
  if (next.reasoning && typeof next.reasoning === "object") {
    delete next.reasoning.summary;
    const effort = nonEmptyString(next.reasoning.effort);
    if (target.reasoningEfforts.length === 0) {
      delete next.reasoning.effort;
    } else if (effort && !target.reasoningEfforts.includes(effort)) {
      throw httpError(
        400,
        `${target.displayName} 的推理深度仅支持 ${target.reasoningEfforts.join("、")}`,
      );
    } else if (!effort) {
      next.reasoning.effort = target.defaultReasoningEffort ?? target.reasoningEfforts[0];
    }
    if (Object.keys(next.reasoning).length === 0) delete next.reasoning;
  }
  applyModelCapabilityPolicy(next, target);
  return next;
}

function applyModelCapabilityPolicy(body, target) {
  applyResponsesCapabilityPolicy(body, target, {
    errorFactory: (message) => httpError(400, message),
  });
}

function normalizeCodexDelegationInput(input) {
  if (!Array.isArray(input)) return input;
  return input.map((item) => {
    if (item?.type !== "function_call_output") return item;
    const inputText = readCodexDelegationInput(item);
    if (inputText === null) return item;
    return {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: inputText }],
    };
  });
}

function stripCodexInternalInputMetadata(input) {
  if (!Array.isArray(input)) return;
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    delete item.internal_chat_message_metadata_passthrough;
  }
}

function stripUnsupportedDeepSeekReasoningFields(input) {
  if (!Array.isArray(input)) return;
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item) || item.type !== "reasoning") continue;
    delete item.summary;
    delete item.encrypted_content;
  }
}

function customRequestShape(body) {
  const input = Array.isArray(body?.input) ? body.input : null;
  return {
    model: nonEmptyString(body?.model),
    topLevelKeys: body && typeof body === "object" ? Object.keys(body).sort() : [],
    input: input?.map((item, index) => ({
      index,
      type: item && typeof item === "object" ? nonEmptyString(item.type) : null,
      role: item && typeof item === "object" ? nonEmptyString(item.role) : null,
      keys: item && typeof item === "object" && !Array.isArray(item)
        ? Object.keys(item).sort()
        : [],
      content: Array.isArray(item?.content)
        ? item.content.map((part) => ({
            type: part && typeof part === "object" ? nonEmptyString(part.type) : typeof part,
            keys: part && typeof part === "object" && !Array.isArray(part)
              ? Object.keys(part).sort()
              : [],
          }))
        : typeof item?.content,
    })) ?? typeof body?.input,
  };
}

function requestToolInventory(tools) {
  if (!Array.isArray(tools)) return [];
  const unique = new Map();
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) continue;
    const type = nonEmptyString(tool.type);
    const name = nonEmptyString(tool.name ?? tool.function?.name);
    const namespace = nonEmptyString(tool.namespace);
    const serverLabel = nonEmptyString(tool.server_label);
    if (!type && !name && !namespace && !serverLabel) continue;
    const item = { type, name, namespace, serverLabel };
    const key = JSON.stringify(item);
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()];
}

function prepareCustomWebSocketRequest(body, target) {
  const next = prepareCustomRequest(body, target);
  delete next.type;
  delete next.generate;
  delete next.stream_id;
  delete next.client_metadata;
  next.stream = true;
  return next;
}

function containsImageInput(value) {
  if (Array.isArray(value)) return value.some(containsImageInput);
  if (!value || typeof value !== "object") return false;
  if (["image", "localImage", "input_image", "image_url"].includes(value.type)) return true;
  return Object.values(value).some(containsImageInput);
}

export { prepareCustomRequest, customRequestShape, requestToolInventory, prepareCustomWebSocketRequest };
