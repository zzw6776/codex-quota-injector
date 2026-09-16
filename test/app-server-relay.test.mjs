import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { requestHostToolReload } from "../src/host-health.mjs";
import { MODEL_CAPABILITY_PROBE_VERSION } from "../src/model-capability-probe.mjs";
import { createTestNodeExecutable as createNodeAlias, useTempDir, waitFor } from "./helpers.mjs";

const FAKE_CODEX = `#!/usr/bin/env node
import readline from "node:readline";
import { appendFileSync } from "node:fs";
const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (process.env.RELAY_TEST_REQUEST_LOG) {
    appendFileSync(process.env.RELAY_TEST_REQUEST_LOG, JSON.stringify(message) + "\\n");
  }
  if (message.method === "config/mcpServer/reload") {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
    continue;
  }
  if (message.method === "mcpServerStatus/list") {
    process.stdout.write(JSON.stringify({
      id: message.id,
      result: {
        data: [{
          name: "codex_app",
          runtimeStatus: "connected",
          tools: Object.fromEntries([
            "list_threads", "read_thread", "list_projects", "get_usage_limits",
          ].map((name) => [name, { name }])),
        }],
      },
    }) + "\\n");
    continue;
  }
  if (message.method === "model/list") {
    process.stdout.write(JSON.stringify({
      id: message.id,
      result: { data: [{ id: "official", model: "official", displayName: "Official" }] },
    }) + "\\n");
    continue;
  }
  if (message.method === "thread/start" || message.method === "thread/fork") {
    const threadId = message.method === "thread/start" ? "thread-1" : "thread-2";
    process.stdout.write(JSON.stringify({
      id: message.id,
      result: {
        thread: {
          id: threadId,
          model: message.params.model,
          modelProvider: message.params.modelProvider,
        },
        received: message,
      },
    }) + "\\n");
    continue;
  }
  if (message.method === "turn/start") {
    process.stdout.write(JSON.stringify({
      id: message.id,
      result: { turn: { id: "turn-1", model: message.params.model }, received: message },
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      method: "turn/started",
      params: { threadId: message.params.threadId, turn: { id: "turn-1" } },
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: message.params.threadId,
        turnId: "turn-1",
        tokenUsage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
      },
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      method: "turn/completed",
      params: { threadId: message.params.threadId, turn: { id: "turn-1", status: "completed" } },
    }) + "\\n");
    continue;
  }
  process.stdout.write(JSON.stringify({
    id: message.id,
    result: {
      received: message,
      argv: process.argv.slice(2),
      env: {
        customKey: process.env.CODEX_QUOTA_MODEL_LOCAL_API_KEY ?? null,
        deepSeekKey: process.env.DEEPSEEK_API_KEY ?? null,
        routerToken: process.env.CODEX_QUOTA_ROUTER_TOKEN ?? null,
        relayConfig: process.env.CODEX_QUOTA_RELAY_CONFIG ?? null,
        forceCli: process.env.CODEX_APP_SERVER_FORCE_CLI ?? null,
      },
    },
  }) + "\\n");
}
`;

const FAILED_CODEX_APP = `#!/usr/bin/env node
import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({
      method: "mcpServer/startupStatus/updated",
      params: {
        threadId: null,
        name: "codex_app",
        status: "failed",
        error: { message: "missing code signing identity; Bearer fixture-secret" },
      },
    }) + "\\n");
  }
  if (message.id != null) {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
  }
}
`;

