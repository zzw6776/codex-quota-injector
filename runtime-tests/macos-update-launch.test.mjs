import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { cleanUpdateEnvironment } from "../src/app-update/native-install.mjs";
import { useTempDir, waitFor } from "../test/helpers.mjs";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const pollutedEnvironment = () => ({ ...cleanUpdateEnvironment(),
  CODEX_QUOTA_ROLE: "app-updater", CODEX_QUOTA_UPDATE_CONTROL: "/fixture/old-update/control.json",
  CODEX_QUOTA_RELAY_CONFIG: "/fixture/relay", CODEX_APP_TOOLS_PIPE_PATH: "/fixture/tools",
});

async function appFixture(t, name, source) {
  const directory = await useTempDir(t, "quota-update-launch-");
  const app = join(directory, `${name}.app`), contents = join(app, "Contents");
  await mkdir(join(contents, "MacOS"), { recursive: true });
  await mkdir(join(contents, "Resources"));
  await writeFile(join(contents, "Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict>
    <key>CFBundleExecutable</key><string>Probe</string>
    <key>CFBundleIdentifier</key><string>com.zzw6776.update-probe.${randomUUID()}</string>
    <key>CFBundleName</key><string>${name}</string><key>CFBundlePackageType</key><string>APPL</string>
    <key>LSUIElement</key><true/></dict></plist>`);
  const path = join(directory, "probe.swift");
  await writeFile(path, source);
  await exec("/usr/bin/xcrun", ["swiftc", "-target", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos12.0`,
    path, "-o", join(contents, "MacOS", "Probe")], { timeout: 30_000 });
  return { directory, app, contents };
}

test("macOS 更新启动清理更新器和中继身份，真实 open 保留指定数据目录与端口", {
  skip: process.platform !== "darwin", timeout: 45_000,
}, async t => {
  const fixture = await appFixture(t, "Environment Probe", `import Foundation
    let env = ProcessInfo.processInfo.environment
    let keys = ["CODEX_QUOTA_ROLE", "CODEX_QUOTA_UPDATE_CONTROL", "CODEX_QUOTA_RELAY_CONFIG",
      "CODEX_APP_TOOLS_PIPE_PATH", "CODEX_QUOTA_DATA_DIR", "CODEX_QUOTA_CDP_PORT", "PATH"]
    let selected = env.filter { keys.contains($0.key) }
    try JSONSerialization.data(withJSONObject: selected).write(to: URL(fileURLWithPath: env["PROBE_OUTPUT"]!))
    `);
  const output = join(fixture.directory, "environment.json");
  const caller = join(fixture.directory, "caller.mjs");
  await writeFile(caller, `import { launchUpdatedApp } from ${JSON.stringify(new URL("../src/app-update/native-install.mjs", import.meta.url).href)};
    await launchUpdatedApp(${JSON.stringify({ asset: { platform: "darwin" }, installedApp: fixture.app,
      dataDir: fixture.directory, cdpPort: 19999 })});`);
  await exec(process.execPath, [caller], { env: { ...pollutedEnvironment(), PROBE_OUTPUT: output }, timeout: 10_000 });
  const actual = await waitFor(() => readFile(output, "utf8").then(JSON.parse).catch(() => null), { timeoutMs: 10_000 });
  for (const key of ["CODEX_QUOTA_ROLE", "CODEX_QUOTA_UPDATE_CONTROL", "CODEX_QUOTA_RELAY_CONFIG", "CODEX_APP_TOOLS_PIPE_PATH"]) {
    assert.equal(actual[key], undefined, key);
  }
  assert.equal(actual.CODEX_QUOTA_DATA_DIR, fixture.directory);
  assert.equal(actual.CODEX_QUOTA_CDP_PORT, "19999");
  assert.equal(actual.PATH, process.env.PATH);
});

test("正式 macOS 入口清除继承的更新身份，同一外壳手动重开仍走应用启动", {
  skip: process.platform !== "darwin", timeout: 45_000,
}, async t => {
  const fixture = await appFixture(t, "GUI Role Probe", await readFile(join(root, "src/macos-launcher.swift"), "utf8"));
  const output = join(fixture.directory, "workers.jsonl"), capture = join(fixture.directory, "capture.mjs");
  await writeFile(capture, `import { appendFileSync } from "node:fs";
    appendFileSync(${JSON.stringify(output)}, JSON.stringify({ args: process.argv.slice(2), pid: process.pid, ppid: process.ppid,
      role: process.env.CODEX_QUOTA_ROLE ?? null, control: process.env.CODEX_QUOTA_UPDATE_CONTROL ?? null,
      dataDir: process.env.CODEX_QUOTA_DATA_DIR, port: process.env.CODEX_QUOTA_CDP_PORT })+"\\n");
    setTimeout(() => {}, 3000);`);
  const worker = join(fixture.contents, "Resources", "Codex Quota Injector Worker");
  await writeFile(worker, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(capture)} "$@"\n`);
  await chmod(worker, 0o755);
  const rows = () => readFile(output, "utf8").then(text => text.trim().split("\n").map(JSON.parse)).catch(() => []);
  t.after(async () => {
    // Only fixture-owned processes recorded by our capture may be cleaned up.
    for (const row of await rows()) for (const pid of [row.pid, row.ppid]) {
      try { process.kill(pid, "SIGTERM"); } catch { /* Already exited. */ }
    }
  });
  await exec("/usr/bin/open", ["-n", "-g", fixture.app, "--env", `CODEX_QUOTA_DATA_DIR=${fixture.directory}`,
    "--env", "CODEX_QUOTA_CDP_PORT=19998"], { env: pollutedEnvironment(), timeout: 10_000 });
  await waitFor(async () => (await rows()).length === 1, { timeoutMs: 10_000 });
  // Reopening the running GUI invokes applicationShouldHandleReopen. Its own
  // inherited environment remains polluted, even with a clean second caller.
  await exec("/usr/bin/open", ["-W", "-g", fixture.app], { env: cleanUpdateEnvironment(), timeout: 15_000 });
  const actual = await rows();
  assert.equal(actual.length, 2);
  assert.equal(actual[0].ppid, actual[1].ppid, "确实复用同一个启动外壳");
  for (const row of actual) {
    assert.deepEqual(row.args, ["--explicit-start"]);
    assert.equal(row.role, null); assert.equal(row.control, null);
    assert.equal(row.dataDir, fixture.directory); assert.equal(row.port, "19998");
  }
});
