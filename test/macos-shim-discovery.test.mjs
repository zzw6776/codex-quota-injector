import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { useTempDir } from "./helpers.mjs";
import { resolveCodexCliExecutable } from "../src/platform/executables.mjs";

const run = promisify(execFile);
const native = { skip: process.platform !== "darwin", timeout: 60000 };

test("[platform:macos-native] Swift CLI 查找支持新旧目录、显式优先及不可执行路径回退", native, async t => {
  const directory = await useTempDir(t, "shim-discovery-");
  const source = await readFile(resolve("src/macos-codex-shim.swift"), "utf8");
  // Compile the production resolver unchanged, with fixture bundles replacing
  // app discovery. This exercises Swift file/executable checks, not a JS copy.
  const prefix = source.slice(0, source.indexOf("private func clearBootstrapEnvironment()"));
  const harness = join(directory, "resolver.swift");
  const executable = join(directory, "resolver");
  await writeFile(harness, prefix + `
let bundles = CommandLine.arguments.dropFirst(2).map { URL(fileURLWithPath: $0) }
print(resolveOfficialExecutable(fallback: CommandLine.arguments[1], bundleURLs: bundles) ?? "NONE")
`);
  await run("/usr/bin/xcrun", ["swiftc", harness, "-o", executable]);
  const bundle = join(directory, "ChatGPT.app");
  const modern = join(bundle, "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex");
  const legacy = join(bundle, "Contents/Resources/codex");
  const makeExecutable = async path => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  };
  const discover = async (fallback = "") => (await run(executable, [fallback, bundle])).stdout.trim();
  await makeExecutable(modern);
  assert.equal(await discover(), modern);
  await makeExecutable(legacy);
  assert.equal(await discover(), modern, "同一安装优先新版目录");
  assert.equal(await discover(legacy), legacy, "显式备用路径仍优先");
  await chmod(modern, 0o644);
  assert.equal(await discover(), legacy, "新版文件不可执行则回退");
  await unlink(modern);
  assert.equal(await discover(), legacy, "旧版安装仍可发现");
  await symlink(executable, modern);
  assert.equal(await discover(), legacy, "指向 shim 自身的路径不能递归执行");
  assert.equal(await discover(join(directory, "missing")), legacy);
  await unlink(legacy);
  assert.equal(await discover(), "NONE");
});

test("[platform:macos-native] 完整 shim 在缺失或损坏配置时发现当前官方 CLI", native, async t => {
  let upstream;
  try { upstream = await resolveCodexCliExecutable({ environment: {} }); }
  catch { t.skip("此用例需要本机已安装官方 Codex"); return; }
  const directory = await useTempDir(t, "shim-fallback-");
  const shim = join(directory, "shim");
  await run("/usr/bin/xcrun", ["swiftc", resolve("src/macos-codex-shim.swift"), "-o", shim]);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CODEX_QUOTA_") || key.startsWith("CODEX_APP_SERVER_") || key === "CODEX_CLI_PATH") delete env[key];
  }
  const expected = (await run(upstream, ["--version"], { env })).stdout.trim();
  assert.equal((await run(shim, ["--version"], { env })).stdout.trim(), expected);
  const config = join(directory, "invalid.json");
  await writeFile(config, "{broken");
  assert.equal((await run(shim, ["--version"], { env: { ...env, CODEX_QUOTA_RELAY_CONFIG: config } })).stdout.trim(), expected);
});
