import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const TERMINAL_EVENTS = new Set(["task_complete", "turn_aborted"]);

export async function findActiveCodexTurns({
  codexHome = process.env.CODEX_HOME || join(homedir(), ".codex"),
  recentWindowMs = 24 * 60 * 60 * 1_000,
  now = () => Date.now(),
} = {}) {
  const sessionsRoot = resolve(codexHome, "sessions");
  const files = await collectRolloutFiles(sessionsRoot).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const recent = [];
  for (const path of files) {
    const info = await stat(path).catch(() => null);
    if (info && now() - info.mtimeMs <= recentWindowMs) recent.push(path);
  }
  const active = [];
  for (const path of recent) {
    const turn = await readLatestTurnState(path);
    if (turn) active.push(turn);
  }
  return active;
}

export async function captureCodexSessionCheckpoint(options = {}) {
  const turns = await findActiveCodexTurns(options);
  return {
    capturedAt: new Date().toISOString(),
    turns: turns.map((turn) => ({
      path: turn.path,
      turnId: turn.turnId,
      startedAt: turn.startedAt,
    })),
  };
}

async function readLatestTurnState(path, { chunkSize = 256 * 1_024 } = {}) {
  const handle = await open(path, "r");
  try {
    let end = (await handle.stat()).size;
    let suffix = Buffer.alloc(0);
    while (end > 0) {
      const start = Math.max(0, end - chunkSize);
      const chunk = Buffer.alloc(end - start);
      await handle.read(chunk, 0, chunk.length, start);
      const combined = Buffer.concat([chunk, suffix]);
      const firstNewline = start === 0 ? -1 : combined.indexOf(0x0a);
      const complete = start === 0
        ? combined
        : firstNewline < 0 ? Buffer.alloc(0) : combined.subarray(firstNewline + 1);
      const lines = complete.toString("utf8").split(/\r?\n/);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const state = latestTurnStateFromLine(lines[index], path);
        if (state !== undefined) return state;
      }
      suffix = start === 0
        ? Buffer.alloc(0)
        : firstNewline < 0 ? combined : combined.subarray(0, firstNewline);
      end = start;
    }
    return null;
  } finally {
    await handle.close();
  }
}

function latestTurnStateFromLine(line, path) {
  if (!line) return undefined;
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return undefined;
  }
  const payload = record?.type === "event_msg" ? record.payload : null;
  if (payload?.type === "task_started" && payload.turn_id) {
    return {
      path,
      turnId: String(payload.turn_id),
      startedAt: record.timestamp ?? null,
    };
  }
  if (TERMINAL_EVENTS.has(payload?.type)) return null;
  return undefined;
}

export function parseActiveCodexTurns(contents, { path = null } = {}) {
  const active = new Map();
  let currentTurnId = null;
  for (const line of String(contents ?? "").split(/\r?\n/)) {
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = record?.payload;
    if (record?.type === "turn_context" && payload?.turn_id) {
      currentTurnId = String(payload.turn_id);
      continue;
    }
    if (record?.type !== "event_msg" || !payload?.type) continue;
    const turnId = payload.turn_id ? String(payload.turn_id) : currentTurnId;
    if (payload.type === "task_started" && turnId) {
      // A rollout can miss turn_aborted when Codex is terminated. A later turn in the
      // same rollout proves that the previous one is no longer running.
      active.clear();
      currentTurnId = turnId;
      active.set(turnId, { path, turnId, startedAt: record.timestamp ?? null });
    } else if (TERMINAL_EVENTS.has(payload.type) && turnId) {
      active.delete(turnId);
      if (currentTurnId === turnId) currentTurnId = null;
    }
  }
  return [...active.values()];
}

export async function waitForCodexTurnsIdle({
  stableDurationMs = 3_000,
  timeoutMs = 10 * 60 * 1_000,
  pollIntervalMs = 500,
  findActiveTurns = findActiveCodexTurns,
  ...findOptions
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let stableSince = null;
  let observedTurnCount = 0;
  while (Date.now() < deadline) {
    const active = await findActiveTurns(findOptions);
    observedTurnCount = Math.max(observedTurnCount, active.length);
    if (active.length === 0) {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= stableDurationMs) {
        return { idle: true, observedTurnCount };
      }
    } else {
      stableSince = null;
    }
    await delay(pollIntervalMs);
  }
  throw new Error("等待 Codex 活动轮次落盘超时，拒绝关闭桌面应用");
}

async function collectRolloutFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectRolloutFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
  }
  return files;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