function runRelay({
  configPath,
  messages,
  env = {},
  sequential = false,
  closeDelayMs = 0,
  relayArguments = ["app-server"],
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["src/launcher.mjs", ...relayArguments], {
      cwd: join(import.meta.dirname, ".."),
      env: {
        ...process.env,
        CODEX_QUOTA_ROLE: "app-server-relay",
        CODEX_QUOTA_PRIMARY_APP_SERVER: "1",
        CODEX_QUOTA_RELAY_CONFIG: configPath,
        CODEX_APP_SERVER_FORCE_CLI: "1",
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stdoutPending = "";
    let stderr = "";
    let outboundIndex = 0;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`relay 测试超时；stderr=${stderr}`));
    }, 5_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!sequential) return;
      stdoutPending += chunk;
      for (;;) {
        const newline = stdoutPending.indexOf("\n");
        if (newline < 0) break;
        const line = stdoutPending.slice(0, newline);
        stdoutPending = stdoutPending.slice(newline + 1);
        let response;
        try { response = JSON.parse(line); } catch { continue; }
        if (response.method || response.id !== messages[outboundIndex]?.id) continue;
        outboundIndex += 1;
        if (outboundIndex < messages.length) {
          child.stdin.write(`${JSON.stringify(messages[outboundIndex])}\n`);
        } else {
          child.stdin.end();
        }
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`relay 退出异常 code=${code} signal=${signal}; stderr=${stderr}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
    if (sequential) {
      if (messages.length) child.stdin.write(`${JSON.stringify(messages[0])}\n`);
      else child.stdin.end();
    } else {
      const payload = messages.map((message) => `${JSON.stringify(message)}\n`).join("");
      if (closeDelayMs > 0) {
        child.stdin.write(payload);
        setTimeout(() => child.stdin.end(), closeDelayMs);
      } else {
        child.stdin.end(payload);
      }
    }
  });
}

function spawnRelay({ configPath, relayArguments = ["app-server"], env = {}, nodeArguments = [] }) {
  const child = spawn(process.execPath, [...nodeArguments, "src/launcher.mjs", ...relayArguments], {
    cwd: join(import.meta.dirname, ".."),
    env: {
      ...process.env,
      CODEX_QUOTA_ROLE: "app-server-relay",
      CODEX_QUOTA_PRIMARY_APP_SERVER: "1",
      CODEX_QUOTA_RELAY_CONFIG: configPath,
      CODEX_APP_SERVER_FORCE_CLI: "1",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`relay 退出异常 code=${code} signal=${signal}; stderr=${stderr}`));
    });
  });
  return { child, closed };
}

test("app-server relay 观察 codex_app 启动失败且不改写官方通知", async (t) => {
  const directory = await useTempDir(t, "codex-host-health-relay-");
  const fakeCodexPath = join(directory, "failed-codex-app.mjs");
  const upstreamExecutable = join(
    directory,
    process.platform === "win32" ? "node-upstream.exe" : "node-upstream",
  );
  const configPath = join(directory, "relay.json");
  const statePath = join(directory, "relay-state.json");
  const healthPath = join(directory, "host-health.json");
  await writeFile(fakeCodexPath, FAILED_CODEX_APP);
  await createNodeAlias(upstreamExecutable);
  await writeFile(configPath, JSON.stringify({
    version: process.platform === "darwin" ? 5 : 2,
    upstreamExecutable,
    relayStatePath: statePath,
    hostHealthPath: healthPath,
    hostToolsRequired: true,
    runtimeTarget: process.platform === "win32" ? "windows-native" : "macos-native",
    generation: "health-generation",
  }));
  const { stdout } = await runRelay({
    configPath,
    messages: [{ id: 1, method: "initialize", params: {} }],
    relayArguments: [fakeCodexPath, "app-server"],
  });
  const output = stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.ok(output.some((message) =>
    message.method === "mcpServer/startupStatus/updated" &&
    message.params?.name === "codex_app" && message.params?.status === "failed"));
  const health = JSON.parse(await readFile(healthPath, "utf8"));
  assert.equal(health.status, "degraded");
  assert.equal(health.code, "missing-code-signing-identity");
  assert.match(health.detail, /Bearer \[redacted\]/);
  assert.doesNotMatch(health.detail, /fixture-secret/);
});

test("并发 app-server 退出时保留存活 Relay，并在所有者退出后接管状态", async (t) => {
  const directory = await useTempDir(t, "codex-relay-ownership-");
  const fakeCodexPath = join(directory, "persistent-codex.mjs");
  const upstreamExecutable = join(
    directory,
    process.platform === "win32" ? "node-upstream.exe" : "node-upstream",
  );
  const configPath = join(directory, "relay.json");
  const statePath = join(directory, "relay-state.json");
  const healthPath = join(directory, "host-health.json");
  await writeFile(fakeCodexPath, `
import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.id != null) process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
}
`);
  await createNodeAlias(upstreamExecutable);
  await writeFile(configPath, JSON.stringify({
    version: process.platform === "darwin" ? 5 : 2,
    upstreamExecutable,
    relayStatePath: statePath,
    hostHealthPath: healthPath,
    hostToolsRequired: true,
    runtimeTarget: process.platform === "win32" ? "windows-native" : "macos-native",
    generation: "concurrent-generation",
  }));

  const first = spawnRelay({
    configPath,
    relayArguments: [fakeCodexPath, "app-server"],
  });
  t.after(async () => {
    if (first.child.exitCode == null) first.child.kill("SIGKILL");
    await first.closed.catch(() => {});
  });
  await waitFor(async () => {
    const state = JSON.parse(await readFile(statePath, "utf8").catch(() => "null"));
    return state?.pid === first.child.pid;
  });

  const second = spawnRelay({
    configPath,
    relayArguments: [fakeCodexPath, "app-server"],
  });
  t.after(async () => {
    if (second.child.exitCode == null) second.child.kill("SIGKILL");
    await second.closed.catch(() => {});
  });
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).pid, first.child.pid);

  first.child.stdin.end();
  await first.closed;
  const takeover = await waitFor(async () => {
    const state = JSON.parse(await readFile(statePath, "utf8").catch(() => "null"));
    return state?.pid === second.child.pid ? state : null;
  }, { timeoutMs: 4_000 });
  assert.equal(takeover.generation, "concurrent-generation");
  await waitFor(async () => {
    const health = JSON.parse(await readFile(healthPath, "utf8").catch(() => "null"));
    return health?.pid === second.child.pid;
  });

  second.child.stdin.end();
  await second.closed;
  await waitFor(async () => !await readFile(statePath, "utf8").then(() => true, () => false));
});

test("[LCH-04 TOOL-04] 重新加载并检查会重载官方 MCP 并以内置状态查询验证工具目录", async (t) => {
  const directory = await useTempDir(t, "codex-host-tools-reload-");
  const fakeCodexPath = join(directory, "fake-codex.mjs");
  const upstreamExecutable = join(
    directory,
    process.platform === "win32" ? "node-upstream.exe" : "node-upstream",
  );
  const configPath = join(directory, "relay.json");
  const statePath = join(directory, "relay-state.json");
  const healthPath = join(directory, "host-health.json");
  const requestLogPath = join(directory, "requests.jsonl");
  const generation = "host-tools-reload-generation";
  await writeFile(fakeCodexPath, FAKE_CODEX);
  await createNodeAlias(upstreamExecutable);
  await writeFile(configPath, JSON.stringify({
    upstreamExecutable,
    relayStatePath: statePath,
    hostHealthPath: healthPath,
    hostToolsRequired: true,
    runtimeTarget: process.platform === "win32" ? "windows-native" : "macos-native",
    generation,
  }));
  await requestHostToolReload({
    healthPath,
    generation,
    hostToolsRequired: true,
  }, { requestId: "reloadrequest01", now: 1_800_000_000_000 });

  // Reproduce CI startup taking longer than the old one-second stdin lifetime.
  const startupDelayPath = join(directory, "slow-relay-start.mjs");
  await writeFile(startupDelayPath, "await new Promise(resolve => setTimeout(resolve, 1250));\n");
  const { child, closed } = spawnRelay({
    configPath,
    env: { RELAY_TEST_REQUEST_LOG: requestLogPath },
    nodeArguments: ["--import", pathToFileURL(startupDelayPath).href],
    relayArguments: [fakeCodexPath, "app-server"],
  });
  t.after(async () => {
    if (child.exitCode == null) child.kill("SIGKILL");
    await closed.catch(() => {});
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stdin.write(`${JSON.stringify({ id: 1, method: "initialize", params: {} })}\n`);
  // Keep the client connected until reload and catalog verification actually finish.
  await waitFor(async () => {
    const health = JSON.parse(await readFile(healthPath, "utf8").catch(() => "null"));
    return health?.status === "ready" && health.toolsVerified === true;
  }, { timeoutMs: 10_000 });
  child.stdin.end();
  await closed;
  const requests = (await readFile(requestLogPath, "utf8"))
    .trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const reloadRequest = requests.find((message) => message.method === "config/mcpServer/reload");
  assert.ok(reloadRequest);
  assert.equal(Object.hasOwn(reloadRequest, "params"), false);
  const statusRequest = requests.find((message) => message.method === "mcpServerStatus/list");
  assert.deepEqual(statusRequest?.params, {});
  assert.doesNotMatch(stdout, /codex-quota-host-tools-/,
    "中继内部恢复请求和响应不能进入桌面客户端协议");
  const health = JSON.parse(await readFile(healthPath, "utf8"));
  assert.equal(health.status, "ready");
  assert.deepEqual(health.missingTools, []);
});

test("[LCH-04 TOOL-04] 任务 MCP 晚于空全局目录就绪时主动核验该任务且不重载", async t => {
  const directory = await useTempDir(t, "codex-thread-only-host-tools-");
  const upstream = join(directory, "thread-only.mjs");
  const executable = join(directory, process.platform === "win32" ? "upstream.exe" : "upstream");
  const configPath = join(directory, "relay.json");
  const healthPath = join(directory, "health.json");
  const logPath = join(directory, "requests.jsonl");
  await createNodeAlias(executable);
  await writeFile(upstream, `import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
