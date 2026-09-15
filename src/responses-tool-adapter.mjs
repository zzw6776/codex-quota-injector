import { createHash } from "node:crypto";

import { collectResponseTools } from "./chat-tool-adapter.mjs";
import {
  normalizeResponsesRequestToolSchemas,
  normalizeToolDefinitions,
} from "./tool-schema-compat.mjs";

const MAX_TOOL_NAME_LENGTH = 64;

export function needsResponsesToolBridge(model) {
  if (!model || model.chatCompatibility) return false;
  const capabilities = model.capabilities;
  return capabilities?.customTools === "bridged" ||
    capabilities?.namespaceTools === "bridged";
}

export function needsResponsesCapabilityPolicy(model) {
  return Boolean(model?.capabilities && typeof model.capabilities === "object" &&
    !Array.isArray(model.capabilities));
}

export function applyResponsesCapabilityPolicy(body, model, {
  errorFactory = (message) => new Error(message),
} = {}) {
  const capabilities = model?.capabilities;
  const unavailableHostedTools = new Set();
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    return unavailableHostedTools;
  }
  for (const [type, state] of Object.entries(capabilities.hostedTools ?? {})) {
    if (state !== "native") unavailableHostedTools.add(type);
  }
  for (const type of declaredProviderToolTypes(body)) {
    if (capabilities.hostedTools?.[type] !== "native") unavailableHostedTools.add(type);
  }
  const selectedUnavailableType = requiredUnavailableToolType(
    body?.tool_choice,
    unavailableHostedTools,
  );
  if (selectedUnavailableType) {
    throw errorFactory(`${model.displayName || model.id || "当前模型"} 不支持服务端工具 ${selectedUnavailableType}`);
  }
  if (unavailableHostedTools.size > 0) {
    if (Array.isArray(body.tools)) {
      body.tools = filterUnavailableTools(body.tools, unavailableHostedTools);
    }
    if (Array.isArray(body.input)) {
      body.input = body.input.flatMap((item) => {
        if (item?.type !== "additional_tools" || !Array.isArray(item.tools)) return [item];
        const tools = filterUnavailableTools(item.tools, unavailableHostedTools);
        return tools.length ? [{ ...item, tools }] : [];
      });
    }
  }
  const reasoningEffort = text(body?.reasoning?.effort) || text(model.defaultReasoningEffort);
  const reasoningEnabled = Boolean(reasoningEffort && reasoningEffort !== "none");
  const toolChoiceCapability = reasoningEnabled
    ? capabilities.reasoningToolChoice
    : capabilities.toolChoice;
  if (toolChoiceCapability !== "native") {
    if (toolChoiceCapability === "auto-only" && isForcedToolChoice(body.tool_choice)) {
      body.tool_choice = "auto";
    } else if (toolChoiceCapability !== "auto-only") {
      delete body.tool_choice;
    }
  } else if (body.tool_choice?.type === "allowed_tools" &&
    Array.isArray(body.tool_choice.tools)) {
    const tools = filterUnavailableTools(body.tool_choice.tools, unavailableHostedTools);
    if (tools.length) body.tool_choice = { ...body.tool_choice, tools };
    else delete body.tool_choice;
  }
  if (capabilities.parallelTools !== "native") delete body.parallel_tool_calls;
  if (Array.isArray(body.tools) && body.tools.length === 0) {
    delete body.tool_choice;
    delete body.parallel_tool_calls;
  }
  return unavailableHostedTools;
}

export function prepareResponsesToolRequest(request, {
  inheritedTools = [],
  nativeCustomTools = [],
  nativeNamespaceTools = false,
  ignoredToolTypes = new Set(),
} = {}) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("Responses 请求体无效");
  }
  const passthroughTools = collectPassthroughTools(request, ignoredToolTypes);
  const declarationIgnoredTypes = new Set([
    ...ignoredToolTypes,
    ...passthroughTools.map((tool) => tool.type),
  ]);
  const declarations = collectResponseTools(request, inheritedTools, {
    ignoredTypes: declarationIgnoredTypes,
  });
  const plan = createResponsesToolPlan(declarations, {
    nativeCustomTools,
    nativeNamespaceTools,
  });
  const body = normalizeResponsesRequestToolSchemas(request);
  if (Array.isArray(body.input)) {
    body.input = transformInput(body.input, plan);
  }
  if (declarations.length || passthroughTools.length || Object.hasOwn(request, "tools")) {
    body.tools = normalizeToolDefinitions([...plan.upstreamTools, ...passthroughTools]);
  }
  if (body.tool_choice && typeof body.tool_choice === "object") {
    const toolChoice = transformToolChoice(body.tool_choice, plan, ignoredToolTypes);
    if (toolChoice) body.tool_choice = toolChoice;
    else delete body.tool_choice;
  }
  return {
    body,
    source: { ...structuredClone(request), tools: declarations.map((tool) => structuredClone(tool)) },
    plan,
  };
}

