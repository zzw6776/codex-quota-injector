import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { access, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { officialExecutable } from "../runtime-tests/support/offline-runtime.mjs";
import { browserExecutable } from "../runtime-tests/support/browser.mjs";
import { WINDOWS_NATIVE, prepareWindowsNativeRelay } from "./test-runtime-targets.mjs";
import { evidenceFile, evidenceManifest } from "./test-impact.mjs";
export const ROOT = resolve(import.meta.dirname, "..");
export const RESULTS = join(ROOT, ".runtime", "test-results");

export async function runtimeSnapshot() {
  const files = { cli: await officialExecutable(), browser: await browserExecutable(), node: process.execPath };
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

export async function modelTestRuntimeSnapshot(runtimeTarget, { inspectHostRuntime = runtimeSnapshot, exec = promisify(execFile) } = {}) {
  const host = await inspectHostRuntime();
  if (runtimeTarget !== "wsl-native") return host;
  // POSIX sh implementations may process only the first name in command -v.
  const paths = (await exec("wsl.exe", ["-e", "sh", "-lc", 'for task_runtime_command in codex node; do command -v "$task_runtime_command" || exit; done'], { windowsHide: true })).stdout.trim().split(/\r?\n/);
  if (paths.length !== 2 || paths.some(path => !path.startsWith("/"))) throw Error("无法核对WSL原生CLI与Node");
  const hashes = (await exec("wsl.exe", ["-e", "sha256sum", "--", ...paths], { windowsHide: true })).stdout.trim().split(/\r?\n/).map(line => line.split(/\s+/)[0]);
  if (hashes.length !== 2 || hashes.some(hash => !/^[a-f0-9]{64}$/.test(hash))) throw Error("WSL运行时摘要不可用");
  return { cli: { path: paths[0], sha256: hashes[0] }, node: { path: paths[1], sha256: hashes[1] }, browser: host.browser };
}

export async function sourceSnapshot({ root = ROOT } = {}) {
  const files = [
    "package.json",
    "package-lock.json",
    "docs/testing-protocol-inventory.json",
    "docs/testing-scenarios.json",
    "docs/codex-compatibility-test-plan.md",
    "docs/testing-desktop-host.md",
  ];
  async function walk(directory) {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else files.push(path);
    }
  }
  for (const path of ["src", "scripts", "test", "runtime-tests", "live-tests"]) await walk(path);
  const hash = createHash("sha256");
  const inputs = [];
  let releaseVersion;
  for (const path of files.sort()) {
    const bytes = await readFile(join(root, path));
    hash.update(path); hash.update("\0"); hash.update(bytes); hash.update("\0");
    inputs.push(evidenceFile(path, bytes));
    if (path === "package.json") releaseVersion = JSON.parse(String(bytes)).version;
  }
  // Package assets were missing from the old full-source digest. Keep its exact
  // algorithm for legacy provenance, while the new evidence includes these inputs.
  for (const directory of ["assets", "installer", ".github"]) {
    async function extra(relative) {
      for (const entry of await readdir(join(root, relative), { withFileTypes: true }).catch(error => {
        if (error.code === "ENOENT") return [];
        throw error;
      })) {
        const path = `${relative}/${entry.name}`;
        if (entry.isDirectory()) await extra(path);
        else inputs.push(evidenceFile(path, await readFile(join(root, path))));
      }
    }
    await extra(directory);
  }
  return { sha256: hash.digest("hex"), fileCount: files.length, ...evidenceManifest(inputs, releaseVersion) };
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

export async function prepareModelTestRuntime({
  runtimeTarget,
  root = ROOT,
  snapshotSource = sourceSnapshot,
  inspectRuntime = runtimeSnapshot,
  buildWindowsRelay = prepareWindowsNativeRelay,
} = {}) {
  const [snapshot, hostRuntimeSnapshot] = await Promise.all([snapshotSource(), inspectRuntime()]);
  // Windows 使用当前源码构建 PE；WSL 执行器在 Linux 独立准备 ELF 和依赖。
  const relay = runtimeTarget === WINDOWS_NATIVE ? await buildWindowsRelay({ root }) : null;
  return { snapshot, hostRuntimeSnapshot, relay, freeRegressionGate: "not-required" };
}
