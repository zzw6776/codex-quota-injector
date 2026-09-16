import { homedir } from "node:os";
import { join } from "node:path";

// Version 14 discards generation metrics produced before structural tool-call
// detection, because those records can mix tool arguments into visible speed.
// Version 17 rebuilds rollout usage from response-level records so compacted
// responses are priced from their exact token breakdown, and persists the
// structural identity needed to pair exact records with legacy summaries.
// Version 18 persists per-message phases and tool preparation timings used by
// the request-stage breakdown. Version 19 stores the connection RTT sample
// associated with each model request.
// Version 20 retains sanitized, response-associated tool item lifecycles.
// Version 21 replaces inferred command purposes with argument-free commands.
// Version 22 preserves expandable file/command lists and Node entry points.
// Version 23 adds request-level output coverage and attributable phase speeds.
// Version 24 retains sanitized direct child identities for exec fallbacks.
const CACHE_VERSION = 24;

const MIN_SUPPORTED_CACHE_VERSION = 11;

const MIN_GENERATION_METRICS_CACHE_VERSION = 14;

const DISCOVERY_INTERVAL_MS = 5_000;

const MAX_VIEW_TURNS = 120;

const MAX_STORED_TURNS = 2_000;

const MAX_TRACKED_ROLLOUT_STATES = 256;

const MAX_HISTORICAL_THREADS = 2_048;

const MAX_HISTORICAL_SEGMENTS = 128;

const READ_CHUNK_BYTES = 1024 * 1024;

const COST_CACHE_VERSION = 3;

const ROLLOUT_PARSER_VERSION = 10;

const MAX_SEEN_EVENT_IDS = 50_000;

const MAX_SEEN_USAGE_RESPONSE_IDS = 4_096;

const MAX_PENDING_USAGE_RECORDS = 512;

const MAX_PENDING_GENERATION_RECORDS = 512;

const CACHE_PERSIST_DELAY_MS = 10_000;

const UNKNOWN_ROLLOUT_CHECK_INTERVAL_MS = 10_000;

const UNKNOWN_ROLLOUT_RECONCILE_CONCURRENCY = 4;

const ACTIVE_THREAD_HINT_TTL_MS = 5 * 60 * 1000;

const RECENT_ROLLOUT_ACTIVITY_MS = 5 * 60 * 1000;

const MAX_ROLLOUT_METADATA_BYTES = 4 * 1024 * 1024;

const TOKEN_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
];

const TERMINAL_TURN_STATUSES = new Set(["completed", "interrupted", "failed"]);

const EVENT_WATCH_DEBOUNCE_MS = 80;

const MODEL_SOURCE_PRIORITY = Object.freeze({
  thread: 1,
  "thread-settings": 1,
  "thread-response": 1,
  "thread-request": 2,
  "turn-request": 3,
  "turn-started": 3,
  usage: 3,
  completed: 3,
  generation: 3,
  "turn-response": 5,
  "turn-context": 4,
  rerouted: 6,
});

function resolveCodexHome() {
  const configured = String(process.env.CODEX_HOME ?? "").trim().replace(/^['"]|['"]$/g, "");
  return configured || join(homedir(), ".codex");
}

function toCamelCase(value) {
  return value.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function nonNegativeNumberOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function nonEmptyString(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function parseTimestamp(value) {
  const number = Date.parse(value);
  return Number.isFinite(number) ? number : Date.now();
}

export { CACHE_VERSION, MIN_SUPPORTED_CACHE_VERSION, MIN_GENERATION_METRICS_CACHE_VERSION, DISCOVERY_INTERVAL_MS, MAX_VIEW_TURNS, MAX_STORED_TURNS, MAX_TRACKED_ROLLOUT_STATES, MAX_HISTORICAL_THREADS, COST_CACHE_VERSION, ROLLOUT_PARSER_VERSION, MAX_SEEN_EVENT_IDS, CACHE_PERSIST_DELAY_MS, UNKNOWN_ROLLOUT_CHECK_INTERVAL_MS, UNKNOWN_ROLLOUT_RECONCILE_CONCURRENCY, ACTIVE_THREAD_HINT_TTL_MS, RECENT_ROLLOUT_ACTIVITY_MS, EVENT_WATCH_DEBOUNCE_MS, resolveCodexHome, positiveNumber, positiveInteger, nonEmptyString, TOKEN_FIELDS, toCamelCase, MAX_SEEN_USAGE_RESPONSE_IDS, MAX_PENDING_USAGE_RECORDS, nonNegativeNumberOrNull, MAX_PENDING_GENERATION_RECORDS, MODEL_SOURCE_PRIORITY, MAX_HISTORICAL_SEGMENTS, READ_CHUNK_BYTES, MAX_ROLLOUT_METADATA_BYTES, parseTimestamp, TERMINAL_TURN_STATUSES };
