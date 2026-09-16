import assert from "node:assert/strict";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { GENERATION_METRICS_VERSION } from "../src/relay-contract.mjs";
import { TokenUsageManager } from "../src/token-usage.mjs";
import { pricing, event, rolloutUsage, turnContext, tokenUsageRecord, createManager, protocolUsage, tokenCount, taskComplete } from "./token-usage/support.mjs";

test("rollout 内部工具按响应归属，增量续读、旧缓存重建及 Worker 回退保持计价不变", async (t) => {
  const threadId = "98989898-9898-4989-8989-989898989898";
  const turnId = "turn-execution-items";
  const usage = rolloutUsage({ input: 100, output: 20 });
  const epoch = Date.now() - 20_000;
  const at = (offset) => new Date(epoch + offset).toISOString();
  const responseItem = (type, offset, callId = "outer-a") => ({ timestamp: at(offset), type: "response_item", payload: {
    type, name: "exec", call_id: callId,
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  } });
  const item = (id, started, duration, ownerThread = threadId) => ({
    timestamp: at(started + duration), type: "event_msg", payload: {
      type: "item_completed", thread_id: ownerThread, turn_id: turnId,
      started_at_ms: epoch + started, completed_at_ms: epoch + started + duration,
      item: { type: "CommandExecution", id, command: ["secret-marker"],
        parsed_cmd: [{ type: "unknown", cmd: "npm test" }],
        duration: { secs: Math.floor(duration / 1_000), nanos: duration % 1_000 * 1_000_000 },
        stdout: "secret-marker", status: "completed" },
    },
  });
  const prefix = [
    turnContext(turnId, "gpt-5.6-sol", at(0)),
    responseItem("custom_tool_call", 100),
    tokenUsageRecord(turnId, "resp-tools-a", usage, 120, at(110)),
    item("inner-a", 150, 6_317),
    item("inner-b", 160, 5_000),
    { timestamp: at(400), type: "event_msg", payload: {
      type: "item_completed", thread_id: threadId, turn_id: turnId,
      started_at_ms: epoch + 320, completed_at_ms: epoch + 400,
      item: { type: "FileChange", id: "inner-patch", changes: Object.fromEntries(
        Array.from({ length: 40 }, (_, index) => [`/private/module-${index}.mjs`, { unified_diff: "secret-marker" }]),
      ) },
    } },
    item("foreign-item", 170, 10, "another-thread"),
    responseItem("custom_tool_call_output", 6_600),
    responseItem("custom_tool_call", 7_000, "outer-b"),
    tokenUsageRecord(turnId, "resp-tools-b", usage, 240, at(7_010)),
  ];
  const tail = [item("inner-c", 7_100, 100), responseItem("custom_tool_call_output", 7_300, "outer-b")];
  const events = [
    event("tool-active", "thread-active", threadId, null, { rolloutUsageFallback: true }),
    event("tool-start", "turn-started", threadId, turnId, {
      model: "gpt-5.6-sol", rolloutUsageFallback: true, generationMetricsVersion: GENERATION_METRICS_VERSION,
    }),
    ...["a", "b"].map((id) => event(`generation-${id}`, "generation", threadId, turnId, { generation: {
      responseId: `resp-tools-${id}`, toolNames: ["exec"], hasNonTextOutput: true,
    } })),
  ];
  const { manager, dataDir, codexHome } = await createManager(t, { events, rollouts: [{ threadId, records: prefix }] });
  const getTurn = (source) => source.getViewModel().turns.find((turn) => turn.turnId === turnId);
  const original = getTurn(manager);
  assert.deepEqual(original.generationDetails[0].toolExecutions.calls.map((call) => call.durationMs), [6_317, 5_000, 80]);
  assert.deepEqual(original.generationDetails[0].toolExecutions.calls.map((call) => call.description), ["1 条命令", "1 条命令", "40 个文件"]);
  assert.deepEqual(original.generationDetails[0].toolExecutions.calls[0].detailList, { kind: "commands", items: ["npm test"] });
  assert.equal(original.generationDetails[0].toolExecutions.calls[2].detailList.items.at(-1), "module-39.mjs");
  assert.equal(original.generationDetails[0].toolExecutions.durationMs, 6_500);
  assert.equal(original.generationDetails[1].toolExecutions.complete, false);
  assert.equal(original.totalTokens, 240);
  assert.equal(original.cost.available, true);
  await manager.flush();
  manager.close();

  // Resume a pending outer call across a cache reload, without rereading the
  // prefix; the response ID must survive and keep the two requests separate.
  const rolloutPath = [...manager.fileStates.keys()][0];
  await appendFile(rolloutPath, `${tail.map(JSON.stringify).join("\n")}\n`);
  const openManager = async (fallback = false) => {
    const restored = new TokenUsageManager({ codexHome, dataDir, discoveryIntervalMs: 0, pricingManager: pricing(dataDir) });
    let fallbackAttempts = 0;
    if (fallback) restored.rolloutReader.rolloutWorker = {
      postMessage() { fallbackAttempts++; throw new Error("fixture worker unavailable"); },
      terminate() {},
    };
    t.after(() => restored.close());
    await restored.initialize();
    if (fallback) assert.ok(fallbackAttempts > 0, "必须真实触发 Worker 失败和主线程回退");
    return restored;
  };
  const restored = await openManager();
  const expected = getTurn(restored);
  assert.deepEqual(expected.generationDetails[1].toolExecutions.calls.map((call) => call.id), ["inner-c"]);
  assert.equal(expected.totalTokens, 240);
  await restored.flush();
  restored.close();

  const cachePath = join(dataDir, "token-usage-cache.json");
  const current = JSON.parse(await readFile(cachePath, "utf8"));
  assert.equal(JSON.stringify(current).includes("secret-marker"), false);
  for (const fallback of [false, true]) {
    const old = structuredClone(current);
    old.version = 21;
    for (const turn of old.turns) {
      for (const item of turn.toolExecutionLedger?.items ?? []) {
        item.description = "已截断的旧明细";
        delete item.detailList;
      }
    }
    for (const state of old.fileStates) state.parserVersion = 8;
    await writeFile(cachePath, JSON.stringify(old));
    const rebuilt = await openManager(fallback);
    assert.deepEqual(getTurn(rebuilt).generationDetails, expected.generationDetails);
    assert.equal(getTurn(rebuilt).totalTokens, expected.totalTokens);
    assert.equal(getTurn(rebuilt).cost.totalCny, expected.cost.totalCny);
    await rebuilt.flush();
    rebuilt.close();
  }
});

