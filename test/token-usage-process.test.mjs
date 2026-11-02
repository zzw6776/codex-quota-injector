import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, appendFile, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  TokenUsageProcessClient,
  tokenUsageServiceCommand,
} from "../src/token-usage/process-client.mjs";
import { useTempDir, waitFor } from "./helpers.mjs";
import { event, protocolUsage, turnContext, writeRollout } from "./token-usage/support.mjs";

function inertPricingManager() {
  return {
    async initialize() {},
    onChange() { return () => {}; },
  };
}

async function appendEvents(dataDir, events) {
  await appendFile(
    join(dataDir, "token-usage-events.jsonl"),
    `${events.map((value) => JSON.stringify(value)).join("\n")}\n`,
  );
}

function controlledUsageService() {
  const requests = [];
  const child = new EventEmitter();
  child.pid = 43210;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin.on("data", (chunk) => {
    for (const line of String(chunk).split("\n").filter(Boolean)) {
      const request = JSON.parse(line);
      requests.push(request);
      if (request.action === "flush") {
        child.stdout.write(`${JSON.stringify({
          protocol: 1,
          type: "response",
          id: request.id,
          ok: true,
        })}\n`);
      }
    }
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    queueMicrotask(() => child.emit("close", 0, null));
  };
  child.stdin.on("finish", close);
  child.kill = close;
  const respond = (request, turnId) => {
    const turn = turnId ? {
      turnId,
      threadId: request.viewThreadId ?? "thread-global",
      totalTokens: 15,
      updatedAt: Date.now(),
    } : null;
    child.stdout.write(`${JSON.stringify({
      protocol: 1,
      type: "response",
      id: request.id,
      ok: true,
      fullDiscoveryCompleted: Boolean(request.forceDiscovery),
      delta: {
        status: "ready",
        error: null,
        turnIds: turn ? [turnId] : [],
        turnUpdates: turn ? [{ value: turn, signature: `signature-${turnId}` }] : [],
        removedTurnIds: [],
        stateUpdates: [],
        removedStateIds: [],
        sourceSnapshot: {
          event: { path: "/missing/token-usage-events.jsonl", exists: false, size: 0,
            mtimeMs: 0 },
          rollouts: [],
        },
      },
    })}\n`);
  };
  return { child, requests, respond };
}

test("Token 统计进程空闲退出，无变化不重启，追加事件后按需恢复", async (t) => {
  let client;
  t.after(async () => {
    await client?.close();
    await client?.flush();
  });
  const codexHome = await useTempDir(t, "codex-usage-process-home-");
  const dataDir = await useTempDir(t, "codex-usage-process-data-");
  const firstUsage = protocolUsage({ input: 10, output: 5 });
  const stateEvent = event("state", "turn-state-observed", "thread-process", null, {
    model: "gpt-6-luna", byteLength: 321,
  });
  await writeFile(join(dataDir, "token-usage-events.jsonl"), [
    event("start", "turn-started", "thread-process", "turn-process", {
      model: "gpt-6-luna",
    }),
    stateEvent,
    event("usage-1", "usage", "thread-process", "turn-process", {
      responseId: "response-1",
      tokenUsage: { last: firstUsage, total: firstUsage },
    }),
  ].map((value) => JSON.stringify(value)).join("\n") + "\n");

  client = new TokenUsageProcessClient({
    codexHome,
    dataDir,
    discoveryIntervalMs: 0,
    idleTimeoutMs: 30,
    fullDiscoveryIntervalMs: 60_000,
    eventWatchDebounceMs: 5,
    pricingManager: inertPricingManager(),
  });
  const initial = await client.initialize();
  assert.equal(initial.status, "ready");
  assert.equal(initial.turns[0].totalTokens, 15);
  assert.deepEqual(client.getTurnStateViewModel("thread-process"), {
    byteLength: 321,
    model: "gpt-6-luna",
    observedAt: stateEvent.recordedAt,
  });
  assert.ok(client.servicePid);
  await waitFor(() => client.servicePid == null, { timeoutMs: 5_000 });

  assert.strictEqual(await client.refresh(), initial);
  assert.equal(client.servicePid, null, "源文件未变化时不周期性拉起统计进程");

  const secondUsage = protocolUsage({ input: 20, output: 10 });
  await appendEvents(dataDir, [
    event("usage-2", "usage", "thread-process", "turn-process", {
      responseId: "response-2",
      tokenUsage: { last: firstUsage, total: secondUsage },
    }),
  ]);
  const updated = await waitFor(() => {
    const view = client.getViewModel();
    return view.turns[0]?.totalTokens === 30 ? view : null;
  }, { timeoutMs: 5_000 });
  assert.notStrictEqual(updated, initial);
  assert.equal(updated.turns[0].totalTokens, 30);
  await waitFor(() => client.servicePid == null, { timeoutMs: 5_000 });
});

test("切换页面会话后短生命周期进程返回该会话的窗口外摘要", async (t) => {
  let client;
  t.after(async () => {
    await client?.close();
    await client?.flush();
  });
  const codexHome = await useTempDir(t, "codex-usage-focus-home-");
  const dataDir = await useTempDir(t, "codex-usage-focus-data-");
  const usage = protocolUsage({ input: 10, output: 5 });
  const events = [];
  for (const [index, threadId] of ["thread-old", "thread-new"].entries()) {
    const turnId = `turn-${index}`;
    events.push(
      event(`start-${index}`, "turn-started", threadId, turnId, { model: "gpt-6-luna" }),
      event(`usage-${index}`, "usage", threadId, turnId, {
        responseId: `response-${index}`,
        tokenUsage: { last: usage, total: usage },
      }),
      event(`complete-${index}`, "turn-completed", threadId, turnId, { status: "completed" }),
    );
  }
  await writeFile(
    join(dataDir, "token-usage-events.jsonl"),
    `${events.map((value) => JSON.stringify(value)).join("\n")}\n`,
  );
  client = new TokenUsageProcessClient({
    codexHome,
    dataDir,
    maxViewTurns: 1,
    idleTimeoutMs: 5_000,
    eventWatchDebounceMs: 5,
    watchSources: false,
    pricingManager: inertPricingManager(),
  });
  const initializing = client.initialize();
  assert.equal(client.setViewThread("thread-old"), true);
  assert.ok(client.scheduledRefresh, "初始化期间切换会话必须排队补一次刷新");
  const preinitialized = await initializing;
  assert.deepEqual(preinitialized.turns.map((turn) => turn.turnId), ["turn-0", "turn-1"]);
  assert.equal(client.setViewThread(null), true);
  const initial = await waitFor(() => {
    const view = client.getViewModel();
    return view.turns.length === 1 && view.turns[0]?.turnId === "turn-1" ? view : null;
  }, { timeoutMs: 5_000 });
  assert.deepEqual(initial.turns.map((turn) => turn.turnId), ["turn-1"]);
  assert.equal(client.setViewThread("thread-old"), true);
  assert.equal(client.setViewThread("thread-old"), false);
  const focused = await waitFor(() => {
    const view = client.getViewModel();
    return view.turns.some((turn) => turn.turnId === "turn-0") ? view : null;
  }, { timeoutMs: 5_000 });
  assert.deepEqual(focused.turns.map((turn) => turn.turnId), ["turn-0", "turn-1"]);
  assert.equal(focused.turns[0].detailsAvailable, false);
});

test("切回已访问会话立即复用轻量视图且不重新拉起统计进程", async (t) => {
  let client;
  t.after(async () => {
    await client?.close();
    await client?.flush();
  });
  const codexHome = await useTempDir(t, "codex-usage-view-cache-home-");
  const dataDir = await useTempDir(t, "codex-usage-view-cache-data-");
  const usage = protocolUsage({ input: 10, output: 5 });
  const events = [];
  for (const [index, threadId] of ["thread-old", "thread-new"].entries()) {
    const turnId = `turn-cache-${index}`;
    events.push(
      event(`start-cache-${index}`, "turn-started", threadId, turnId, {
        model: "gpt-6-luna",
      }),
      event(`usage-cache-${index}`, "usage", threadId, turnId, {
        responseId: `response-cache-${index}`,
        tokenUsage: { last: usage, total: usage },
      }),
      event(`complete-cache-${index}`, "turn-completed", threadId, turnId, {
        status: "completed",
      }),
    );
  }
  await writeFile(
    join(dataDir, "token-usage-events.jsonl"),
    `${events.map((value) => JSON.stringify(value)).join("\n")}\n`,
  );
  client = new TokenUsageProcessClient({
    codexHome,
    dataDir,
    maxViewTurns: 1,
    idleTimeoutMs: 30,
    eventWatchDebounceMs: 5,
    fullDiscoveryIntervalMs: 60_000,
    watchSources: false,
    pricingManager: inertPricingManager(),
  });
  assert.deepEqual(
    (await client.initialize()).turns.map((turn) => turn.turnId),
    ["turn-cache-1"],
  );
  assert.equal(client.setViewThread("thread-old"), true);
  await waitFor(() => client.getViewModel().turns.some((turn) =>
    turn.turnId === "turn-cache-0"), { timeoutMs: 5_000 });
  assert.equal(client.setViewThread(null), true);
  assert.deepEqual(client.getViewModel().turns.map((turn) => turn.turnId), ["turn-cache-1"]);
  await waitFor(() => client.servicePid == null, { timeoutMs: 5_000 });

  assert.equal(client.setViewThread("thread-old"), true);
  assert.deepEqual(
    client.getViewModel().turns.map((turn) => turn.turnId),
    ["turn-cache-0", "turn-cache-1"],
    "切换调用返回前就应恢复已访问会话",
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(client.servicePid, null, "源文件未变化时后台校验不应重新拉起进程");
});

test("快速切换会话时迟到的旧视图不能覆盖当前会话", async (t) => {
  const service = controlledUsageService();
  const client = new TokenUsageProcessClient({
    codexHome: "/missing/codex-home",
    dataDir: "/missing/injector-data",
    idleTimeoutMs: 5_000,
    eventWatchDebounceMs: 5,
    fullDiscoveryIntervalMs: 60_000,
    watchSources: false,
    spawnImpl: () => service.child,
    pricingManager: inertPricingManager(),
  });
  t.after(async () => {
    await client.close();
    await client.flush();
  });

  const initializing = client.initialize();
  const initializeRequest = await waitFor(() => service.requests[0], { timeoutMs: 1_000 });
  service.respond(initializeRequest, "turn-global");
  await initializing;

  client.setViewThread("thread-a");
  const requestA = await waitFor(() => service.requests[1], { timeoutMs: 1_000 });
  assert.equal(requestA.viewThreadId, "thread-a");
  client.setViewThread("thread-b");
  service.respond(requestA, "turn-a");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    client.getViewModel().turns.some((turn) => turn.turnId === "turn-a"),
    false,
    "thread-a 的迟到响应不能发布到 thread-b",
  );

  const requestB = await waitFor(() => service.requests[2], { timeoutMs: 1_000 });
  assert.equal(requestB.viewThreadId, "thread-b");
  service.respond(requestB, "turn-b");
  await waitFor(() => client.getViewModel().turns[0]?.turnId === "turn-b", {
    timeoutMs: 1_000,
  });
});

test("全量发现失败不会推进成功时间，下一次兜底刷新立即重试", async (t) => {
  let client;
  let dataDir;
  // after hooks run in registration order: retire the writer before either
  // useTempDir hook removes its data or rollout directory.
  t.after(async () => {
    if (!client) return;
    const directoryExists = await access(dataDir).then(() => true, () => false);
    await client.close();
    await client.flush();
    assert.equal(directoryExists, true, "关闭统计子进程前不得删除临时数据目录");
    assert.equal(client.servicePid, null, "删除临时目录前统计子进程必须已退出");
  });
  const codexHome = await useTempDir(t, "codex-usage-discovery-home-");
  dataDir = await useTempDir(t, "codex-usage-discovery-data-");
  const sessionsPath = join(codexHome, "sessions");
  await writeFile(sessionsPath, "not-a-directory");
  client = new TokenUsageProcessClient({
    codexHome,
    dataDir,
    idleTimeoutMs: 5_000,
    fullDiscoveryIntervalMs: 60_000,
    watchSources: false,
    pricingManager: inertPricingManager(),
  });
  const failed = await client.initialize();
  assert.equal(failed.status, "error");
  assert.match(failed.error, /ENOTDIR/);
  assert.equal(client.lastFullDiscoveryAt, 0);

  await rm(sessionsPath);
  await mkdir(sessionsPath);
  const recovered = await client.refresh();
  assert.equal(recovered.status, "ready");
  assert.equal(recovered.error, null);
  assert.ok(client.lastFullDiscoveryAt > 0);
});

test("短生命周期统计服务在响应前完成已排队的未知模型补全", async (t) => {
  let client;
  t.after(async () => {
    await client?.close();
    await client?.flush();
  });
  const codexHome = await useTempDir(t, "codex-usage-reconcile-home-");
  const dataDir = await useTempDir(t, "codex-usage-reconcile-data-");
  const targetThreadId = "11111111-1111-4111-8111-111111111111";
  const decoyThreadId = "22222222-2222-4222-8222-222222222222";
  const targetTurnId = "turn-delayed-model";
  const targetPath = await writeRollout(codexHome, targetThreadId, [
    turnContext(targetTurnId, "gpt-6-astra"),
  ]);
  const decoyPath = await writeRollout(codexHome, decoyThreadId, [
    turnContext("turn-recent", "gpt-6-luna"),
  ]);
  const now = new Date();
  const stale = new Date(now.getTime() - 6 * 60 * 1_000);
  await utimes(targetPath, stale, stale);
  await utimes(decoyPath, now, now);

  client = new TokenUsageProcessClient({
    codexHome,
    dataDir,
    idleTimeoutMs: 5_000,
    fullDiscoveryIntervalMs: 60_000,
    watchSources: false,
    pricingManager: inertPricingManager(),
  });
  assert.equal((await client.initialize()).status, "ready");
  const servicePid = client.servicePid;
  const usage = protocolUsage({ input: 12, output: 4 });
  await appendEvents(dataDir, [
    event("usage-delayed-model", "usage", targetThreadId, targetTurnId, {
      responseId: "response-delayed-model",
      tokenUsage: { last: usage, total: usage },
    }),
  ]);
  const updated = await client.refresh({ forceProcess: true });
  assert.equal(client.servicePid, servicePid, "测试必须复用仍处于空闲窗口内的统计服务");
  const turn = updated.turns.find((value) => value.turnId === targetTurnId);
  assert.equal(turn?.model, "gpt-6-astra");
});

test("Token 统计服务在开发版复用 launcher，正式包复用当前 SEA", () => {
  assert.deepEqual(tokenUsageServiceCommand({
    sea: false,
    executable: "/runtime/node",
    launcherPath: "/project/src/launcher.mjs",
  }), {
    command: "/runtime/node",
    args: ["/project/src/launcher.mjs"],
  });
  assert.deepEqual(tokenUsageServiceCommand({
    sea: true,
    executable: "/app/Codex Quota Injector Worker",
    launcherPath: "/unused/launcher.mjs",
  }), {
    command: "/app/Codex Quota Injector Worker",
    args: [],
  });
});