function collectPassthroughTools(request, ignoredToolTypes) {
  const declared = [...(Array.isArray(request.tools) ? request.tools : [])];
  for (const item of Array.isArray(request.input) ? request.input : []) {
    if (item?.type === "additional_tools" && Array.isArray(item.tools)) {
      declared.push(...item.tools);
    }
  }
  const unique = new Map();
  for (const tool of declared.filter((tool) =>
    tool && typeof tool === "object" && !Array.isArray(tool) &&
    !["function", "custom", "namespace"].includes(tool.type) &&
    !ignoredToolTypes.has(tool.type))) {
    const key = JSON.stringify(tool);
    if (!unique.has(key)) unique.set(key, structuredClone(tool));
  }
  return [...unique.values()];
}

export function translateResponsesPayload(payload, plan) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const next = structuredClone(payload);
  if (Array.isArray(next.output)) {
    next.output = next.output.map((item) => translateResponsesOutputItem(item, plan));
  }
  return next;
}

export function translateResponsesOutputItem(item, plan, { allowIncompleteCustom = false } = {}) {
  if (!item || typeof item !== "object" || Array.isArray(item) || item.type !== "function_call") {
    return structuredClone(item);
  }
  const entry = plan?.byUpstreamName?.get(text(item.name));
  if (!entry?.bridged) return structuredClone(item);
  const next = structuredClone(item);
  next.name = entry.original.name;
  if (entry.original.namespace) next.namespace = entry.original.namespace;
  else delete next.namespace;
  if (entry.original.type !== "custom") return next;
  const argumentText = typeof item.arguments === "string" ? item.arguments : "";
  const input = allowIncompleteCustom && !argumentText
    ? ""
    : customInput(argumentText, entry.original);
  next.type = "custom_tool_call";
  next.input = input;
  delete next.arguments;
  return next;
}

export function createResponsesToolStreamTranslator(plan) {
  const calls = new Map();
  return {
    accept(eventName, payload) {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return [{ event: eventName, data: payload }];
      }
      const type = text(payload.type) || eventName;
      if (type === "response.output_item.added") {
        const item = payload.item;
        const entry = item?.type === "function_call"
          ? plan?.byUpstreamName?.get(text(item.name))
          : null;
        if (entry?.bridged) {
          calls.set(text(item.id), {
            entry,
            arguments: typeof item.arguments === "string" ? item.arguments : "",
            emittedCustomInput: false,
            itemId: text(item.id),
            outputIndex: payload.output_index,
          });
          return [{
            event: eventName,
            data: {
              ...structuredClone(payload),
              item: translateResponsesOutputItem(item, plan, { allowIncompleteCustom: true }),
            },
          }];
        }
      }
      if (type === "response.function_call_arguments.delta") {
        const call = calls.get(text(payload.item_id));
        if (call?.entry.original.type === "custom") {
          call.arguments += text(payload.delta);
          return [];
        }
      }
      if (type === "response.function_call_arguments.done") {
        const call = calls.get(text(payload.item_id));
        if (call?.entry.original.type === "custom") {
          if (typeof payload.arguments === "string") call.arguments = payload.arguments;
          return customInputEvents(call, payload);
        }
      }
      if (type === "response.output_item.done") {
        const item = payload.item;
        const entry = item?.type === "function_call"
          ? plan?.byUpstreamName?.get(text(item.name))
          : null;
        let call = calls.get(text(item?.id));
        if (!call && entry?.bridged) {
          call = {
            entry,
            arguments: typeof item.arguments === "string" ? item.arguments : "",
            emittedCustomInput: false,
            itemId: text(item.id),
            outputIndex: payload.output_index,
          };
          calls.set(text(item.id), call);
        }
        const result = [];
        if (call?.entry.original.type === "custom" && !call.emittedCustomInput) {
          if (typeof item.arguments === "string") call.arguments = item.arguments;
          result.push(...customInputEvents(call, payload));
        }
        if (entry?.bridged) {
          result.push({
            event: eventName,
            data: {
              ...structuredClone(payload),
              item: translateResponsesOutputItem(item, plan),
            },
          });
          return result;
        }
      }
      if (["response.completed", "response.incomplete", "response.failed"].includes(type) &&
        payload.response && typeof payload.response === "object") {
        return [{
          event: eventName,
          data: {
            ...structuredClone(payload),
            response: translateResponsesPayload(payload.response, plan),
          },
        }];
      }
      return [{ event: eventName, data: structuredClone(payload) }];
    },
  };
}

