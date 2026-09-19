import { createHash } from "node:crypto";

const STATE_KEYS = new Set(["current_turn_state", "x-codex-turn-state"]);
const SKIPPED_KEYS = new Set(["input", "output", "text", "delta", "content", "arguments", "tools", "instructions"]);

function turnStateSummary(field, value) {
  if (typeof value !== "string" || value.length === 0) return null;
  return {
    field,
    charLength: value.length,
    byteLength: Buffer.byteLength(value),
    sha256: createHash("sha256").update(value).digest("hex"),
  };
}

function turnStateSummaries(value, prefix = "", { maxDepth = 6, maxNodes = 2_000 } = {}) {
  const summaries = [];
  const seen = new Set();
  let nodes = 0;
  const visit = (current, path, depth) => {
    if (!current || typeof current !== "object" || depth > maxDepth || seen.has(current) || nodes++ >= maxNodes) return;
    seen.add(current);
    for (const [key, child] of Object.entries(current)) {
      const field = path ? `${path}.${key}` : key;
      if (STATE_KEYS.has(key.toLowerCase())) {
        const summary = turnStateSummary(field, child);
        if (summary) summaries.push(summary);
      }
      if (!SKIPPED_KEYS.has(key) && child && typeof child === "object") visit(child, field, depth + 1);
    }
  };
  visit(value, prefix, 0);
  return summaries;
}

function uniqueTurnStateSummaries(summaries) {
  const unique = new Map();
  for (const summary of summaries) unique.set(`${summary.field}:${summary.sha256}`, summary);
  return [...unique.values()];
}

export { turnStateSummary, turnStateSummaries, uniqueTurnStateSummaries };