const send=x=>console.log(JSON.stringify(x));
for await(const line of createInterface({input:process.stdin})) {
 const x=JSON.parse(line);appendFileSync(process.env.RELAY_TEST_REQUEST_LOG,JSON.stringify(x)+'\\n');
 if(x.method==='initialize') {send({id:x.id,result:{}});setTimeout(()=>send({method:'mcpServer/startupStatus/updated',params:{name:'codex_app',status:'ready',threadId:'ready-thread'}}),100);}
 else if(x.method==='mcpServerStatus/list') {
  const data=x.params?.threadId==='ready-thread'?[{name:'codex_app',runtimeStatus:'connected',tools:Object.fromEntries(['list_threads','read_thread','list_projects','get_usage_limits'].map(name=>[name,{name}]))}]:[];
  send({id:x.id,result:{data}});
 } else send({id:x.id,result:{}});
}`);
  await writeFile(configPath, JSON.stringify({upstreamExecutable: executable,
    relayStatePath: join(directory, "state.json"), hostHealthPath: healthPath,
    hostToolsRequired: true, generation: "thread-only-tools"}));
  const {child, closed} = spawnRelay({configPath,
    env: {RELAY_TEST_REQUEST_LOG: logPath},
    relayArguments: [upstream, "app-server"]});
  t.after(async () => {
    if (child.exitCode == null) child.kill("SIGKILL");
    await closed.catch(() => {});
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stdin.write(`${JSON.stringify({id: 1, method: "initialize", params: {}})}\n`);
  child.stdin.write(`${JSON.stringify({id: 2, method: "mcpServerStatus/list", params: {}})}\n`);
  await waitFor(async () => {
    const health = JSON.parse(await readFile(healthPath, "utf8").catch(() => "null"));
    return health?.status === "ready" && health.threadId === "ready-thread" && health.toolsVerified === true;
  }, {timeoutMs: 10_000});
  child.stdin.end();
  await closed;
  const health = JSON.parse(await readFile(healthPath, "utf8"));
  assert.equal(health.status, "ready");
  assert.equal(health.threadId, "ready-thread");
  assert.deepEqual(health.missingTools, []);
  const requests = (await readFile(logPath, "utf8")).trim().split(/\r?\n/).map(JSON.parse);
  assert.ok(requests.some(x=>x.method === "mcpServerStatus/list" && x.params?.threadId === "ready-thread"));
  assert.ok(requests.every(x=>x.method !== "config/mcpServer/reload" && x.method !== "turn/start"));
  assert.doesNotMatch(stdout, /codex-quota-host-tools-/);
  const responses = stdout.trim().split(/\r?\n/).map(JSON.parse);
  assert.deepEqual(responses.find(x=>x.id === 2).result, {data: []});
  assert.ok(responses.some(x=>x.method === "mcpServer/startupStatus/updated"));
});

test("辅助 app-server 即使没有继承 --listen 也不得覆盖桌面主中继的全局状态", async (t) => {
  const directory = await useTempDir(t, "codex-auxiliary-relay-state-");
  const fakeCodexPath = join(directory, "fake-codex.mjs");
  const upstreamExecutable = join(
    directory,
    process.platform === "win32" ? "node-upstream.exe" : "node-upstream",
  );
  const configPath = join(directory, "relay.json");
  const statePath = join(directory, "relay-state.json");
  const healthPath = join(directory, "host-health.json");
  const usagePath = join(directory, "usage.jsonl");
  const stateBefore = `${JSON.stringify({ owner: "desktop-primary" })}\n`;
  const healthBefore = `${JSON.stringify({ status: "ready", owner: "desktop-primary" })}\n`;
  const usageBefore = `${JSON.stringify({ type: "desktop-primary" })}\n`;
  await writeFile(fakeCodexPath, FAKE_CODEX);
  await createNodeAlias(upstreamExecutable);
  await writeFile(statePath, stateBefore);
  await writeFile(healthPath, healthBefore);
  await writeFile(usagePath, usageBefore);
  await writeFile(configPath, JSON.stringify({
    upstreamExecutable,
    relayStatePath: statePath,
    hostHealthPath: healthPath,
    hostToolsRequired: true,
    tokenUsageEventsPath: usagePath,
    generation: "desktop-primary-generation",
  }));

  await runRelay({
    configPath,
    messages: [{ id: 1, method: "initialize", params: {} }],
    env: { CODEX_QUOTA_PRIMARY_APP_SERVER: "" },
    relayArguments: [fakeCodexPath, "app-server"],
  });

  assert.equal(await readFile(statePath, "utf8"), stateBefore);
  assert.equal(await readFile(healthPath, "utf8"), healthBefore);
  assert.equal(await readFile(usagePath, "utf8"), usageBefore);
});

test("[platform:windows-native] Windows 独立中继在桌面端未转发环境变量时从固定配置执行官方 CLI", async (t) => {
  const directory = await useTempDir(t, "codex-windows-relay-fallback-");
  const appDataDir = join(directory, "appdata");
  const configDir = join(appDataDir, "Codex Quota Injector");
  const configPath = join(configDir, "app-server-relay-config.json");
  const upstreamExecutable = join(directory, process.platform === "win32" ? "node-upstream.exe" : "node-upstream");
  const inspectScript = join(directory, "inspect-env.mjs");
  await mkdir(configDir, { recursive: true });
  await createNodeAlias(upstreamExecutable);
  await writeFile(configPath, JSON.stringify({ upstreamExecutable }));
  await writeFile(inspectScript, `
