import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function relayInstancePath(base, sessionId) {
  if (!SESSION_ID.test(sessionId ?? "")) throw new Error("中继会话 ID 无效");
  return base ? `${base}.instance-${sessionId}.json` : "";
}

export function relayInstanceId(base, fileName) {
  const prefix = `${basename(base)}.instance-`;
  if (!fileName.startsWith(prefix) || !fileName.endsWith(".json")) return null;
  const id = fileName.slice(prefix.length, -5);
  return SESSION_ID.test(id) ? id : null;
}

export async function listRelayInstances(base) {
  if (!base) return [];
  const names = await readdir(dirname(base)).catch(error => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return names.flatMap(name => {
    const sessionId = relayInstanceId(base, name);
    return sessionId ? [{ sessionId, path: join(dirname(base), name) }] : [];
  });
}
