import { open, stat, readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { RECENT_ROLLOUT_ACTIVITY_MS, MAX_TRACKED_ROLLOUT_STATES, READ_CHUNK_BYTES, MAX_ROLLOUT_METADATA_BYTES, positiveInteger, nonEmptyString } from "./contract.mjs";

async function readAppendedChunks(path, state, onLine) {
  const info = await stat(path);
  if (info.size === state.offset) return;
  const handle = await open(path, "r");
  try {
    while (state.offset < info.size) {
      const length = Math.min(READ_CHUNK_BYTES, info.size - state.offset);
      const buffer = Buffer.allocUnsafe(length);
      const result = await handle.read(buffer, 0, length, state.offset);
      if (result.bytesRead === 0) break;
      state.offset += result.bytesRead;
      const lines = `${state.pending}${buffer.subarray(0, result.bytesRead).toString("utf8")}`
        .split(/\r?\n/);
      state.pending = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    }
  } finally {
    await handle.close();
  }
}

async function collectRolloutFiles(root, depth) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const paths = [];
  await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
      paths.push(path);
    } else if (entry.isDirectory() && depth > 0) {
      paths.push(...await collectRolloutFiles(path, depth - 1));
    }
  }));
  return paths;
}

async function readRolloutSessionMetadata(path) {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const length = Math.min(info.size, MAX_ROLLOUT_METADATA_BYTES);
  if (length <= 0) return null;
  const handle = await open(path, "r");
  let content = "";
  try {
    let offset = 0;
    while (offset < length) {
      const chunkLength = Math.min(READ_CHUNK_BYTES, length - offset);
      const buffer = Buffer.allocUnsafe(chunkLength);
      const result = await handle.read(buffer, 0, chunkLength, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
      content += buffer.subarray(0, result.bytesRead).toString("utf8");
      const newline = content.indexOf("\n");
      if (newline >= 0) {
        content = content.slice(0, newline).replace(/\r$/, "");
        break;
      }
    }
  } finally {
    await handle.close();
  }
  if (!content) return null;
  let record;
  try {
    record = JSON.parse(content);
  } catch {
    return null;
  }
  if (record?.type !== "session_meta" || !record.payload) return null;
  const payload = record.payload;
  const threadId = nonEmptyString(payload.id) ?? threadIdFromRolloutPath(path);
  if (!threadId) return null;
  const spawn = payload.source?.subagent?.thread_spawn;
  const isSubagent = payload.thread_source === "subagent" && Boolean(spawn);
  const parentThreadId = isSubagent ? nonEmptyString(spawn.parent_thread_id) : null;
  const rootThreadId = isSubagent
    ? nonEmptyString(payload.session_id) ?? parentThreadId ?? threadId
    : threadId;
  return {
    threadId,
    rootThreadId,
    isSubagent,
    parentThreadId: parentThreadId ?? "",
    agentPath: isSubagent ? String(spawn.agent_path ?? "") : "",
    agentNickname: isSubagent ? String(spawn.agent_nickname ?? "") : "",
    agentDepth: isSubagent ? Math.max(1, positiveInteger(spawn.depth)) : 0,
  };
}

function threadIdFromRolloutPath(path) {
  const match = basename(path).match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/i);
  return match?.[1] ?? null;
}

export { readAppendedChunks, collectRolloutFiles, readRolloutSessionMetadata, threadIdFromRolloutPath };

// File discovery and grouping are independent of turn accounting and cache scheduling.
export async function refreshRolloutCatalogFiles(codexHome, { rolloutPathsByThread, rolloutMetadataByPath, rolloutMetadataByThread, recentRolloutThreads }) {
  const paths = await collectRolloutFiles(join(codexHome, "sessions"), 4);
  rolloutPathsByThread.clear();
  rolloutMetadataByThread.clear();
  recentRolloutThreads.clear();
  const discoveredPaths = new Set(paths);
  for (const path of rolloutMetadataByPath.keys()) {
    if (!discoveredPaths.has(path)) rolloutMetadataByPath.delete(path);
  }
  const catalogEntries = (await Promise.all(paths.map(async (path) => {
    let metadata = rolloutMetadataByPath.get(path);
    if (!metadata) {
      metadata = await readRolloutSessionMetadata(path);
      if (metadata) rolloutMetadataByPath.set(path, metadata);
    }
    let modifiedAt;
    try {
      modifiedAt = (await stat(path)).mtimeMs;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return null;
    }
    const threadId = metadata?.threadId ?? threadIdFromRolloutPath(path);
    return threadId ? { path, metadata, threadId, modifiedAt } : null;
  }))).filter(Boolean);
  const entriesByThread = new Map();
  for (const entry of catalogEntries) {
    const entries = entriesByThread.get(entry.threadId) ?? [];
    entries.push(entry);
    entriesByThread.set(entry.threadId, entries);
  }
  const latestEntries = [];
  for (const [threadId, entries] of entriesByThread) {
    entries.sort((left, right) => left.modifiedAt - right.modifiedAt ||
      basename(left.path).localeCompare(basename(right.path)));
    rolloutPathsByThread.set(threadId, entries.map((entry) => entry.path));
    const latestEntry = entries.at(-1);
    latestEntries.push(latestEntry);
    if (latestEntry.metadata) {
      rolloutMetadataByThread.set(threadId, latestEntry.metadata);
    }
  }
  const recentCutoff = Date.now() - RECENT_ROLLOUT_ACTIVITY_MS;
  const recentEntries = latestEntries
    .filter((entry) => entry.modifiedAt >= recentCutoff)
    .sort((left, right) => right.modifiedAt - left.modifiedAt)
    .slice(0, MAX_TRACKED_ROLLOUT_STATES);
  for (const entry of recentEntries) {
    recentRolloutThreads.add(entry.threadId);
  }
  return { paths, discoveredPaths, entriesByThread, latestEntries };
}
