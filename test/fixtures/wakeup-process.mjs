import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const [scenario, tracePath] = process.argv.slice(2);
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const done = () => send({ method: "turn/completed", params: { threadId: "wakeup-fixture", turn: { status: "completed", items: [{ type: "agentMessage", text: "OK" }] } } });
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  appendFileSync(tracePath, JSON.stringify(request) + "\n");
  const result = result => send({ id: request.id, result });
  if (request.method === "initialize") {
    if (scenario === "exit") process.exit(7);
    if (scenario === "malformed") { process.stdout.write("not-json\n"); continue; }
    result({});
  } else if (request.method === "account/login/start") {
    if (scenario === "secret-error") send({ id: request.id, error: { code: -1, message: "Bad fixture-secret-token" } });
    else result({});
  } else if (request.method === "model/list") {
    result({ data: scenario === "unknown-model" ? [{ model: "future-unpriced", inputModalities: ["text"] }] :
      request.params.cursor ? [{ model: "gpt-5.4-mini", supportedReasoningEfforts: [{ reasoningEffort: "low" }], inputModalities: ["text"] }] :
        [{ model: "gpt-5.4", supportedReasoningEfforts: [{ reasoningEffort: "high" }], inputModalities: ["text"] }, { model: "gpt-5.4-mini", hidden: true }],
      nextCursor: scenario === "unknown-model" || request.params.cursor ? null : "page-2" });
  } else if (request.method === "thread/start") result({ thread: { id: "wakeup-fixture" } });
  else if (request.method === "turn/start") {
    result({ turn: { id: "turn-fixture" } });
    if (scenario === "hang") continue;
    if (scenario === "interaction") send({ id: "unexpected-host-request", method: "item/tool/call", params: { threadId: "wakeup-fixture", tool: "must-not-execute" } });
    else if (scenario === "refresh") send({ id: "refresh-fixture", method: "account/chatgptAuthTokens/refresh", params: {} });
    else done();
  } else if (request.id === "refresh-fixture") done();
}
