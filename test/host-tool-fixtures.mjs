export function successfulHostToolResult(tool, threadId = "task") {
  const data = {
    list_threads: { threads: [], pinnedThreads: [] },
    read_thread: { thread: { id: threadId }, turns: [] },
    list_projects: { projects: [] },
    get_usage_limits: { rateLimits: { primary: { usedPercent: 0 } } },
  }[tool];
  return { content: [{ type: "text", text: JSON.stringify(data) }], isError: false };
}

export function proveHostTools(tracker, threadId = null) {
  tracker.observeStartupStatus({ name: "codex_app", status: "ready", threadId });
  for (const tool of tracker.requiredTools) {
    const proof = tracker.beginToolCheck(threadId, tool, `proof-${tool}`);
    tracker.observeToolResult(successfulHostToolResult(tool, threadId), null, proof);
  }
}
