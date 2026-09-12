// A local WebSocket prewarm creates a local response ID. Its input must stay
// available when Codex sends only the delta on the next response.create.
// History is connection-owned and route-scoped; it never crosses providers.
export class ResponsesHistory {
  constructor({ maxEntries = 64, maxBytes = 64 * 1024 * 1024 } = {}) {
    this.records = new Map();
    this.bytes = 0;
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
  }

  expand(body, routeKey) {
    const previousId = body.previous_response_id;
    if (!previousId) return body;
    const previous = this.records.get(previousId);
    if (!previous || previous.routeKey !== routeKey) {
      throw new Error("无法恢复此 WebSocket 的 previous_response_id；请使用完整历史重新发起请求");
    }
    const incoming = Array.isArray(body.input) ? body.input : body.input ? [{ role: "user", content: body.input }] : [];
    const previousInput = Array.isArray(previous.body.input) ? previous.body.input : previous.body.input ? [{ role: "user", content: previous.body.input }] : [];
    // Some clients resend known items alongside a delta. Stable item IDs must
    // not be duplicated, and a newer copy wins without changing its position.
    const combined = [...previousInput, ...previous.output];
    const byId = new Map(combined.flatMap((item, index) => item?.id ? [[item.id, index]] : []));
    for (const item of incoming) {
      if (item?.id && byId.has(item.id)) combined[byId.get(item.id)] = item;
      else { if (item?.id) byId.set(item.id, combined.length); combined.push(item); }
    }
    const expanded = { ...previous.body, ...body, input: combined };
    delete expanded.previous_response_id;
    delete expanded.generate;
    return expanded;
  }

  remember(body, response, routeKey) {
    if (!response?.id || !["completed", "incomplete"].includes(response.status)) return;
    const value = { body, output: response.output ?? [], routeKey };
    const bytes = Buffer.byteLength(JSON.stringify(value));
    const old = this.records.get(response.id);
    if (old) this.bytes -= old.bytes;
    this.records.delete(response.id);
    // Oversize history is explicitly unavailable on continuation, never silently
    // truncated. The next full request can still run without a previous ID.
    if (bytes > this.maxBytes) return;
    this.records.set(response.id, { ...value, bytes });
    this.bytes += bytes;
    while (this.records.size > this.maxEntries || this.bytes > this.maxBytes) {
      const first = this.records.keys().next().value;
      this.bytes -= this.records.get(first).bytes;
      this.records.delete(first);
    }
  }
}
