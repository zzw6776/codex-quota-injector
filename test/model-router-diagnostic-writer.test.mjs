import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createDiagnosticEventWriter } from "../src/model-router/diagnostic-writer.mjs";
import { sandboxPrincipals } from "../src/model-router/diagnostic-permissions.mjs";
import { useTempDir } from "./helpers.mjs";

test("全量请求日志按单文件容量轮换且所有事件仍保留", async t => {
  const directory = await useTempDir(t);
  const path = join(directory, "model-request-diagnostics.jsonl");
  const warnings = [];
  const writer = createDiagnosticEventWriter(path, { maxFileBytes: 220, log: message => warnings.push(message) });
  for (let index = 0; index < 6; index++) writer.write({ type: "model-request-diagnostic", phase: "body-chunk",
    dataBase64: Buffer.from(`secret-${index}`.repeat(5)).toString("base64") });
  await writer.close();
  const files = (await readdir(directory)).filter(name => name.startsWith("model-request-diagnostics"));
  assert.ok(files.length > 1);
  const events = [];
  for (const file of files) events.push(...(await readFile(join(directory, file), "utf8")).trim().split("\n").map(JSON.parse));
  assert.equal(events.length, 6);
  assert.deepEqual(new Set(events.map(event => event.eventId)).size, 6);
  if (process.platform !== "win32") {
    for (const file of files) assert.equal((await stat(join(directory, file))).mode & 0o777, 0o600);
  }
  assert.deepEqual(warnings, []);
});

test("Windows ACL 解析只识别 CodexSandboxUsers 主体", () => {
  const acl = `C:\\secret.json DESKTOP\\CodexSandboxUsers:(I)(RX)\r\n` +
    `               NT AUTHORITY\\SYSTEM:(I)(F)\r\n` +
    `               DESKTOP\\ZZW:(I)(F)\r\n`;
  assert.deepEqual(sandboxPrincipals(acl), ["DESKTOP\\CodexSandboxUsers"]);
});