process.stdout.write(JSON.stringify({
  argv: process.argv.slice(2),
  cliPath: process.env.CODEX_CLI_PATH ?? null,
  relayRole: process.env.CODEX_QUOTA_ROLE ?? null,
  relayConfig: process.env.CODEX_QUOTA_RELAY_CONFIG ?? null,
  windowsNative: process.env.CODEX_QUOTA_WINDOWS_NATIVE ?? null,
  forceCli: process.env.CODEX_APP_SERVER_FORCE_CLI ?? null,
}));
`);

  const env = {
    ...process.env,
    APPDATA: appDataDir,
    CODEX_QUOTA_ROLE: "stale-parent-value",
    CODEX_QUOTA_WINDOWS_NATIVE: "stale-parent-value",
    CODEX_APP_SERVER_FORCE_CLI: "1",
  };
  delete env.CODEX_QUOTA_RELAY_CONFIG;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "src/windows-relay-entry.mjs",
      inspectScript,
      "probe",
    ], {
      cwd: join(import.meta.dirname, ".."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Windows 独立中继测试失败 code=${code}; stderr=${stderr}`));
    });
  });

  const observed = JSON.parse(result.stdout);
  assert.deepEqual(observed.argv, ["probe"]);
  assert.equal(observed.cliPath, upstreamExecutable);
  assert.equal(observed.relayRole, null);
  assert.equal(observed.relayConfig, null);
  assert.equal(observed.windowsNative, null);
  assert.equal(observed.forceCli, null);
});