test("旧版无响应 ID 通知仅作实时预览，逐响应账本会完整重建", async (t) => {
  const threadId = "13131313-1313-4313-8313-131313131313";
  const turnId = "turn-custom-response-record";
  const direct = protocolUsage({ input: 5, output: 5 });
  const exact = rolloutUsage({ input: 30, cached: 10, output: 10, reasoning: 2 });
  const missed = rolloutUsage({ input: 5, output: 5 });
  const events = [
    event("1", "turn-started", threadId, turnId, {
      model: "deepseek-v4-flash",
      modelSource: "turn-request",
    }),
    event("2", "usage", threadId, turnId, {
      model: "deepseek-v4-flash",
      tokenUsage: { last: direct, total: direct },
    }),
  ];
  const rollouts = [{
    threadId,
    records: [
      turnContext(turnId, "deepseek-v4-flash"),
      tokenUsageRecord(turnId, "resp-custom", exact, 40),
      tokenCount(exact, 40),
      tokenUsageRecord(turnId, "resp-custom-missed", missed, 50),
      tokenCount(missed, 50),
      taskComplete(),
    ],
  }];
  const { manager } = await createManager(t, { events, rollouts });
  const turn = manager.getViewModel().turns.find((value) => value.turnId === turnId);
  assert.equal(turn.inputTokens, 35);
  assert.equal(turn.outputTokens, 15);
  assert.equal(turn.totalTokens, 50);
});

