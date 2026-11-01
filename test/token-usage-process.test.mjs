import assert from "node:assert/strict";
import { appendFile, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

test("Token 统计进程空闲退出，无变化不重启，追加事件后按需恢复", async (t) => {
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

  const client = new TokenUsageProcessClient({
    codexHome,
    dataDir,
    discoveryIntervalMs: 0,
    idleTimeoutMs: 30,
    fullDiscoveryIntervalMs: 60_000,
    eventWatchDebounceMs: 5,
    pricingManager: inertPricingManager(),
  });
  t.after(async () => {
    await client.close();
    await client.flush();
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
  const client = new TokenUsageProcessClient({
    codexHome,
    dataDir,
    maxViewTurns: 1,
    idleTimeoutMs: 5_000,
    eventWatchDebounceMs: 5,
    watchSources: false,
    pricingManager: inertPricingManager(),
  });
  t.after(async () => {
    await client.close();
    await client.flush();
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

test("全量发现失败不会推进成功时间，下一次兜底刷新立即重试", async (t) => {
  const codexHome = await useTempDir(t, "codex-usage-discovery-home-");
  const dataDir = await useTempDir(t, "codex-usage-discovery-data-");
  const sessionsPath = join(codexHome, "sessions");
  await writeFile(sessionsPath, "not-a-directory");
  const client = new TokenUsageProcessClient({
    codexHome,
    dataDir,
    idleTimeoutMs: 5_000,
    fullDiscoveryIntervalMs: 60_000,
    watchSources: false,
    pricingManager: inertPricingManager(),
  });
  t.after(async () => {
    await client.close();
    await client.flush();
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

  const client = new TokenUsageProcessClient({
    codexHome,
    dataDir,
    idleTimeoutMs: 5_000,
    fullDiscoveryIntervalMs: 60_000,
    watchSources: false,
    pricingManager: inertPricingManager(),
  });
  t.after(async () => {
    await client.close();
    await client.flush();
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