test("app-server relay 端到端保留原生请求并只改写扩展模型相关契约", async (t) => {
  const directory = await useTempDir(t, "codex-relay-e2e-");
  const fakeCodexPath = join(directory, "fake-codex.mjs");
  const upstreamExecutable = join(
    directory,
    process.platform === "win32" ? "fake-node.exe" : "fake-node",
  );
  const extraSettingsPath = join(directory, "extra-models.json");
  const catalogPath = join(directory, "catalog.json");
  const statePath = join(directory, "state.json");
  const usagePath = join(directory, "usage.jsonl");
  const configPath = join(directory, "relay.json");
  await writeFile(fakeCodexPath, FAKE_CODEX);
  await createNodeAlias(upstreamExecutable);
  await writeFile(extraSettingsPath, JSON.stringify({
    platforms: [{
      id: "local",
      name: "Local Provider",
      baseUrl: "http://127.0.0.1:65530/v1",
      apiKey: "custom-secret",
      enabled: true,
      models: [{
        id: "custom-text",
        displayName: "Custom Text",
        compatibility: {
          status: "verified",
          protocol: "responses",
          historyMode: "reasoning-text-only",
          toolContinuation: true,
          supportsImage: false,
          imageStatus: "unsupported",
          checkedAt: 1,
          probeVersion: 5,
          targetFingerprint: "fixture",
        },
        reasoningEfforts: ["low", "high"],
        defaultReasoningEffort: "low",
      }],
    }],
  }));
  await writeFile(catalogPath, JSON.stringify({ models: [{ slug: "official" }] }));
  await writeFile(configPath, JSON.stringify({
    upstreamExecutable,
    extraModelSettingsPath: extraSettingsPath,
    modelCatalogPath: catalogPath,
    relayStatePath: statePath,
    tokenUsageEventsPath: usagePath,
    generation: "test-generation",
  }));

  const messages = [
    { id: 1, method: "model/list", params: { includeHidden: false } },
    { id: 2, method: "config/read", params: { includeLayers: true } },
    { id: 3, method: "thread/start", params: { model: "custom-text", cwd: directory } },
    {
      id: 4,
      method: "turn/start",
      params: {
        threadId: "thread-1",
        model: "custom-text",
        effort: "high",
        summary: "detailed",
        serviceTier: "fast",
        input: [{ type: "text", text: "hello" }],
      },
    },
    {
      id: 5,
      method: "turn/start",
      params: {
        threadId: "thread-1",
        model: "custom-text",
        input: [{ type: "image", url: "data:image/png;base64,AA==" }],
      },
    },
  ];
  const { stdout } = await runRelay({
    configPath,
    messages,
    relayArguments: [fakeCodexPath, "app-server"],
  });
  const output = stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));

  const modelList = output.find((message) => message.id === 1);
  assert.deepEqual(modelList.result.data.map(({ model }) => model), ["official", "custom-text"]);
  const passthrough = output.find((message) => message.id === 2).result;
  assert.deepEqual(passthrough.received, messages[1]);
  assert.ok(passthrough.argv.includes("app-server"));
  assert.equal(passthrough.env.customKey, "custom-secret");
  assert.equal(passthrough.env.relayConfig, null);
  assert.equal(passthrough.env.forceCli, null);

  const threadRequest = output.find((message) => message.id === 3).result.received;
  assert.equal(threadRequest.params.modelProvider, "custom_local");
  assert.equal(threadRequest.params.config.disable_response_storage, true);
  assert.equal(threadRequest.params.config.model_reasoning_effort, "low");
  const turnRequest = output.find((message) => message.id === 4).result.received;
  assert.equal(turnRequest.params.effort, "high");
  assert.equal("summary" in turnRequest.params, false);
  assert.equal("serviceTier" in turnRequest.params, false);
  assert.equal(output.find((message) => message.id === 5).error.code, -32602);
  assert.match(output.find((message) => message.id === 5).error.message, /当前配置未启用图片输入/);

  const events = (await readFile(usagePath, "utf8")).trim()
    .split(/\r?\n/).map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.type === "turn-started" &&
    event.threadId === "thread-1" && event.model === "custom-text"));
  assert.ok(events.some((event) => event.type === "usage" &&
    event.tokenUsage.outputTokens === 3 && event.model === "custom-text"));
  assert.ok(events.some((event) => event.type === "turn-completed" &&
    event.status === "completed" && event.model === "custom-text"));
});

