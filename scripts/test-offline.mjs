import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  activateOfflineNetworkIsolation,
  sandboxCommand,
} from "../runtime-tests/support/offline-runtime.mjs";
import { RESULTS, ROOT, runtimeSnapshot, scenarioCoverage, sourceSnapshot, writeReport } from "./test-support.mjs";

await mkdir(RESULTS, { recursive: true });
const report = { status: "running", batch: "A-free", modelRequests: "scripted loopback service only", platform: process.platform,
  arch: process.arch, node: process.version, startedAt: new Date().toISOString(), snapshot: await sourceSnapshot(),
  excluded: ["关闭或重启日常 Codex", "切换真实账号", "安装更新与进程接管"], tests: [] };
const reportPath = join(RESULTS, "offline.json");
await writeReport(reportPath, report);
let networkIsolation = null;
try {
  report.runtimeSnapshot = await runtimeSnapshot();
  networkIsolation = await activateOfflineNetworkIsolation([
    process.execPath,
    report.runtimeSnapshot.cli?.path,
    report.runtimeSnapshot.browser?.path,
  ]);
  const events = [];
  const summaries = [];
  const exits = [];
  for (const directory of ["test", "runtime-tests"]) {
    const files = (await readdir(join(ROOT, directory))).filter(file => file.endsWith(".test.mjs")).sort().map(file => `${directory}/${file}`);
    const eventPath = join(RESULTS, `offline-${directory}-events.jsonl`);
    const args = ["--test", "--test-concurrency=1", "--test-reporter=spec", "--test-reporter=./scripts/test-json-reporter.mjs",
      "--test-reporter-destination=stdout", `--test-reporter-destination=${eventPath}`, ...files];
    // macOS refuses to execute its privileged /bin/ps inside any Seatbelt
    // sandbox. Pure contract tests retain their existing fixture-only setup;
    // every official/model/browser workflow stays under the network sandbox.
    const command = directory === "runtime-tests" ? sandboxCommand(process.execPath, args) : { executable: process.execPath, args };
    const child = spawn(command.executable, command.args, { cwd: ROOT, stdio: "inherit" });
    const onInterrupt = () => child.kill("SIGTERM");
    process.once("SIGINT", onInterrupt); process.once("SIGTERM", onInterrupt);
    let exit;
    try { exit = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal })); }); }
    finally { process.removeListener("SIGINT", onInterrupt); process.removeListener("SIGTERM", onInterrupt); }
    exits.push({ stage: directory, ...exit });
    const stageEvents = (await readFile(eventPath, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(JSON.parse);
    events.push(...stageEvents);
    summaries.push({ stage: directory, ...stageEvents.filter(e => e.type === "test:summary").at(-1) });
    if (exit.signal) break;
  }
  await writeFile(join(RESULTS, "offline-events.jsonl"), events.map(e => JSON.stringify(e) + "\n").join(""));
  report.tests = events.filter(e => ["test:pass", "test:fail"].includes(e.type)).map(e => ({
    name: e.name, file: e.file, line: e.line, nesting: e.nesting, status: e.skip ? "skipped" : e.type === "test:pass" ? "passed" : "failed",
    durationMs: e.details?.duration_ms, error: e.details?.error, scenarios: [...new Set(e.name.match(/\b[A-Z]{2,4}-\d{2}\b/g) ?? [])],
  }));
  report.stages = summaries;
  const counts = {};
  for (const summary of summaries) for (const [name, value] of Object.entries(summary.counts ?? {})) counts[name] = (counts[name] ?? 0) + value;
  report.summary = { counts, duration_ms: summaries.reduce((total, s) => total + (s.duration_ms ?? 0), 0) };
  report.runtimeVersions = [...new Set(events.filter(e => e.type === "test:diagnostic" && /codex-cli|测试浏览器/.test(e.message)).map(e => e.message))];
  report.coverage = await scenarioCoverage(report.tests);
  report.mainEntryStatus = "not-verified";
  report.status = exits.length === 2 && exits.every(e => e.code === 0) && report.tests.length > 0 && !report.tests.some(t => t.status === "failed") ? "passed" : "failed";
  if (report.status === "passed" && report.tests.some(t => t.status === "skipped")) report.status = "incomplete";
  report.exits = exits;
  report.isolation = {
    contracts: "temporary fixtures; no real credentials or models",
    runtime: networkIsolation.mode,
  };
  if ((await sourceSnapshot()).sha256 !== report.snapshot.sha256) { report.status = "stale"; report.error = "测试期间代码发生变化，不能作为当前代码的通过报告"; }
  if (JSON.stringify(await runtimeSnapshot()) !== JSON.stringify(report.runtimeSnapshot)) { report.status = "stale"; report.error = "测试期间官方 CLI 或浏览器发生变化"; }
} catch (error) { report.status = "blocked"; report.error = error.message; }
finally {
  if (networkIsolation) {
    await networkIsolation.close().catch((error) => {
      report.status = "blocked";
      report.error = `临时出站隔离清理失败：${error.message}`;
    });
  }
}
report.finishedAt = new Date().toISOString();
await writeReport(reportPath, report);
console.log(`\n免费测试：${report.status}；报告：${reportPath}`);
if (report.status === "passed") {
  console.log("A 批已通过。下一步应主动向用户分别确认 B1 官方模型、B2 DeepSeek 和 C 生命周期；不得自动执行。");
  console.log("计划命令：npm run test:live:official -- --plan；npm run test:live:deepseek -- --plan；npm run test:lifecycle -- --plan");
}
if (report.status !== "passed") process.exitCode = 1;
