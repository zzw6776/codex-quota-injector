import { promisify } from "node:util";
import { brotliDecompress, gunzip, inflate, zstdDecompress } from "node:zlib";
import { timingSafeEqual } from "node:crypto";

const MODEL_ROUTER_PROVIDER_ID = "codex_quota_router";

const MODEL_ROUTER_TOKEN_ENV = "CODEX_QUOTA_ROUTER_TOKEN";

const MODEL_ROUTER_TOKEN_HEADER = "x-codex-quota-router-token";

const CUSTOM_PROVIDER_PREFIX = "custom_";

const OPENAI_API_BASE_URL = "https://api.openai.com/v1/";

const CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex/";

const MAX_REQUEST_BYTES = 128 * 1024 * 1024;

const REQUEST_DECODERS = new Map([
  ["gzip", promisify(gunzip)],
  ["x-gzip", promisify(gunzip)],
  ["deflate", promisify(inflate)],
  ["br", promisify(brotliDecompress)],
  ["zstd", promisify(zstdDecompress)],
]);

const MAX_ERROR_BODY_BYTES = 64 * 1024;

const MAX_REQUEST_START_SKEW_MS = 60 * 60 * 1000;

const THREAD_ROUTE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const MAX_THREAD_ROUTES = 4096;

const MAX_TURN_USAGE = 4096;

const MAX_PENDING_TOOL_BATCHES = 4096;

const DEFAULT_ENDPOINT_REUSE_WAIT_MS = 3_000;

const ENDPOINT_REUSE_RETRY_MS = 50;

const DEFAULT_NETWORK_PROBE_INTERVAL_MS = 10_000;

const DEFAULT_NETWORK_PROBE_TIMEOUT_MS = 5_000;

const MAX_NETWORK_SAMPLES = 120;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function safeTokenEqual(value, expected) {
  const left = Buffer.from(nonEmptyString(Array.isArray(value) ? value[0] : value) ?? "");
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function nonEmptyString(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) && result > 0 ? result : 0;
}

export { MODEL_ROUTER_PROVIDER_ID, MODEL_ROUTER_TOKEN_ENV, MODEL_ROUTER_TOKEN_HEADER, OPENAI_API_BASE_URL, CHATGPT_CODEX_BASE_URL, MAX_REQUEST_BYTES, THREAD_ROUTE_TTL_MS, MAX_THREAD_ROUTES, MAX_TURN_USAGE, MAX_PENDING_TOOL_BATCHES, DEFAULT_ENDPOINT_REUSE_WAIT_MS, ENDPOINT_REUSE_RETRY_MS, DEFAULT_NETWORK_PROBE_INTERVAL_MS, DEFAULT_NETWORK_PROBE_TIMEOUT_MS, httpError, nonEmptyString, HOP_BY_HOP_HEADERS, safeTokenEqual, REQUEST_DECODERS, MAX_REQUEST_START_SKEW_MS, MAX_ERROR_BODY_BYTES, number, CUSTOM_PROVIDER_PREFIX, MAX_NETWORK_SAMPLES };
