import { text, MAX_CACHED_RESPONSES } from "./contract.mjs";

function restoreToolCalls(request, history) {
  const source = Array.isArray(request.input) ? [...request.input] : request.input;
  const previousResponseId = text(request.previous_response_id);
  if (!Array.isArray(source)) return source;
  const outputCallIds = new Set(source
    .filter((item) => ["function_call_output", "custom_tool_call_output"].includes(item?.type))
    .map((item) => text(item.call_id))
    .filter(Boolean));
  // Only tool-result continuations require us to restore the assistant tool call.
  // A normal next user turn has no such dependency.
  if (!outputCallIds.size) return source;
  const existingCallIds = new Set(source
    .filter((item) => ["function_call", "custom_tool_call"].includes(item?.type) && text(item.name))
    .map((item) => text(item.call_id))
    .filter(Boolean));
  const missingCallIds = new Set([...outputCallIds].filter((id) => !existingCallIds.has(id)));
  // Full histories remain usable after cache eviction, and must not be duplicated.
  if (!missingCallIds.size) return source;
  if (!previousResponseId) {
    throw new Error(`工具结果缺少对应的调用：${[...missingCallIds].join("、")}`);
  }
  const cachedCalls = history.get(previousResponseId);
  if (!cachedCalls?.length) {
    throw new Error(
      `未找到 previous_response_id=${previousResponseId} 对应的工具调用；` +
      "请新建任务后再使用当前模型兼容模式",
    );
  }
  const restored = cachedCalls.filter((item) => missingCallIds.has(text(item.call_id)));
  for (const item of restored) missingCallIds.delete(text(item.call_id));
  if (missingCallIds.size) {
    throw new Error(`工具结果与 previous_response_id=${previousResponseId} 的调用不匹配：${[...missingCallIds].join("、")}`);
  }
  const firstOutputIndex = source.findIndex((item) => ["function_call_output", "custom_tool_call_output"].includes(item?.type));
  return [
    ...source.slice(0, firstOutputIndex),
    ...restored,
    ...source.slice(firstOutputIndex),
  ];
}

function createToolCallHistory() {
  const records = new Map();
  return {
    forPlatform(platformId) {
      // Responses belong to a provider; switching models within that provider
      // must still allow a tool result to reference its preceding response.
      const key = (responseId) => JSON.stringify([platformId, responseId]);
      return {
        get(responseId) {
          return records.get(key(responseId))?.calls ?? null;
        },
        getTools(responseId) { return records.get(key(responseId))?.tools ?? []; },
        remember(response, tools = []) {
          const calls = Array.isArray(response?.output)
            ? response.output.filter((item) => ["function_call", "custom_tool_call"].includes(item?.type) && text(item.call_id))
            : [];
          if (!text(response?.id)) return;
          records.set(key(response.id), { calls, tools });
          while (records.size > MAX_CACHED_RESPONSES) records.delete(records.keys().next().value);
        },
      };
    },
  };
}

export { createToolCallHistory, restoreToolCalls };
