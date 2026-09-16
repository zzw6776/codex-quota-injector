import assert from "node:assert/strict";
import test from "node:test";
import { selectBridgeMode } from "../src/codex-bridge.mjs";
import { spawn } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { useTempDir, waitFor } from "./helpers.mjs";
import { execFileAsync, baseCatalog } from "./model-configuration/support.mjs";

test("[platform:macos-native] macOS 仅在模型目录需要注入时接管", () => {
  assert.equal(selectBridgeMode({
    platform: "darwin",
    staticModelCatalog: false,
    customRoutingRequired: false,
  }), "direct");
  assert.equal(selectBridgeMode({
    platform: "darwin",
    staticModelCatalog: true,
    customRoutingRequired: false,
  }), "macos-shim");
  assert.equal(selectBridgeMode({
    platform: "darwin",
    staticModelCatalog: true,
    customRoutingRequired: true,
  }), "macos-router");
});

test("[platform:windows-native] Windows 持续通过 Relay 观察模型流量", () => {
  assert.equal(selectBridgeMode({
    platform: "win32",
    staticModelCatalog: false,
    customRoutingRequired: false,
  }), "windows-relay");
  assert.equal(selectBridgeMode({
    platform: "win32",
    staticModelCatalog: true,
    customRoutingRequired: true,
  }), "windows-relay");
});

test("未适配的平台不会选择桌面桥接模式", () => {
  assert.equal(selectBridgeMode({
    platform: "linux",
    staticModelCatalog: true,
    customRoutingRequired: true,
  }), "unsupported");
});

