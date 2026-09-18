import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import reporter from "../scripts/ci-test-reporter.mjs";
import { useTempDir } from "./helpers.mjs";

test("CI 日志在测试完成前输出开始事件，并保留耗时、跳过及异常", async () => {
  const events = reporter([
    { type: "test:dequeue", data: { name: "case", file: "case.test.mjs", line: 4 } },
    { type: "test:fail", data: { name: "case", details: { duration_ms: 12, error: new Error("failure marker") } } },
    { type: "test:pass", data: { name: "conditional", skip: "platform" } },
    { type: "test:stderr", data: { message: "worker detail" } },
    { type: "test:summary", data: { counts: { failed: 1 } } },
  ]);
  assert.match((await events.next()).value, /\[\d{4}-.*Z\] START case case.test.mjs:4/);
  let output = "";
  for await (const chunk of events) output += chunk;
  assert.match(output, /FAIL case \(12 ms\)/);
  assert.match(output, /failure marker/);
  assert.match(output, /PASS SKIP conditional/);
  assert.match(output, /worker detail/);
  assert.match(output, /SUMMARY.*"failed":1/);
});

test("CI Node 超时结束被遗留定时器占住的测试文件，并输出文件与失败原因", async t => {
  const directory = await useTempDir(t, "ci-reporter-timeout-");
  const fixture = join(directory, "leaked-timer.test.mjs");
  await writeFile(fixture, "import test from 'node:test';\ntest('finished case',()=>{});\nsetInterval(()=>{},1000);\n");
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  let failure;
  try {
    await promisify(execFile)(process.execPath, ["--test", "--test-concurrency=1", "--test-timeout=1000",
      `--test-reporter=${resolve("scripts/ci-test-reporter.mjs")}`, fixture], { env, timeout: 10_000 });
  } catch (error) { failure = error; }
  assert.ok(failure, "leaked worker must fail");
  assert.equal(failure.killed, false, "Node must time out before the outer safety timer");
  assert.equal(failure.code, 1);
  assert.match(failure.stdout, /START .*leaked-timer.test.mjs/);
  assert.match(failure.stdout, /FAIL .*leaked-timer.test.mjs/);
  assert.match(failure.stdout, /testTimeoutFailure|timed out/);
});