function createResponsesToolPlan(declarations, {
  nativeCustomTools,
  nativeNamespaceTools,
}) {
  const nativeNames = new Set(
    Array.isArray(nativeCustomTools)
      ? nativeCustomTools.map(text).filter(Boolean)
      : [],
  );
  const entries = [];
  const byOriginalKey = new Map();
  const byUpstreamName = new Map();
  const upstreamTools = [];
  for (const declaration of declarations) {
    const original = structuredClone(declaration);
    const key = originalToolKey(original);
    const duplicate = byOriginalKey.get(key);
    if (duplicate) {
      if (JSON.stringify(duplicate.original) !== JSON.stringify(original)) {
        throw new Error(`Responses 工具定义冲突：${qualifiedToolName(original)}`);
      }
      continue;
    }
    const nativeCustom = original.type !== "custom" ||
      nativeNames.has("*") || nativeNames.has(original.name);
    const native = nativeCustom && (!original.namespace || nativeNamespaceTools);
    const upstreamName = native ? original.name : bridgedToolName(original);
    const entry = { original, upstreamName, bridged: !native };
    if (!native) {
      const existing = byUpstreamName.get(upstreamName);
      if (existing && originalToolKey(existing.original) !== key) {
        throw new Error(`Responses 工具名称转换冲突：${qualifiedToolName(original)}`);
      }
      byUpstreamName.set(upstreamName, entry);
    }
    byOriginalKey.set(key, entry);
    entries.push(entry);
  }
  upstreamTools.push(...buildUpstreamTools(entries));
  return { entries, byOriginalKey, byUpstreamName, upstreamTools };
}

function buildUpstreamTools(entries) {
  const output = [];
  const namespaces = new Map();
  for (const entry of entries) {
    if (entry.bridged) {
      output.push(bridgedFunctionTool(entry.original, entry.upstreamName));
      continue;
    }
    if (!entry.original.namespace) {
      output.push(withoutNamespace(entry.original));
      continue;
    }
    let group = namespaces.get(entry.original.namespace);
    if (!group) {
      group = { type: "namespace", name: entry.original.namespace, tools: [] };
      namespaces.set(entry.original.namespace, group);
      output.push(group);
    }
    group.tools.push(withoutNamespace(entry.original));
  }
  return output;
}

function withoutNamespace(tool) {
  const next = structuredClone(tool);
  delete next.namespace;
  return next;
}

function bridgedFunctionTool(tool, name) {
  if (tool.type === "custom") {
    return {
      type: "function",
      name,
      description: `${tool.description ?? ""}\nSupply the complete raw tool input in the input string. Do not JSON-encode that string a second time.`.trim(),
      parameters: {
        type: "object",
        properties: { input: { type: "string" } },
        required: ["input"],
        additionalProperties: false,
      },
    };
  }
  const next = structuredClone(tool);
  next.type = "function";
  next.name = name;
  delete next.namespace;
  return next;
}

function transformInput(input, plan) {
  const callEntries = new Map();
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    if (!["function_call", "custom_tool_call"].includes(item.type)) continue;
    const entry = findOriginalEntry(plan, item);
    const callId = text(item.call_id ?? item.id);
    if (entry?.bridged && callId) callEntries.set(callId, entry);
  }
  const output = [];
  for (const item of input) {
    if (item?.type === "additional_tools") continue;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      output.push(structuredClone(item));
      continue;
    }
    const entry = ["function_call", "custom_tool_call"].includes(item.type)
      ? findOriginalEntry(plan, item)
      : null;
    if (entry?.bridged) {
      output.push(toUpstreamCall(item, entry));
      continue;
    }
    if (item.type === "custom_tool_call_output") {
      const call = callEntries.get(text(item.call_id));
      if (call?.bridged) {
        output.push({ ...structuredClone(item), type: "function_call_output" });
        continue;
      }
    }
    output.push(structuredClone(item));
  }
  return output;
}

function toUpstreamCall(item, entry) {
  const next = structuredClone(item);
  next.type = "function_call";
  next.name = entry.upstreamName;
  delete next.namespace;
  if (entry.original.type === "custom") {
    next.arguments = JSON.stringify({ input: text(item.input) });
    delete next.input;
  }
  return next;
}

function transformToolChoice(choice, plan, ignoredToolTypes) {
  const next = structuredClone(choice);
  if (next.type === "allowed_tools" && Array.isArray(next.tools)) {
    next.tools = next.tools.flatMap((tool) =>
      transformedChoiceTools(tool, plan, ignoredToolTypes));
    return next.tools.length ? next : null;
  }
  const tools = transformedChoiceTools(next, plan, ignoredToolTypes);
  if (tools.length <= 1) return tools[0] ?? null;
  return { type: "allowed_tools", mode: "required", tools };
}

