import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

const directory = process.argv[2];
const marker = join(directory, "mcp-marker.txt");
const pending = new Map();
const send = value => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
const reply = (id, result) => send({ id, result });
const content = text => ({ content: [{ type: "text", text }] });
const tools = ["record", "fail", "ask"].map(name => ({ name, description: `Offline fixture ${name}`,
  inputSchema: { type: "object", properties: { text: { type: "string" } } }, annotations: { readOnlyHint: name !== "record", destructiveHint: false } }));
const lines = createInterface({ input: process.stdin });
lines.on("line", async line => {
  const value = JSON.parse(line);
  if (!value.method) { pending.get(value.id)?.(value.result); pending.delete(value.id); return; }
  if (value.id == null) return;
  await appendFile(join(directory, "mcp-events.jsonl"), `${JSON.stringify({ method: value.method, params: value.params })}\n`);
  switch (value.method) {
    case "initialize": return reply(value.id, { protocolVersion: value.params.protocolVersion,
      capabilities: { tools: { listChanged: true }, resources: { subscribe: true, listChanged: true } },
      serverInfo: { name: "quota-offline-mcp", version: "1.0.0" } });
    case "ping": return reply(value.id, {});
    case "tools/list": return reply(value.id, { tools });
    case "resources/list": return reply(value.id, { resources: [{ uri: "fixture://marker", name: "Independent marker", mimeType: "text/plain" }] });
    case "resources/templates/list": return reply(value.id, { resourceTemplates: [] });
    case "resources/subscribe": return reply(value.id, {});
    case "resources/unsubscribe": return reply(value.id, {});
    case "resources/read": return reply(value.id, { contents: [{ uri: value.params.uri, mimeType: "text/plain", text: await readFile(marker, "utf8").catch(() => "EMPTY") }] });
    case "tools/call": {
      const { name, arguments: args = {}, _meta } = value.params;
      if (_meta?.progressToken != null) send({ method: "notifications/progress", params: { progressToken: _meta.progressToken, progress: 1, total: 2, message: "fixture progress" } });
      if (name === "record") {
        await writeFile(marker, args.text ?? "MCP_MARKER");
        send({ method: "notifications/resources/updated", params: { uri: "fixture://marker" } });
        return reply(value.id, content(await readFile(marker, "utf8")));
      }
      if (name === "fail") return reply(value.id, { ...content("EXPECTED_TOOL_ERROR"), isError: true });
      if (name === "ask") {
        const id = `elicitation-${value.id}`;
        const answer = new Promise(resolve => pending.set(id, resolve));
        send({ id, method: "elicitation/create", params: { mode: "form", message: "允许这个临时测试读取标记？",
          requestedSchema: { type: "object", properties: { accept: { type: "boolean", title: "Accept" } }, required: ["accept"] } } });
        const result = await answer;
        return reply(value.id, content(JSON.stringify(result)));
      }
      return send({ id: value.id, error: { code: -32602, message: "Unknown fixture tool" } });
    }
    default: return send({ id: value.id, error: { code: -32601, message: "Method not found" } });
  }
});
