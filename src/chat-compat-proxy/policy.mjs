import { text } from "./contract.mjs";

function needsModelCompatibility(model) {
  // Every third-party model crosses this boundary so Codex tool schemas use a
  // provider-portable shape even when no other protocol bridge is needed.
  return Boolean(model);
}

function shouldUseChatCompatibility(model, body) {
  if (model?.chatCompatibility) return true;
  return model?.routes?.imageInput === "chat" && containsImageInput(body?.input);
}

function containsImageInput(value) {
  if (Array.isArray(value)) return value.some(containsImageInput);
  if (!value || typeof value !== "object") return false;
  if (["image", "localImage", "input_image", "image_url"].includes(value.type)) return true;
  return Object.values(value).some(containsImageInput);
}

function unsupportedChatToolTypes(model, body) {
  const capabilities = model?.capabilities;
  const unavailable = new Set(Object.keys(capabilities?.hostedTools ?? {}));
  if (!capabilities) return unavailable;
  const visit = (tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return;
    if (tool.type === "namespace") {
      for (const child of tool.tools ?? []) visit(child);
      return;
    }
    const type = text(tool.type);
    if (type && !["function", "custom"].includes(type)) {
      unavailable.add(type);
    }
  };
  for (const tool of Array.isArray(body?.tools) ? body.tools : []) visit(tool);
  for (const item of Array.isArray(body?.input) ? body.input : []) {
    if (item?.type === "additional_tools") {
      for (const tool of Array.isArray(item.tools) ? item.tools : []) visit(tool);
    }
  }
  return unavailable;
}

function stripReasoningEnvelope(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.input)) return body;
  const next = structuredClone(body);
  for (const item of next.input) {
    if (!item || typeof item !== "object" || Array.isArray(item) || item.type !== "reasoning") continue;
    delete item.summary;
    delete item.encrypted_content;
  }
  return next;
}

function isForcedToolChoice(value) {
  if (value === "required") return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (["function", "custom", "namespace"].includes(text(value.type))) return true;
  return value.type === "allowed_tools" && value.mode === "required";
}

function requiredUnavailableToolType(toolChoice, unavailableTypes) {
  if (!toolChoice || typeof toolChoice !== "object" || unavailableTypes.size === 0) return null;
  const type = text(toolChoice.type);
  if (type && unavailableTypes.has(type)) return type;
  if (type !== "allowed_tools" || toolChoice.mode !== "required" ||
    !Array.isArray(toolChoice.tools)) return null;
  const unavailable = toolChoice.tools
    .map((tool) => text(tool?.type))
    .filter((toolType) => toolType && unavailableTypes.has(toolType));
  const hasAvailable = toolChoice.tools.some((tool) => {
    const toolType = text(tool?.type);
    return !toolType || !unavailableTypes.has(toolType);
  });
  return unavailable.length > 0 && !hasAvailable ? unavailable[0] : null;
}

export { needsModelCompatibility, shouldUseChatCompatibility, stripReasoningEnvelope, unsupportedChatToolTypes, isForcedToolChoice, requiredUnavailableToolType };
