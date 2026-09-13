#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, release, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const options = parseOptions(process.argv.slice(2));
const resultDirectory = resolve(options.resultDir);
const manifestPath = join(resultDirectory, options.manifest);
const manifest = {
  version: 1,
  kind: options.kind,
  runtimeTarget: "wsl-native",
  status: "running",
  sourceSha256: options.sourceSha256,
  startedAt: new Date().toISOString(),
  stages: [],
};
let workspace = null;
let phase = "preflight";

await mkdir(resultDirectory, { recursive: true });
try {
  if (!process.env.WSL_DISTRO_NAME && !/microsoft/i.test(release())) {
    throw new Error("当前 Linux 进程不是 WSL");
  }
  if (process.platform !== "linux") throw new Error(`WSL 测试必须使用 Linux Node.js，实际 ${process.platform}`);
  assertNodeVersion(process.version);
  const runtimePath = [dirname(process.execPath), process.env.PATH].filter(Boolean).join(":");
  const npm = await commandPath("npm");
  const cli = options.cli || await commandPath("codex");
  const cliSha256 = await hashFile(cli);
  if (options.expectedCliSha256 && options.expectedCliSha256 !== cliSha256) {
    throw new Error("WSL 官方 CLI 已变化；请重新运行完整 A 批");
  }
  workspace = await mkdtemp(join(tmpdir(), "codex-quota-wsl-suite-"));
  await copyProject(options.sourceRoot, workspace);
  phase = "dependencies";
  const npmCache = join(homedir(), ".cache", "codex-quota-injector-tests", "npm");
  await mkdir(npmCache, { recursive: true });
  await runChecked(npm, ["ci", "--no-audit", "--no-fund"], {
    cwd: workspace,
    env: { ...process.env, PATH: runtimePath, npm_config_cache: npmCache },
  });
  const { sourceSnapshot } = await import(pathToFileURL(
    join(workspace, "scripts", "test-support.mjs"),
  ));
  const copiedSnapshot = await sourceSnapshot();
  if (copiedSnapshot.sha256 !== options.sourceSha256) {
    throw new Error("复制到 WSL 的源码与 A/B 计划绑定的源码不一致");
  }

  const accountCodexHome = options.codexHome ?? join(workspace, ".offline-account", "codex");
  const accountDataDir = options.dataDir ?? join(workspace, ".offline-account", "injector");
  await mkdir(accountCodexHome, { recursive: true });
  await mkdir(accountDataDir, { recursive: true });

  phase = "relay";
  const relay = options.relay || join(
    resultDirectory,
    "artifacts",
    `codex-quota-relay-wsl-${JSON.parse(await readFile(join(workspace, "package.json"), "utf8")).version}`,
  );
  if (!options.relay) {
    await mkdir(join(resultDirectory, "artifacts"), { recursive: true });
    await runChecked(process.execPath, [
      join(workspace, "scripts", "build-wsl-relay.mjs"),
      "--node-binary", process.execPath,
      "--output", relay,
    ], { cwd: workspace });
  }
  const relaySha256 = await hashFile(relay);
  if (options.expectedRelaySha256 && options.expectedRelaySha256 !== relaySha256) {
    throw new Error("WSL 原生 Relay 已变化；请重新运行完整 A 批");
  }

  manifest.runtimeSnapshot = {
    platform: process.platform,
    arch: process.arch,
    distribution: process.env.WSL_DISTRO_NAME ?? null,
    node: { path: process.execPath, version: process.version, sha256: await hashFile(process.execPath) },
    cli: { path: cli, sha256: cliSha256 },
    relay: { path: relay, sha256: relaySha256, kind: "linux-elf-sea" },
    dependencies: { platform: "linux", root: workspace, cache: npmCache },
  };

  phase = "tests";
  for (const stage of options.stages) {
    const eventPath = join(resultDirectory, stage.eventFile);
    const args = [
      "--test",
      "--test-concurrency=1",
      "--test-reporter=spec",
      "--test-reporter=./scripts/test-json-reporter.mjs",
      "--test-reporter-destination=stdout",
      `--test-reporter-destination=${eventPath}`,
      ...stage.files,
    ];
    const env = {
      ...process.env,
      PATH: runtimePath,
      CODEX_TEST_RUNTIME_TARGET: "wsl-native",
      CODEX_TEST_CLI: cli,
      CODEX_TEST_RELAY_EXECUTABLE: relay,
      CODEX_HOME: accountCodexHome,
      CODEX_QUOTA_DATA_DIR: accountDataDir,
      ...(options.liveProfile ? {
        CODEX_TEST_LIVE_APPROVED: "current-run",
        CODEX_TEST_LIVE_PROFILE: options.liveProfile,
      } : {}),
    };
    const code = await run(process.execPath, args, { cwd: workspace, env });
    manifest.stages.push({ id: stage.id, eventFile: stage.eventFile, code });
    await writeManifest();
    if (code !== 0) {
      manifest.status = "failed";
      break;
    }
  }
  if (manifest.status === "running") manifest.status = "passed";
} catch (error) {
  manifest.status = phase === "tests" ? "failed" : "blocked";
  manifest.error = publicError(error);
  process.exitCode = 1;
} finally {
  manifest.finishedAt = new Date().toISOString();
  await writeManifest();
  if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
}

