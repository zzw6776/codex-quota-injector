import { createHash } from "node:crypto";

// Responses Lite places declarations in additional_tools items. Normalize that
// representation and ordinary Responses declarations at one protocol boundary.
export function collectResponseTools(source, inherited = []) {
  const declarations = [...(Array.isArray(source.tools) ? source.tools : [])];
  for (const item of Array.isArray(source.input) ? source.input : []) {
    if (item?.type === "additional_tools" && Array.isArray(item.tools)) declarations.push(...item.tools);
  }
  if (!declarations.length && !Object.hasOwn(source, "tools")) return inherited;
  const tools = [];
  const visit = (tool, namespace = null) => {
    if (tool?.type === "namespace") {
      for (const child of tool.tools ?? []) visit(child, namespace ? `${namespace}.${tool.name}` : tool.name);
    } else if (["function", "custom"].includes(tool?.type) && typeof tool.name === "string") {
      tools.push({ ...tool, namespace: tool.namespace ?? namespace });
    } else if (tool) {
      throw new Error(`Chat 兼容模式不支持工具类型 ${tool.type ?? "unknown"}`);
    }
  };
  for (const tool of declarations) visit(tool);
  return tools;
}

function qualified(tool) { return tool.namespace ? `${tool.namespace}.${tool.name}` : tool.name; }

export function chatToolName(tool) {
  const name = qualified(tool);
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(name)) return name;
  return `${name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0,45)}_${createHash("sha256").update(name).digest("hex").slice(0,12)}`;
}

export function toChatTools(tools) {
  const unique = new Map();
  for (const tool of tools) {
    const name = chatToolName(tool);
    const fn = { name, description: tool.description ?? "" };
    if (tool.type === "custom") {
      fn.description += "\nSupply the complete raw tool input in the input string. Do not JSON-encode that string a second time.";
      fn.parameters = { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false };
    } else {
      if (tool.parameters && typeof tool.parameters === "object") fn.parameters = tool.parameters;
      if (tool.strict != null) fn.strict = Boolean(tool.strict);
    }
    const converted = { type: "function", function: fn };
    if (unique.has(name) && JSON.stringify(unique.get(name)) !== JSON.stringify(converted)) {
      throw new Error(`工具定义冲突：${qualified(tool)}`);
    }
    unique.set(name, converted);
  }
  return [...unique.values()];
}

export function findResponseTool(tools, name, namespace = null) {
  const exact = tools.find(tool => chatToolName(tool) === name || qualified(tool) === (namespace ? `${namespace}.${name}` : name));
  if (exact) return exact;
  const short = tools.filter(tool => tool.name === name);
  return short.length === 1 ? short[0] : null;
}

export function toChatCall(item, tools) {
  if (!item.call_id || !item.name) return null;
  const tool = findResponseTool(tools, item.name, item.namespace);
  return { id: item.call_id, type: "function", function: {
    name: tool ? chatToolName(tool) : item.name,
    arguments: item.type === "custom_tool_call" ? JSON.stringify({ input: item.input ?? "" })
      : typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
  } };
}

export function responseCall(tool, { id, callId, name, arguments: argumentText, status }) {
  const item = { id, type: tool?.type === "custom" ? "custom_tool_call" : "function_call", status,
    call_id: callId, name: tool?.name ?? name };
  if (tool?.namespace) item.namespace = tool.namespace;
  if (item.type === "custom_tool_call") {
    if (status === "in_progress") item.input = "";
    else {
      let parsed;
      try { parsed = JSON.parse(argumentText); } catch { throw new Error(`自定义工具 ${item.name} 的参数不是有效 JSON`); }
      if (typeof parsed?.input !== "string") throw new Error(`自定义工具 ${item.name} 缺少 input 字符串`);
      item.input = parsed.input;
    }
  } else item.arguments = argumentText;
  return item;
}
