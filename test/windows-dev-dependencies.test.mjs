import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { useTempDir } from "./helpers.mjs";

const exec = promisify(execFile);
const powershell = process.platform === "win32" ? "powershell.exe" : null;

async function writeFakeNpm(directory, mode) {
  const state = join(directory, "npm-state.txt");
  const calls = join(directory, "npm-calls.txt");
  const path = join(directory, "fake npm cli.mjs");
  const content = `import { appendFileSync, existsSync, writeFileSync } from "node:fs";\n` +
    `const args = process.argv.slice(2);\n` +
    `appendFileSync(${JSON.stringify(calls)}, args.join(" ") + "\\n");\n` +
    `if (args[0] === "install") {\n` +
    (mode === "install-fails"
      ? `  process.exit(7);\n`
      : `  writeFileSync(${JSON.stringify(state)}, "ready"); process.exit(0);\n`) +
    `}\n` +
    (mode === "healthy"
      ? `process.exit(0);\n`
      : `process.exit(existsSync(${JSON.stringify(state)}) ? 0 : 1);\n`);
  await writeFile(path, content);
  return { path, calls };
}

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function runDependencySync(directory, npmCli) {
  const helper = join(import.meta.dirname, "..", "scripts", "windows-dev-dependencies.ps1");
  const log = join(directory, "launcher.log");
  const command = `. ${quotePowerShell(helper)}; ` +
    `Sync-WindowsDevDependencies ${quotePowerShell(directory)} ${quotePowerShell(process.execPath)} ` +
    `${quotePowerShell(npmCli)} ${quotePowerShell(log)}`;
  return exec(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command]);
}

async function resolveRealNpmCli() {
  const nodeDirectory = dirname(process.execPath);
  const candidates = [
    join(nodeDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(nodeDirectory), "node_modules", "npm", "bin", "npm-cli.js"),
    ...String(process.env.Path ?? process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => join(directory, "node_modules", "npm", "bin", "npm-cli.js")),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error(`当前 Windows Node.js 没有配套 npm CLI: ${process.execPath}`);
}

if (powershell) test("[platform:windows-native] Windows 开发入口清除 Relay 子进程环境且保留用户配置", async () => {
  const helper = join(import.meta.dirname, "..", "scripts", "windows-dev-dependencies.ps1");
  const command = [
    '$env:CODEX_QUOTA_RELAY_CONFIG="relay.json"',
    '$env:CODEX_QUOTA_ROLE="app-server-relay"',
    '$env:CODEX_QUOTA_ROUTER_TOKEN="secret"',
    '$env:CODEX_QUOTA_UPSTREAM_CODEX_CLI="codex.exe"',
    '$env:CODEX_QUOTA_DATA_DIR="user-data"',
    `. ${quotePowerShell(helper)}`,
    "Reset-WindowsDevLauncherEnvironment",
    '[pscustomobject]@{relay=$env:CODEX_QUOTA_RELAY_CONFIG;role=$env:CODEX_QUOTA_ROLE;token=$env:CODEX_QUOTA_ROUTER_TOKEN;upstream=$env:CODEX_QUOTA_UPSTREAM_CODEX_CLI;data=$env:CODEX_QUOTA_DATA_DIR}|ConvertTo-Json -Compress',
  ].join("; ");
  const { stdout } = await exec(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command]);
  assert.deepEqual(JSON.parse(stdout), {
    relay: null,
    role: null,
    token: null,
    upstream: null,
    data: "user-data",
  });
});

if (powershell) test("[platform:windows-native] Windows 开发入口仅在依赖树不完整时安装并再次验证", async (t) => {
  const healthyDirectory = await useTempDir(t, "codex-dependencies-healthy-");
  await mkdir(join(healthyDirectory, "node_modules"));
  const healthyNpm = await writeFakeNpm(healthyDirectory, "healthy");
  await runDependencySync(healthyDirectory, healthyNpm.path);
  assert.deepEqual((await readFile(healthyNpm.calls, "utf8")).trim().split(/\r?\n/), ["ls --all --silent"]);

  const staleDirectory = await useTempDir(t, "codex-dependencies-stale-");
  await mkdir(join(staleDirectory, "node_modules"));
  const staleNpm = await writeFakeNpm(staleDirectory, "stale");
  await runDependencySync(staleDirectory, staleNpm.path);
  assert.deepEqual((await readFile(staleNpm.calls, "utf8")).trim().split(/\r?\n/).map(line => line.trim()), [
    "ls --all --silent",
    "install --no-audit --no-fund",
    "ls --all --silent",
  ]);
});

if (powershell) test("[platform:windows-native] Windows 开发入口在自动安装失败时返回可诊断错误", async (t) => {
  const directory = await useTempDir(t, "codex-dependencies-failure-");
  await mkdir(join(directory, "node_modules"));
  const fakeNpm = await writeFakeNpm(directory, "install-fails");
  await assert.rejects(runDependencySync(directory, fakeNpm.path), (error) => {
    assert.match(`${error.stdout}\n${error.stderr}`, /npm install failed with exit code 7/);
    return true;
  });
});

if (powershell) test("[platform:windows-native] Windows 开发入口使用真实 Node 执行 npm CLI 并读取退出码", async (t) => {
  const npmCli = await resolveRealNpmCli();
  const directory = await useTempDir(t, "codex-dependencies-real-npm-");
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "dependency-fixture", private: true }));
  await writeFile(join(directory, "package-lock.json"), JSON.stringify({
    name: "dependency-fixture",
    lockfileVersion: 3,
    requires: true,
    packages: { "": { name: "dependency-fixture" } },
  }));
  const log = join(directory, "launcher.log");
  const helper = join(import.meta.dirname, "..", "scripts", "windows-dev-dependencies.ps1");
  const command = `. ${quotePowerShell(helper)}; ` +
    `Sync-WindowsDevDependencies ${quotePowerShell(directory)} ${quotePowerShell(process.execPath)} ` +
    `${quotePowerShell(npmCli)} ${quotePowerShell(log)}`;
  const result = await exec(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command]);
  assert.equal(result.stdout.trim(), "False");
});