if (manifest.status !== "passed") process.exitCode = 1;

async function copyProject(sourceRoot, targetRoot) {
  for (const directory of ["docs", "live-tests", "runtime-tests", "scripts", "src", "test"]) {
    await cp(join(sourceRoot, directory), join(targetRoot, directory), { recursive: true });
  }
  for (const file of ["package.json", "package-lock.json"]) {
    await cp(join(sourceRoot, file), join(targetRoot, file));
  }
}

async function commandPath(command) {
  const chunks = [];
  const child = spawn("sh", ["-lc", `command -v ${command}`], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  const code = await childExit(child);
  const path = Buffer.concat(chunks).toString().trim();
  if (code !== 0 || !path) throw new Error(`WSL PATH 中未找到 ${command}`);
  return path;
}

async function runChecked(command, args, options) {
  const code = await run(command, args, options);
  if (code !== 0) throw new Error(`${basename(command)} 退出码 ${code}`);
}

async function run(command, args, { cwd, env } = {}) {
  const child = spawn(command, args, { cwd, env, stdio: "inherit" });
  return childExit(child);
}

function childExit(child) {
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`子进程被信号 ${signal} 终止`));
      else resolveExit(Number(code));
    });
  });
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function writeManifest() {
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

function assertNodeVersion(value) {
  const match = String(value).match(/^v(\d+)\.(\d+)\.(\d+)/);
  if (!match) throw new Error(`无法识别 WSL Node.js 版本 ${value}`);
  const actual = match.slice(1).map(Number);
  const minimum = [22, 23, 1];
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return;
    if (actual[index] < minimum[index]) {
      throw new Error(`WSL Node.js 需要 >= 22.23.1，实际 ${value}`);
    }
  }
}

function parseOptions(args) {
  const values = {};
  for (const argument of args) {
    const [key, ...rest] = argument.split("=");
    const value = rest.join("=");
    if (key === "--source-root") values.sourceRoot = resolve(value);
    else if (key === "--result-dir") values.resultDir = resolve(value);
    else if (key === "--manifest") values.manifest = value;
    else if (key === "--source-sha256") values.sourceSha256 = value;
    else if (key === "--kind") values.kind = value;
    else if (key === "--stages") values.stages = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    else if (key === "--codex-home") values.codexHome = resolve(value);
    else if (key === "--data-dir") values.dataDir = resolve(value);
    else if (key === "--live-profile") values.liveProfile = value;
    else if (key === "--expected-cli-sha256") values.expectedCliSha256 = value;
    else if (key === "--expected-relay-sha256") values.expectedRelaySha256 = value;
    else if (key === "--cli") values.cli = resolve(value);
    else if (key === "--relay") values.relay = resolve(value);
    else throw new Error(`未知参数 ${key}`);
  }
  if (!values.sourceRoot || !values.resultDir || !values.manifest || !values.sourceSha256 ||
    !values.kind || !Array.isArray(values.stages)) {
    throw new Error("WSL 测试参数不完整");
  }
  if (values.liveProfile && (!values.codexHome || !values.dataDir)) {
    throw new Error("WSL 真实测试缺少账号配置目录");
  }
  for (const stage of values.stages) {
    if (!stage?.id || !Array.isArray(stage.files) || !stage.eventFile) {
      throw new Error("WSL 测试阶段无效");
    }
  }
  return values;
}

function publicError(error) {
  return {
    name: String(error?.name ?? "Error"),
    code: error?.code == null ? null : String(error.code),
    message: String(error?.message ?? error),
  };
}
