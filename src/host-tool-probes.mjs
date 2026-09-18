// Small, read-only probes. Results contain health evidence, never returned user data.
export function hostToolArguments(tool, threadId) {
  if (tool === "list_threads") return { limit: 1 };
  if (tool === "read_thread") return {
    threadId, turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 100,
  };
  return {};
}

export function classifyHostToolResult(tool, result, error, { targetThreadId } = {}) {
  const content = Array.isArray(result?.content) ? result.content : [];
  if (error || result?.isError === true) {
    const detail = (error?.message ?? (typeof error === "string" ? error : null) ??
      content.filter(x => x.type === "text").map(x => x.text).join(" ")) || "工具调用失败";
    return { status: /timeout|timed out|超时/i.test(detail) ? "unconfirmed" : "failed", detail };
  }
  let data = result?.structuredContent;
  if (!data) {
    for (const block of content) {
      if (block.type !== "text") continue;
      try { data = JSON.parse(block.text); break; } catch { /* Try the next text block. */ }
    }
  }
  const record = data && typeof data === "object" && !Array.isArray(data);
  let valid = false;
  if (record && tool === "list_threads") valid = Array.isArray(data.threads) && Array.isArray(data.pinnedThreads);
  if (record && tool === "list_projects") valid = Array.isArray(data.projects);
  if (record && tool === "read_thread") valid = data.thread?.id === targetThreadId && Array.isArray(data.turns);
  if (record && tool === "get_usage_limits") {
    const limits = data.rateLimitsByLimitId;
    valid = (data.rateLimits != null && typeof data.rateLimits === "object") ||
      (limits != null && typeof limits === "object" && Object.values(limits).some(x => x != null));
    if (!valid && (Object.hasOwn(data, "rateLimits") || Object.hasOwn(data, "rateLimitsByLimitId"))) {
      return { status: "unconfirmed", detail: "接口已响应，但当前未提供用量额度数据" };
    }
  }
  return valid ? { status: "passed", detail: null }
    : { status: "unconfirmed", detail: "接口已响应，返回内容未通过检查" };
}
