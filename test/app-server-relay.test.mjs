import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { useTempDir } from "./helpers.mjs";

const FAKE_CODEX = `#!/usr/bin/env node
import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
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

function runRelay({ configPath, messages, env = {}, sequential = false }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["src/launcher.mjs", "app-server"], {
      cwd: join(import.meta.dirname, ".."),
      env: {
        ...process.env,
        CODEX_QUOTA_ROLE: "app-server-relay",
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
      child.stdin.end(messages.map((message) => `${JSON.stringify(message)}\n`).join(""));
    }
  });
}

test("app-server relay 端到端保留原生请求并只改写扩展模型相关契约", {
  skip: process.platform === "win32" ? "Windows 的测试假 CLI 需要原生 exe" : false,
}, async (t) => {
  const directory = await useTempDir(t, "codex-relay-e2e-");
  const fakeCodexPath = join(directory, "fake-codex.mjs");
  const extraSettingsPath = join(directory, "extra-models.json");
  const catalogPath = join(directory, "catalog.json");
  const statePath = join(directory, "state.json");
  const usagePath = join(directory, "usage.jsonl");
  const configPath = join(directory, "relay.json");
  await writeFile(fakeCodexPath, FAKE_CODEX);
  await chmod(fakeCodexPath, 0o700);
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
        supportsImage: false,
        chatCompatibility: false,
        reasoningEfforts: ["low", "high"],
        defaultReasoningEffort: "low",
      }],
    }],
  }));
  await writeFile(catalogPath, JSON.stringify({ models: [{ slug: "official" }] }));
  await writeFile(configPath, JSON.stringify({
    upstreamExecutable: fakeCodexPath,
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
  const { stdout } = await runRelay({ configPath, messages });
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
  assert.match(output.find((message) => message.id === 5).error.message, /未配置图片输入能力/);

  const events = (await readFile(usagePath, "utf8")).trim()
    .split(/\r?\n/).map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.type === "turn-started" &&
    event.threadId === "thread-1" && event.model === "custom-text"));
  assert.ok(events.some((event) => event.type === "usage" &&
    event.tokenUsage.outputTokens === 3 && event.model === "custom-text"));
  assert.ok(events.some((event) => event.type === "turn-completed" &&
    event.status === "completed" && event.model === "custom-text"));
});

test("app-server relay 在 macOS Router 后保持第三方供应商并隔离上游凭据", {
  skip: process.platform === "win32" ? "Windows 的测试假 CLI 需要原生 exe" : false,
}, async (t) => {
  const directory = await useTempDir(t, "codex-relay-router-");
  const fakeCodexPath = join(directory, "fake-codex.mjs");
  const providerSettingsPath = join(directory, "provider-settings.json");
  const extraSettingsPath = join(directory, "extra-models.json");
  const catalogPath = join(directory, "catalog.json");
  const configPath = join(directory, "relay.json");
  const routerBaseUrl = "http://127.0.0.1:43210/router-token/v1/";
  await writeFile(fakeCodexPath, FAKE_CODEX);
  await chmod(fakeCodexPath, 0o700);
  await writeFile(providerSettingsPath, JSON.stringify({
    enabled: true,
    apiKey: "deepseek-secret-must-stay-in-router",
  }));
  await writeFile(extraSettingsPath, JSON.stringify({
    platforms: [{
      id: "local",
      name: "Local Provider",
      baseUrl: "https://vendor.invalid/v1/",
      apiKey: "custom-secret-must-stay-in-router",
      enabled: true,
      models: [{
        id: "custom-text",
        displayName: "Custom Text",
        supportsImage: false,
        chatCompatibility: false,
        reasoningEfforts: ["low"],
        defaultReasoningEffort: "low",
      }],
    }],
  }));
  await writeFile(catalogPath, JSON.stringify({
    models: [{ slug: "official" }, { slug: "deepseek-v4-flash" }, { slug: "custom-text" }],
  }));
  await writeFile(configPath, JSON.stringify({
    upstreamExecutable: fakeCodexPath,
    providerSettingsPath,
    extraModelSettingsPath: extraSettingsPath,
    modelCatalogPath: catalogPath,
    router: {
      providerId: "codex_quota_router",
      baseUrl: routerBaseUrl,
      tokenEnv: "CODEX_QUOTA_ROUTER_TOKEN",
      tokenHeader: "x-codex-quota-router-token",
      legacyProviderIds: ["deepseek", "custom_local"],
    },
  }));

  const messages = [
    { id: 1, method: "config/read", params: { includeLayers: true } },
    { id: 2, method: "thread/start", params: { model: "deepseek-v4-flash", cwd: directory } },
    { id: 3, method: "thread/fork", params: { threadId: "thread-1", cwd: directory } },
  ];
  const { stdout } = await runRelay({
    configPath,
    messages,
    env: { CODEX_QUOTA_ROUTER_TOKEN: "router-secret" },
    sequential: true,
  });
  const output = stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const passthrough = output.find((message) => message.id === 1).result;
  const serializedArgs = JSON.stringify(passthrough.argv);
  assert.ok(passthrough.argv.includes(`model_provider=${JSON.stringify("openai")}`));
  assert.ok(passthrough.argv.includes(`openai_base_url=${JSON.stringify(routerBaseUrl)}`));
  assert.match(serializedArgs, /model_providers\.deepseek=/);
  assert.match(serializedArgs, /model_providers\.custom_local=/);
  assert.match(serializedArgs, /name=\\"DeepSeek\\"/);
  assert.match(serializedArgs, /supports_websockets=false/);
  assert.match(serializedArgs, /x-codex-quota-router-token/);
  assert.doesNotMatch(serializedArgs, /vendor\.invalid|must-stay-in-router/);
  assert.equal(passthrough.env.routerToken, "router-secret");
  assert.equal(passthrough.env.deepSeekKey, null);
  assert.equal(passthrough.env.customKey, null);
  assert.equal(passthrough.env.relayConfig, null);
  assert.equal(passthrough.env.forceCli, null);

  const start = output.find((message) => message.id === 2).result.received;
  assert.equal(start.params.modelProvider, "deepseek");
  assert.equal(start.params.config.model_reasoning_summary, "none");
  assert.equal(start.params.config.service_tier, null);
  const fork = output.find((message) => message.id === 3).result.received;
  assert.equal(fork.params.modelProvider, "deepseek");
  assert.equal(fork.params.model, "deepseek-v4-flash");
});
