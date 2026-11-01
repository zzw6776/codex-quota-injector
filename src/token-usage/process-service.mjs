import { createHash } from "node:crypto";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { format } from "node:util";

import { TokenPricingManager } from "../token-pricing.mjs";
import { TokenUsageManager } from "../token-usage.mjs";
import { DISCOVERY_INTERVAL_MS, MAX_VIEW_TURNS } from "./contract.mjs";
import { TOKEN_USAGE_PROCESS_PROTOCOL_VERSION } from "./process-contract.mjs";

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function signature(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

function knownSignatures(entries) {
  return new Map((Array.isArray(entries) ? entries : [])
    .filter((entry) => Array.isArray(entry) && entry.length === 2)
    .map(([id, value]) => [String(id), String(value)]));
}

async function usageDelta(manager, request) {
  const knownTurns = knownSignatures(request.turnSignatures);
  const knownStates = knownSignatures(request.stateSignatures);
  const view = manager.getViewModel();
  const turnIds = [];
  const turnUpdates = [];
  const currentTurnIds = new Set();
  for (const turn of view.turns) {
    const turnId = String(turn.turnId);
    const turnSignature = signature(turn);
    turnIds.push(turnId);
    currentTurnIds.add(turnId);
    if (knownTurns.get(turnId) !== turnSignature) {
      turnUpdates.push({ value: turn, signature: turnSignature });
    }
  }

  const states = manager.getTurnStatesViewModel();
  const stateUpdates = [];
  const currentStateIds = new Set();
  for (const [threadId, state] of Object.entries(states)) {
    const stateSignature = signature(state);
    currentStateIds.add(threadId);
    if (knownStates.get(threadId) !== stateSignature) {
      stateUpdates.push({ threadId, value: state, signature: stateSignature });
    }
  }

  return {
    status: view.status,
    error: view.error ?? null,
    turnIds,
    turnUpdates,
    removedTurnIds: [...knownTurns.keys()].filter((id) => !currentTurnIds.has(id)),
    stateUpdates,
    removedStateIds: [...knownStates.keys()].filter((id) => !currentStateIds.has(id)),
    sourceSnapshot: await manager.getSourceSnapshot(),
  };
}

function redirectConsoleToStderr() {
  const write = (...args) => process.stderr.write(`${format(...args)}\n`);
  console.log = write;
  console.info = write;
  console.warn = write;
  console.error = write;
}

async function writeProtocol(message) {
  if (process.stdout.write(`${JSON.stringify(message)}\n`)) return;
  await once(process.stdout, "drain");
}

async function runTokenUsageService() {
  redirectConsoleToStderr();
  process.title = "Codex Quota Token Usage";
  const codexHome = String(process.env.CODEX_QUOTA_TOKEN_USAGE_CODEX_HOME ?? "").trim();
  const dataDir = String(process.env.CODEX_QUOTA_TOKEN_USAGE_DATA_DIR ?? "").trim();
  if (!codexHome || !dataDir) throw new Error("Token 用量服务缺少运行目录");
  const pricingManager = new TokenPricingManager({
    dataDir,
    refreshOnInitialize: false,
  });
  const manager = new TokenUsageManager({
    codexHome,
    dataDir,
    discoveryIntervalMs: positiveInteger(
      process.env.CODEX_QUOTA_TOKEN_USAGE_DISCOVERY_INTERVAL_MS,
      DISCOVERY_INTERVAL_MS,
    ),
    maxViewTurns: positiveInteger(
      process.env.CODEX_QUOTA_TOKEN_USAGE_MAX_VIEW_TURNS,
      MAX_VIEW_TURNS,
    ),
    pricingManager,
    watchEvents: false,
    refreshPricing: false,
  });
  let initialized = false;
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of input) {
      if (!line.trim()) continue;
      let request;
      try {
        request = JSON.parse(line);
      } catch (error) {
        console.error(`[token-usage-service] 无法解析请求：${error.message}`);
        continue;
      }
      if (request?.protocol !== TOKEN_USAGE_PROCESS_PROTOCOL_VERSION || request?.id == null) {
        continue;
      }
      try {
        if (request.action === "flush") {
          if (initialized) await manager.flush();
          await writeProtocol({
            protocol: TOKEN_USAGE_PROCESS_PROTOCOL_VERSION,
            type: "response",
            id: request.id,
            ok: true,
          });
          continue;
        }
        const forceDiscovery = Boolean(request.forceDiscovery);
        const discoveryRevision = manager.getDiscoveryRevision();
        const rolloutPaths = Array.isArray(request.rolloutPaths)
          ? request.rolloutPaths.map(String)
          : [];
        const viewThreadId = request.viewThreadId == null
          ? null
          : String(request.viewThreadId).trim() || null;
        if (!initialized) {
          await manager.initialize({ forceDiscovery, rolloutPaths, viewThreadId });
          initialized = true;
        } else if (request.action === "refresh") {
          await manager.refresh({ forceDiscovery, rolloutPaths, viewThreadId });
        } else if (request.action !== "initialize") {
          throw new Error(`未知 Token 用量服务操作：${request.action}`);
        }
        await manager.whenSettled({ runScheduledReconciliation: true });
        await writeProtocol({
          protocol: TOKEN_USAGE_PROCESS_PROTOCOL_VERSION,
          type: "response",
          id: request.id,
          ok: true,
          fullDiscoveryCompleted: forceDiscovery &&
            manager.getDiscoveryRevision() > discoveryRevision,
          delta: await usageDelta(manager, request),
        });
      } catch (error) {
        await writeProtocol({
          protocol: TOKEN_USAGE_PROCESS_PROTOCOL_VERSION,
          type: "response",
          id: request.id,
          ok: false,
          error: error?.message ?? String(error),
        });
      }
    }
  } finally {
    input.close();
    await manager.flush().catch((error) => {
      console.error(`[token-usage-service] 保存缓存失败：${error.message}`);
    });
    manager.close();
  }
}

export { TOKEN_USAGE_PROCESS_PROTOCOL_VERSION, runTokenUsageService, usageDelta };