test("逐响应记录与配对汇总分两次写入时，缓存恢复后仍只计一次", async (t) => {
  const threadId = "66666666-6666-4666-8666-666666666666";
  const turnId = "turn-incremental-usage";
  const exact = rolloutUsage({ input: 80, cached: 60, output: 20 });
  const { manager, dataDir, codexHome } = await createManager(t, {
    rollouts: [{
      threadId,
      records: [
        turnContext(turnId, "gpt-5.6-luna"),
        tokenUsageRecord(turnId, "resp-incremental", exact, 100),
      ],
    }],
  });
  assert.equal(
    manager.getViewModel().turns.find((turn) => turn.turnId === turnId)?.totalTokens,
    100,
  );
  await manager.flush();
  manager.close();

  const rolloutPath = join(
    codexHome,
    "sessions",
    "2026",
    "09",
    "11",
    `rollout-2026-09-11T00-00-00-${threadId}.jsonl`,
  );
  await appendFile(
    rolloutPath,
    `${JSON.stringify(tokenCount(exact, 100))}\n`,
  );
  const restored = new TokenUsageManager({
    codexHome,
    dataDir,
    discoveryIntervalMs: 0,
    pricingManager: pricing(dataDir),
  });
  t.after(() => restored.close());
  await restored.initialize();
  const turn = restored.getViewModel().turns.find((value) => value.turnId === turnId);
  assert.equal(turn.inputTokens, 80);
  assert.equal(turn.outputTokens, 20);
  assert.equal(turn.totalTokens, 100);
  await restored.flush();
  restored.close();
});

test("旧缓存升级会重建官方 rollout 用量，而不是在错误计数上继续叠加", async (t) => {
  const threadId = "77777777-7777-4777-8777-777777777777";
  const turnId = "turn-cache-rebuild";
  const exact = rolloutUsage({ input: 200, cached: 190, output: 10 });
  const zeroComponents = {
    ...rolloutUsage({ input: 0, output: 0 }),
    total_tokens: 26_084,
  };
  const events = [
    event("1", "thread-active", threadId, null, { rolloutUsageFallback: true }),
    event("2", "turn-started", threadId, turnId, {
      model: "gpt-5.6-sol",
      rolloutUsageFallback: true,
      generationMetricsVersion: GENERATION_METRICS_VERSION,
    }),
    event("3", "generation", threadId, turnId, {
      model: "gpt-5.6-sol",
      generation: {
        responseId: "resp-cache-rebuild",
        hasVisibleText: true,
        hasNonTextOutput: false,
        firstTokenLatencyMs: 300,
        generationDurationMs: 1_000,
      },
    }),
  ];
  const { manager, dataDir, codexHome } = await createManager(t, {
    events,
    rollouts: [{
      threadId,
      records: [
        turnContext(turnId, "gpt-5.6-sol"),
        tokenUsageRecord(turnId, "resp-cache-rebuild", exact, 210),
        tokenCount(zeroComponents, 26_084),
      ],
    }],
  });
  await manager.flush();
  manager.close();

  const cachePath = join(dataDir, "token-usage-cache.json");
  const cache = JSON.parse(await readFile(cachePath, "utf8"));
  cache.version = 16;
  const cachedTurn = cache.turns.find((turn) => turn.turnId === turnId);
  Object.assign(cachedTurn, {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 26_084,
    cumulativeTotalTokens: 26_084,
    segments: [{
      model: "gpt-5.6-sol",
      modelSource: "turn-context",
      contextTier: "short",
      usage: { ...zeroComponents },
    }],
  });
  cachedTurn.rolloutParserVersion = 5;
  delete cachedTurn.rolloutTokenCountTotalTokens;
  delete cachedTurn.usageResponseIds;
  for (const state of cache.fileStates) {
    state.parserVersion = 5;
    state.pendingUsageRecords = [{
      turnId,
      responseId: "resp-cache-rebuild",
    }];
  }
  await writeFile(cachePath, JSON.stringify(cache));

  const restored = new TokenUsageManager({
    codexHome,
    dataDir,
    discoveryIntervalMs: 0,
    pricingManager: pricing(dataDir),
  });
  t.after(() => restored.close());
  await restored.initialize();
  const turn = restored.getViewModel().turns.find((value) => value.turnId === turnId);
  assert.equal(turn.inputTokens, 200);
  assert.equal(turn.cachedInputTokens, 190);
  assert.equal(turn.outputTokens, 10);
  assert.equal(turn.totalTokens, 210);
  assert.equal(turn.cost.available, true);
  assert.equal(turn.firstTokenLatencyMs, 300);
  assert.equal(turn.outputSpeed, 9);
  await restored.flush();
  restored.close();
});
