import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { officialExecutable } from "../runtime-tests/support/offline-runtime.mjs";
import { browserExecutable } from "../runtime-tests/support/browser.mjs";
export const ROOT = resolve(import.meta.dirname, "..");
export const RESULTS = join(ROOT, ".runtime", "test-results");

export async function runtimeSnapshot() {
  const files = { cli: await officialExecutable(), browser: await browserExecutable() };
  for (const [name, path] of Object.entries(files)) {
    const bundle = path.match(/^(.*\.app\/Contents)\//)?.[1];
    if (bundle) files[`${name}BundleInfo`] = join(bundle, "Info.plist");
  }
  const result = {};
  for (const [name, path] of Object.entries(files)) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    result[name] = { path, sha256: hash.digest("hex") };
  }
  return result;
}

export async function sourceSnapshot() {
  const files = ["package.json", "package-lock.json", "docs/testing-protocol-inventory.json", "docs/testing-scenarios.json", "docs/codex-compatibility-test-plan.md"];
  async function walk(directory) {
    for (const entry of await readdir(join(ROOT, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else files.push(path);
    }
  }
  for (const path of ["src", "scripts", "test", "runtime-tests", "live-tests"]) await walk(path);
  const hash = createHash("sha256");
  for (const path of files.sort()) { hash.update(path); hash.update("\0"); hash.update(await readFile(join(ROOT, path))); hash.update("\0"); }
  return { sha256: hash.digest("hex"), fileCount: files.length };
}

export async function writeReport(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n");
}

export async function scenarioCoverage(tests = []) {
  const { groups } = JSON.parse(await readFile(join(ROOT, "docs/testing-scenarios.json"), "utf8"));
  const matrix = await readFile(join(ROOT, "docs/codex-compatibility-test-plan.md"), "utf8");
  const expected = [...matrix.matchAll(/^\| ([A-Z]+-\d{2}) \|/gm)].map(match => match[1]).sort();
  const ids = groups.flatMap(group => group.ids).sort();
  if (JSON.stringify(ids) !== JSON.stringify(expected)) throw new Error("场景矩阵与执行证据索引不一致；新增能力不能静默漏测");
  for (const file of new Set(groups.flatMap(group => group.free))) await access(join(ROOT, file));
  return groups.flatMap(group => group.ids.map(id => {
    const evidence = group.free.map(file => {
      const results = tests.filter(t => t.file && resolve(ROOT, t.file) === join(ROOT, file));
      return { file, status: !results.length ? "not-run" : results.every(t => t.status === "passed") ? "passed" : "incomplete-or-failed" };
    });
    return { id, deferred: Boolean(group.deferred), evidence, liveRequired: group.live ?? null,
      status: group.deferred ? "deferred" : evidence.length && evidence.every(e => e.status === "passed") ? "free-evidence-passed" : "not-verified",
      liveStatus: group.live ? "not-run" : "not-required", note: group.note };
  }));
}

export async function requireFreeResult() {
  const report = JSON.parse(await readFile(join(RESULTS, "offline.json"), "utf8").catch(() => {
    throw new Error("请先运行 npm run test:offline 并取得当前代码的完整免费通过报告");
  }));
  const snapshot = await sourceSnapshot();
  if (report.status !== "passed" || report.platform !== process.platform || report.arch !== process.arch || report.snapshot.sha256 !== snapshot.sha256) {
    throw new Error("免费报告未通过或不属于当前代码/平台；请先运行 npm run test:offline");
  }
  if (JSON.stringify(report.runtimeSnapshot) !== JSON.stringify(await runtimeSnapshot())) throw new Error("官方 CLI 或测试浏览器已更换；请重新运行 npm run test:offline");
  return report;
}
