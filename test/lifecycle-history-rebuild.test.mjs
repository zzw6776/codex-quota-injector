import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { requestThreadHistoryRebuild } from "../src/lifecycle-history-rebuild.mjs";
import { useTempDir } from "./helpers.mjs";

test("[LCH-04] 历史重建客户端显式恢复每个任务且不启动回合", async (t) => {
  const directory = await useTempDir(t, "codex-history-rebuild-");
  const fixturePath = join(directory, "fixture.mjs");
  const capturePath = join(directory, "capture.jsonl");
  await writeFile(fixturePath, `
import { appendFile } from "node:fs/promises";
import readline from "node:readline";
const capturePath = process.argv[2];
const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  await appendFile(capturePath, JSON.stringify(message) + "\\n");
  if (message.id != null) {
    const result = message.method === "thread/resume"
      ? { thread: { id: message.params.threadId } }
      : {};
    process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
  }
}
`);

  const result = await requestThreadHistoryRebuild({
    command: process.execPath,
    args: [fixturePath, capturePath],
    threadIds: ["thread-a", "thread-a", "thread-b"],
  });
  assert.deepEqual(result, {
    status: "requested",
    requestedThreadIds: ["thread-a", "thread-b"],
  });
  const messages = (await readFile(capturePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(messages, [
    {
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "codex_quota_lifecycle_history", version: "1" },
        capabilities: { experimentalApi: true },
      },
    },
    { method: "initialized", params: {} },
    { id: 2, method: "thread/resume", params: { threadId: "thread-a", excludeTurns: true } },
    { id: 3, method: "thread/resume", params: { threadId: "thread-b", excludeTurns: true } },
  ]);
});