for (const compatibilityStatus of ["verified", "manual"]) test(`模型管理 ${compatibilityStatus} 配置在 Relay 后保持图片和供应商行为`, async (t) => {
  const directory = await useTempDir(t, "codex-relay-router-");
  const fakeCodexPath = join(directory, "fake-codex.mjs");
  const upstreamExecutable = join(
    directory,
    process.platform === "win32" ? "fake-node.exe" : "fake-node",
  );
  const extraSettingsPath = join(directory, "extra-models.json");
  const catalogPath = join(directory, "catalog.json");
  const configPath = join(directory, "relay.json");
  const routerBaseUrl = "http://127.0.0.1:43210/router-token/v1/";
  await writeFile(fakeCodexPath, FAKE_CODEX);
  await createNodeAlias(upstreamExecutable);
  await writeFile(extraSettingsPath, JSON.stringify({
    platforms: [{
      id: "d33f5ee0-0000-4000-8000-000000000001",
      preset: "deepseek",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com/",
      apiKey: "deepseek-secret-must-stay-in-router",
      enabled: true,
      models: [{
        id: "deepseek-flash",
        displayName: "DeepSeek Flash",
        compatibility: {
          status: compatibilityStatus,
          protocol: "responses",
          historyMode: "responses-full",
          supportsImage: true,
          probeVersion: compatibilityStatus === "verified" ? MODEL_CAPABILITY_PROBE_VERSION : 0,
          capabilities: {
            customTools: "bridged",
            namespaceTools: "bridged",
            nativeCustomTools: ["apply_patch"],
            parallelTools: "native",
            toolChoice: "native",
            reasoningToolChoice: "native",
            hostedTools: { web_search: "unsupported" },
          },
        },
        reasoningEfforts: ["low", "high", "max"],
        defaultReasoningEffort: "high",
      }],
    }],
  }));
  await writeFile(catalogPath, JSON.stringify({
    models: [{ slug: "official" }, { slug: "deepseek-v4-flash" }],
  }));
  await writeFile(configPath, JSON.stringify({
    upstreamExecutable,
    extraModelSettingsPath: extraSettingsPath,
    modelCatalogPath: catalogPath,
    router: {
      providerId: "codex_quota_router",
      baseUrl: routerBaseUrl,
      tokenEnv: "CODEX_QUOTA_ROUTER_TOKEN",
      tokenHeader: "x-codex-quota-router-token",
      legacyProviderIds: ["custom_d33f5ee0000040008000000000000001"],
    },
  }));

  const messages = [
    { id: 1, method: "config/read", params: { includeLayers: true } },
    { id: 2, method: "thread/start", params: { model: "deepseek-v4-flash", cwd: directory } },
    { id: 3, method: "thread/fork", params: { threadId: "thread-1", cwd: directory } },
    { id: 4, method: "turn/start", params: {
      threadId: "thread-1",
      model: "deepseek-v4-flash",
      effort: "low",
      input: [{ type: "image", url: "data:image/png;base64,AA==" }],
    } },
    { id: 5, method: "model/list", params: { includeHidden: false } },
  ];
  const { stdout } = await runRelay({
    configPath,
    messages,
    env: { CODEX_QUOTA_ROUTER_TOKEN: "router-secret" },
    sequential: true,
    relayArguments: [fakeCodexPath, "app-server"],
  });
  const output = stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const passthrough = output.find((message) => message.id === 1).result;
  const serializedArgs = JSON.stringify(passthrough.argv);
  assert.ok(passthrough.argv.includes(`model_provider=${JSON.stringify("openai")}`));
  assert.ok(passthrough.argv.includes(`openai_base_url=${JSON.stringify(routerBaseUrl)}`));
  assert.match(serializedArgs, /model_providers\.custom_d33f5ee0000040008000000000000001=/);
  assert.match(serializedArgs, /name=\\"DeepSeek\\"/);
  assert.match(serializedArgs, /supports_websockets=false/);
  assert.match(serializedArgs, /x-codex-quota-router-token/);
  assert.doesNotMatch(serializedArgs, /deepseek-secret-must-stay-in-router/);
  assert.equal(passthrough.env.routerToken, "router-secret");
  assert.equal(passthrough.env.deepSeekKey, null);
  assert.equal(passthrough.env.customKey, null);
  assert.equal(passthrough.env.relayConfig, null);
  assert.equal(passthrough.env.forceCli, null);

  const start = output.find((message) => message.id === 2).result.received;
  assert.equal(start.params.modelProvider, "custom_d33f5ee0000040008000000000000001");
  assert.equal(start.params.model, "deepseek-flash");
  assert.equal(start.params.config.disable_response_storage, true);
  assert.equal("model_reasoning_summary" in start.params.config, false);
  assert.equal("service_tier" in start.params.config, false);
  const fork = output.find((message) => message.id === 3).result.received;
  assert.equal(fork.params.modelProvider, "custom_d33f5ee0000040008000000000000001");
  assert.equal(fork.params.model, "deepseek-flash");
  const imageTurn = output.find((message) => message.id === 4).result.received;
  assert.equal(imageTurn.params.model, "deepseek-flash");
  assert.equal(imageTurn.params.input[0].type, "image");
  assert.deepEqual(
    output.find((message) => message.id === 5).result.data.map(({ model }) => model),
    ["official", "deepseek-flash"],
  );
});