if (process.platform === "darwin") test(
  "[platform:macos-native] macOS shim 将 RPC 中继放到 sidecar 并让官方 app-server 保持桌面直系子进程",
  async (t) => {
  const directory = await useTempDir(t, "codex-shim-test-");
  const shim = join(directory, "shim");
  const fakeCodex = join(directory, "fake-codex.mjs");
  const fakeRelay = join(directory, "fake-relay.mjs");
  const relayCapturePath = join(directory, "relay-capture.json");
  const officialCapturePath = join(directory, "official-capture.json");
  const statePath = join(directory, "relay-state.json");
  const catalogPath = join(directory, "catalog with spaces.json");
  const configPath = join(directory, "relay-config.json");
  await writeFile(catalogPath, JSON.stringify(baseCatalog()));
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
await writeFile(process.env.SHIM_OFFICIAL_CAPTURE, JSON.stringify({
  pid: process.pid,
  ppid: process.ppid,
  args: process.argv.slice(2),
  env: {
    cliPath: process.env.CODEX_CLI_PATH,
    relayConfig: process.env.CODEX_QUOTA_RELAY_CONFIG ?? null,
    role: process.env.CODEX_QUOTA_ROLE ?? null,
    sidecar: process.env.CODEX_QUOTA_APP_SERVER_SIDECAR ?? null,
    upstreamStdinFd: process.env.CODEX_QUOTA_UPSTREAM_STDIN_FD ?? null,
    upstreamStdoutFd: process.env.CODEX_QUOTA_UPSTREAM_STDOUT_FD ?? null,
    primaryAppServer: process.env.CODEX_QUOTA_PRIMARY_APP_SERVER ?? null,
    routerToken: process.env.CODEX_QUOTA_ROUTER_TOKEN ?? null,
  },
}));
await new Promise(resolve => setTimeout(resolve, 150));
process.stdout.write("OFFICIAL_THROUGH_SIDECAR\\n");
`);
  await chmod(fakeCodex, 0o755);
  await writeFile(fakeRelay, `#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
await writeFile(process.env.SHIM_RELAY_CAPTURE, JSON.stringify({
  pid: process.pid,
  ppid: process.ppid,
  args: process.argv.slice(2),
  env: {
    cliPath: process.env.CODEX_CLI_PATH,
    relayConfig: process.env.CODEX_QUOTA_RELAY_CONFIG ?? null,
    upstream: process.env.CODEX_QUOTA_UPSTREAM_CODEX_CLI ?? null,
    role: process.env.CODEX_QUOTA_ROLE ?? null,
    sidecar: process.env.CODEX_QUOTA_APP_SERVER_SIDECAR ?? null,
    upstreamStdinFd: process.env.CODEX_QUOTA_UPSTREAM_STDIN_FD ?? null,
    upstreamStdoutFd: process.env.CODEX_QUOTA_UPSTREAM_STDOUT_FD ?? null,
    primaryAppServer: process.env.CODEX_QUOTA_PRIMARY_APP_SERVER ?? null,
    routerToken: process.env.CODEX_QUOTA_ROUTER_TOKEN ?? null,
  },
}));
const upstream = createReadStream(null, {
  fd: Number(process.env.CODEX_QUOTA_UPSTREAM_STDOUT_FD),
  autoClose: true,
  },
);
upstream.pipe(process.stdout);
`);
  await chmod(fakeRelay, 0o755);
  await writeFile(configPath, JSON.stringify({
    version: 5,
    upstreamExecutable: fakeCodex,
    relayExecutable: fakeRelay,
    relayArguments: ["relay-entry"],
    modelCatalogPath: catalogPath,
    relayStatePath: statePath,
    hostHealthPath: join(directory, "host-health.json"),
    hostToolsRequired: true,
    generation: "test-generation",
    router: {
      providerId: "codex_quota_router",
      baseUrl: "http://127.0.0.1:1234/token/v1/",
      tokenEnv: "CODEX_QUOTA_ROUTER_TOKEN",
      tokenHeader: "x-codex-quota-router-token",
      legacyProviderIds: ["deepseek"],
    },
  }));
  await execFileAsync("/usr/bin/xcrun", [
    "swiftc",
    "-target",
    `${process.arch === "x64" ? "x86_64" : "arm64"}-apple-macos12.0`,
    "-O",
    resolve("src/macos-codex-shim.swift"),
    "-o",
    shim,
  ]);
  const { stdout } = await execFileAsync(shim, ["app-server", "--listen", "stdio"], {
    env: {
      ...process.env,
      SHIM_RELAY_CAPTURE: relayCapturePath,
      SHIM_OFFICIAL_CAPTURE: officialCapturePath,
      CODEX_QUOTA_RELAY_CONFIG: configPath,
      CODEX_QUOTA_UPSTREAM_CODEX_CLI: fakeCodex,
      CODEX_QUOTA_PRIMARY_APP_SERVER: "1",
      CODEX_QUOTA_ROUTER_TOKEN: "router-secret",
    },
  });
  const relay = JSON.parse(await readFile(relayCapturePath, "utf8"));
  const official = JSON.parse(await readFile(officialCapturePath, "utf8"));
  await assert.rejects(readFile(statePath, "utf8"), { code: "ENOENT" },
    "shim 不再替 sidecar 直接写全局状态；应由真实 Relay 加锁认领");
  assert.match(stdout, /OFFICIAL_THROUGH_SIDECAR/);
  assert.deepEqual(relay.args, ["relay-entry", "app-server", "--listen", "stdio"]);
  assert.equal(relay.env.cliPath, fakeCodex);
  assert.equal(relay.env.relayConfig, configPath);
  assert.equal(relay.env.upstream, fakeCodex);
  assert.equal(relay.env.role, "app-server-relay");
  assert.equal(relay.env.sidecar, "1");
  assert.match(relay.env.upstreamStdinFd, /^\d+$/);
  assert.match(relay.env.upstreamStdoutFd, /^\d+$/);
  assert.notEqual(relay.env.upstreamStdinFd, relay.env.upstreamStdoutFd);
  assert.equal(relay.env.primaryAppServer, "1");
  assert.equal(relay.env.routerToken, "router-secret");
  assert.equal(relay.ppid, official.pid,
    "RPC 中继必须是官方 app-server 的旁路子进程，不能成为其父进程");
  assert.equal(official.ppid, process.pid,
    "shim 必须原位 exec 官方 app-server，保留桌面 → 官方进程的直接祖先关系");
  assert.equal(official.env.cliPath, fakeCodex);
  assert.equal(official.env.relayConfig, null);
  assert.equal(official.env.role, null);
  assert.equal(official.env.sidecar, null);
  assert.equal(official.env.upstreamStdinFd, null);
  assert.equal(official.env.upstreamStdoutFd, null);
  assert.equal(official.env.primaryAppServer, null);
  assert.equal(official.env.routerToken, "router-secret");
  assert.ok(official.args.includes(`model_catalog_json=${JSON.stringify(catalogPath)}`));
  assert.ok(official.args.includes('model_provider="openai"'));
  assert.ok(official.args.includes('openai_base_url="http://127.0.0.1:1234/token/v1/"'));

  const auxiliaryRelayCapture = join(directory, "relay-capture-auxiliary.json");
  const auxiliaryOfficialCapture = join(directory, "official-capture-auxiliary.json");
  const stateBeforeAuxiliary = `${JSON.stringify({ owner: "desktop-primary" })}\n`;
  await writeFile(statePath, stateBeforeAuxiliary);
  const auxiliaryEnv = {
    ...process.env,
    SHIM_RELAY_CAPTURE: auxiliaryRelayCapture,
    SHIM_OFFICIAL_CAPTURE: auxiliaryOfficialCapture,
    CODEX_QUOTA_RELAY_CONFIG: configPath,
    CODEX_QUOTA_UPSTREAM_CODEX_CLI: fakeCodex,
  };
  delete auxiliaryEnv.CODEX_QUOTA_PRIMARY_APP_SERVER;
  await execFileAsync(shim, ["app-server"], {
    env: auxiliaryEnv,
  });
  const auxiliaryRelay = JSON.parse(await readFile(auxiliaryRelayCapture, "utf8"));
  const auxiliaryOfficial = JSON.parse(await readFile(auxiliaryOfficialCapture, "utf8"));
  assert.equal(auxiliaryRelay.env.primaryAppServer, null);
  assert.equal(auxiliaryOfficial.env.primaryAppServer, null);
  assert.equal(await readFile(statePath, "utf8"), stateBeforeAuxiliary,
    "辅助 app-server 的 shim 不得覆盖桌面主中继状态");

  const noRouterRelayCapture = join(directory, "relay-capture-no-router.json");
  const noRouterOfficialCapture = join(directory, "official-capture-no-router.json");
  const noRouterConfig = {
    ...JSON.parse(await readFile(configPath, "utf8")),
    generation: "test-generation-no-router",
    router: null,
  };
  await writeFile(configPath, JSON.stringify(noRouterConfig));
  const noRouterEnv = {
    ...process.env,
    SHIM_RELAY_CAPTURE: noRouterRelayCapture,
    SHIM_OFFICIAL_CAPTURE: noRouterOfficialCapture,
    CODEX_QUOTA_RELAY_CONFIG: configPath,
    CODEX_QUOTA_UPSTREAM_CODEX_CLI: fakeCodex,
    CODEX_QUOTA_PRIMARY_APP_SERVER: "1",
  };
  delete noRouterEnv.CODEX_QUOTA_ROUTER_TOKEN;
  const noRouterRun = await execFileAsync(shim, ["app-server", "--listen", "stdio"], {
    env: noRouterEnv,
  });
  const noRouterRelay = JSON.parse(await readFile(noRouterRelayCapture, "utf8"));
  const noRouterOfficial = JSON.parse(await readFile(noRouterOfficialCapture, "utf8"));
  assert.match(noRouterRun.stdout, /OFFICIAL_THROUGH_SIDECAR/);
  assert.equal(noRouterRelay.ppid, noRouterOfficial.pid,
    "无 Router 的 shim 也必须启动观察 sidecar");
  assert.ok(noRouterOfficial.args.includes(`model_catalog_json=${JSON.stringify(catalogPath)}`));
  assert.equal(noRouterOfficial.args.some((argument) => argument.startsWith("model_provider=")), false);
  assert.equal(noRouterOfficial.env.routerToken, null);

  // Reproduce a plugin launching another shim with the desktop's inherited
  // primary flag. Both use the real Relay and exchange real stdio messages.
  const ownedStatePath = join(directory, "owned-state.json");
  const ownedHealthPath = join(directory, "owned-health.json");
  const emptyModelsPath = join(directory, "empty-models.json");
  await writeFile(emptyModelsPath, JSON.stringify({ platforms: [] }));
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  process.stdout.write(JSON.stringify({ id: message.id, result: { echo: message.params } }) + "\\n");
}
`);
  await writeFile(configPath, JSON.stringify({
    upstreamExecutable: fakeCodex,
    relayExecutable: process.execPath,
    relayArguments: [resolve("src/launcher.mjs")],
    extraModelSettingsPath: emptyModelsPath,
    relayStatePath: ownedStatePath,
    hostHealthPath: ownedHealthPath,
    hostToolsRequired: true,
    generation: "concurrent-sidecars",
  }));
  const launch = () => {
    const child = spawn(shim, ["app-server", "--listen", "stdio://"], {
      env: { PATH: process.env.PATH, HOME: directory, CODEX_HOME: directory,
        CODEX_QUOTA_RELAY_CONFIG: configPath, CODEX_QUOTA_PRIMARY_APP_SERVER: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const closed = new Promise(resolveClose => child.once("close", code => resolveClose(code)));
    t.after(async () => {
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      try { await closed; } finally { clearTimeout(timer); }
    });
    return { child, closed, stdout: () => stdout, stderr: () => stderr };
  };
  const primary = launch();
  const owner = await waitFor(async () => {
    const value = JSON.parse(await readFile(ownedStatePath, "utf8").catch(() => "null"));
    return value?.pid ? value : null;
  });
  assert.notEqual(owner.pid, primary.child.pid, "状态必须跟踪真实 sidecar");
  await waitFor(async () => JSON.parse(await readFile(ownedHealthPath, "utf8").catch(() => "null"))?.pid === owner.pid);
  const auxiliary = launch();
  auxiliary.child.stdin.write(JSON.stringify({ id: 1, method: "fixture/echo", params: "auxiliary" }) + "\n");
  await waitFor(() => auxiliary.stdout().includes('"echo":"auxiliary"'));
  assert.equal(JSON.parse(await readFile(ownedStatePath, "utf8")).pid, owner.pid,
    "继承 primary 标志的辅助 shim 不能覆盖仍存活的主中继");
  assert.equal(JSON.parse(await readFile(ownedHealthPath, "utf8")).pid, owner.pid);
  auxiliary.child.stdin.end();
  assert.equal(await auxiliary.closed, 0, auxiliary.stderr());
  assert.equal(JSON.parse(await readFile(ownedStatePath, "utf8")).pid, owner.pid,
    "辅助中继退出不能删除主中继状态");
  primary.child.stdin.write(JSON.stringify({ id: 2, method: "fixture/echo", params: "primary-still-works" }) + "\n");
  await waitFor(() => primary.stdout().includes('"echo":"primary-still-works"'));
  primary.child.stdin.end();
  assert.equal(await primary.closed, 0, primary.stderr());
  await assert.rejects(readFile(ownedStatePath, "utf8"), { code: "ENOENT" });
});