function transformedChoiceTools(choice, plan, ignoredToolTypes) {
  if (ignoredToolTypes.has(text(choice?.type))) return [];
  if (choice?.type === "namespace" && text(choice.name)) {
    const entries = (plan?.entries ?? []).filter((entry) =>
      entry.original.namespace === choice.name ||
      entry.original.namespace?.startsWith(`${choice.name}.`));
    if (!entries.some((entry) => entry.bridged)) return [structuredClone(choice)];
    return entries.map((entry) => entry.bridged
      ? { type: "function", name: entry.upstreamName }
      : originalChoice(entry.original));
  }
  const entry = findOriginalEntry(plan, choice);
  if (!entry?.bridged) return [structuredClone(choice)];
  return [{ type: "function", name: entry.upstreamName }];
}

function declaredProviderToolTypes(body) {
  const types = new Set();
  const visit = (tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return;
    if (tool.type === "namespace") {
      for (const child of tool.tools ?? []) visit(child);
      return;
    }
    const type = text(tool.type);
    if (type && !["function", "custom"].includes(type)) types.add(type);
  };
  for (const tool of Array.isArray(body?.tools) ? body.tools : []) visit(tool);
  for (const item of Array.isArray(body?.input) ? body.input : []) {
    if (item?.type === "additional_tools") {
      for (const tool of Array.isArray(item.tools) ? item.tools : []) visit(tool);
    }
  }
  return types;
}

function isForcedToolChoice(value) {
  if (value === "required") return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const type = text(value.type);
  if (["function", "custom", "namespace"].includes(type)) return true;
  return type === "allowed_tools" && value.mode === "required";
}

function filterUnavailableTools(tools, unavailableTypes) {
  return tools.flatMap((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return [tool];
    if (unavailableTypes.has(text(tool.type))) return [];
    if (tool.type !== "namespace" || !Array.isArray(tool.tools)) return [tool];
    const children = filterUnavailableTools(tool.tools, unavailableTypes);
    return children.length ? [{ ...tool, tools: children }] : [];
  });
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

function originalChoice(tool) {
  const choice = { type: tool.type, name: tool.name };
  if (tool.namespace) choice.namespace = tool.namespace;
  return choice;
}

function findOriginalEntry(plan, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const type = declarationType(text(value.type));
  const name = text(value.name);
  const namespace = text(value.namespace);
  if (!type || !name) return null;
  const exact = plan?.byOriginalKey?.get(originalToolKey({ type, name, namespace })) ??
    [...(plan?.entries ?? [])].find((entry) =>
      entry.original.name === name &&
      text(entry.original.namespace) === namespace &&
      entry.original.type === type);
  if (exact) return exact;
  const short = [...(plan?.entries ?? [])].filter((entry) =>
    entry.original.name === name && entry.original.type === type);
  return short.length === 1 ? short[0] : null;
}

function declarationType(type) {
  if (type === "function_call") return "function";
  if (type === "custom_tool_call") return "custom";
  return type;
}

function customInputEvents(call, source) {
  const input = customInput(call.arguments, call.entry.original);
  call.emittedCustomInput = true;
  const itemId = text(source.item_id) || call.itemId;
  const outputIndex = source.output_index ?? call.outputIndex;
  return [{
    event: "response.custom_tool_call_input.delta",
    data: {
      type: "response.custom_tool_call_input.delta",
      item_id: itemId,
      output_index: outputIndex,
      delta: input,
    },
  }, {
    event: "response.custom_tool_call_input.done",
    data: {
      type: "response.custom_tool_call_input.done",
      item_id: itemId,
      output_index: outputIndex,
      input,
    },
  }];
}

function customInput(argumentText, tool) {
  let parsed;
  try {
    parsed = JSON.parse(argumentText);
  } catch {
    throw new Error(`自定义工具 ${qualifiedToolName(tool)} 的参数不是有效 JSON`);
  }
  if (typeof parsed?.input !== "string") {
    throw new Error(`自定义工具 ${qualifiedToolName(tool)} 缺少 input 字符串`);
  }
  return parsed.input;
}

function bridgedToolName(tool) {
  const identity = originalToolKey(tool);
  const kind = tool.type === "custom" ? "custom" : "namespace";
  const readable = qualifiedToolName(tool).replace(/[^a-zA-Z0-9_-]/g, "_");
  const suffix = createHash("sha256").update(identity).digest("hex").slice(0, 12);
  const prefix = `cq_${kind}_`;
  return `${prefix}${readable.slice(0, MAX_TOOL_NAME_LENGTH - prefix.length - suffix.length - 1)}_${suffix}`;
}

function originalToolKey(tool) {
  return JSON.stringify([text(tool?.type), text(tool?.namespace), text(tool?.name)]);
}

function qualifiedToolName(tool) {
  const namespace = text(tool?.namespace);
  return namespace ? `${namespace}.${text(tool?.name)}` : text(tool?.name);
}

function text(value) {
  return typeof value === "string" ? value : "";
}