test("模型管理 DeepSeek 预设在直接中继中接管历史模型 ID", async (t) => {
  const directory = await useTempDir(t, "codex-relay-deepseek-preset-");
  const fakeCodexPath = join(directory, "fake-codex.mjs");
  const upstreamExecutable = join(
    directory,
    process.platform === "win32" ? "fake-node.exe" : "fake-node",
  );
  const extraSettingsPath = join(directory, "extra-models.json");
  const catalogPath = join(directory, "catalog.json");
  const configPath = join(directory, "relay.json");
  await writeFile(fakeCodexPath, FAKE_CODEX);
  await createNodeAlias(upstreamExecutable);
  await writeFile(extraSettingsPath, JSON.stringify({
    platforms: [{
      id: "d33f5ee0-0000-4000-8000-000000000001",
      preset: "deepseek",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com/",
      apiKey: "preset-secret",
      enabled: true,
      models: [{
        id: "deepseek-flash",
        displayName: "DeepSeek Flash",
        compatibility: {
          status: "verified",
          protocol: "responses",
          historyMode: "reasoning-text-only",
          supportsImage: true,
          probeVersion: MODEL_CAPABILITY_PROBE_VERSION,
          routes: {
            default: "responses",
            imageInput: "chat",
          },
        },
        reasoningEfforts: ["low", "high", "max"],
        defaultReasoningEffort: "high",
      }, {
        id: "deepseek-v4-pro",
        displayName: "DeepSeek Pro",
        compatibility: {
          status: "verified",
          protocol: "responses",
          historyMode: "responses-full",
          supportsImage: false,
          probeVersion: MODEL_CAPABILITY_PROBE_VERSION,
          capabilities: {
            customTools: "bridged",
            namespaceTools: "bridged",
            nativeCustomTools: ["apply_patch"],
            parallelTools: "native",
            toolChoice: "native",
            reasoningToolChoice: "native",
            hostedTools: { web_search: "unsupported" },
          },
        },
        reasoningEfforts: ["low", "high", "max"],
        defaultReasoningEffort: "high",
      }],
    }],
  }));
  await writeFile(catalogPath, JSON.stringify({
    models: [{ slug: "official" }, { slug: "deepseek-v4-pro" }],
  }));
  await writeFile(configPath, JSON.stringify({
    upstreamExecutable,
    extraModelSettingsPath: extraSettingsPath,
    modelCatalogPath: catalogPath,
  }));

  const { stdout } = await runRelay({
    configPath,
    sequential: true,
    relayArguments: [fakeCodexPath, "app-server"],
    messages: [
      { id: 1, method: "thread/start", params: {
        model: "deepseek-v4-pro",
        cwd: directory,
      } },
      { id: 2, method: "turn/start", params: {
        threadId: "thread-1",
        model: "deepseek-v4-flash-vision-exp",
        input: [{ type: "image", url: "data:image/png;base64,AA==" }],
      } },
      { id: 3, method: "model/list", params: { includeHidden: false } },
      { id: 4, method: "debug/args", params: {} },
    ],
  });
  const output = stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const start = output.find((message) => message.id === 1).result.received;
  assert.match(start.params.modelProvider, /^custom_/);
  assert.equal(start.params.model, "deepseek-v4-pro");
  const turn = output.find((message) => message.id === 2).result.received;
  assert.equal(turn.params.model, "deepseek-flash");
  assert.equal(turn.params.input[0].type, "image");
  assert.deepEqual(
    output.find((message) => message.id === 3).result.data.map(({ model }) => model),
    ["official", "deepseek-flash", "deepseek-v4-pro"],
  );
  const serializedArgs = output.find((message) => message.id === 4).result.argv.join(" ");
  assert.match(serializedArgs, /model_providers\.custom_[^ ]+base_url="http:\/\/127\.0\.0\.1:/);
  assert.doesNotMatch(serializedArgs, /base_url="https:\/\/api\.deepseek\.com\//);
});

test("[platform:windows-native] Windows relay 在没有第三方模型时于原生环境启动官方流量观察 Router", async (t) => {
  const directory = await useTempDir(t, "codex-relay-official-observer-");
  const fakeCodexPath = join(directory, "fake-codex.mjs");
  const upstreamExecutable = join(
    directory,
    process.platform === "win32" ? "fake-node.exe" : "fake-node",
  );
  const extraSettingsPath = join(directory, "extra-models.json");
  const catalogPath = join(directory, "catalog.json");
  const usagePath = join(directory, "usage.jsonl");
  const configPath = join(directory, "relay.json");
  await writeFile(fakeCodexPath, FAKE_CODEX);
  await createNodeAlias(upstreamExecutable);
  await writeFile(extraSettingsPath, JSON.stringify({ platforms: [] }));
  await writeFile(catalogPath, JSON.stringify({ models: [{ slug: "official" }] }));
  await writeFile(configPath, JSON.stringify({
    version: 2,
    upstreamExecutable,
    extraModelSettingsPath: extraSettingsPath,
    modelCatalogPath: catalogPath,
    tokenUsageEventsPath: usagePath,
    officialAuthMode: "oauth",
    observeModelTraffic: true,
  }));

  const { stdout } = await runRelay({
    configPath,
    messages: [{ id: 1, method: "config/read", params: { includeLayers: true } }],
    relayArguments: [fakeCodexPath, "app-server"],
  });
  const passthrough = JSON.parse(stdout.trim()).result;
  const serializedArgs = JSON.stringify(passthrough.argv);
  assert.ok(passthrough.argv.includes(`model_provider=${JSON.stringify("openai")}`));
  assert.match(serializedArgs, /openai_base_url=.*127\.0\.0\.1/);
  assert.match(serializedArgs, /x-codex-quota-router-token/);
  assert.match(passthrough.env.routerToken, /^[A-Za-z0-9_-]{32,}$/);
  assert.equal(passthrough.env.deepSeekKey, null);
  assert.equal(passthrough.env.customKey, null);
});
