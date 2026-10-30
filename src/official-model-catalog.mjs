import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { writeOfficialCredentials } from "./account-manager.mjs";
import {
  TOKEN_REFRESH_LEAD_SECONDS,
  USER_AGENT,
} from "./account-manager/contract.mjs";
import { jwtExpiration } from "./account-manager/tokens.mjs";
import { readCodexRuntimeVersion } from "./codex-runtime/install.mjs";
import { parseCodexVersion } from "./codex-runtime/releases.mjs";
import { isUsableModelCatalog as isUsableCatalog } from "./model-catalog-validation.mjs";
import { defaultAccountDataDir } from "./platform/directories.mjs";
import { accountCatalogCache } from "./official-model-catalog-cache.mjs";

const execFileAsync = promisify(execFile);
const REFRESH_TIMEOUT_MS = 15_000;
const MAX_CATALOG_OUTPUT_BYTES = 16 * 1024 * 1024;
const TEMP_HOME_PREFIX = "codex-quota-model-catalog-";
const OFFICIAL_MODELS_URL = "https://chatgpt.com/backend-api/codex/models";
const DEFAULT_ORIGINATOR = "Codex Desktop";
const TOKEN_REQUEST_SAFETY_SECONDS = 5;

export async function fetchOfficialModelCatalog({ executable, account, runCli = execFileAsync,
  fetchImpl = globalThis.fetch, dataDir = defaultAccountDataDir(), now = Date.now,
  refreshTimeoutMs = REFRESH_TIMEOUT_MS, clientVersion = null,
  readVersion = readCodexRuntimeVersion, originator = resolveCatalogOriginator(),
  force = false }) {
  const hasOAuth = account?.authMode === "oauth" && account.tokens?.accessToken;
  const hasApiKey = account?.authMode === "apiKey" && account.openaiApiKey;
  if (!hasOAuth && !hasApiKey) {
    return { catalog: null, skipped: true, source: null };
  }

  if (hasOAuth) {
    const resolvedClientVersion = parseCodexVersion(clientVersion)?.raw ??
      await readVersion(executable);
    const resolvedOriginator = normalizeCatalogOriginator(originator);
    const cacheState = await accountCatalogCache({
      account,
      dataDir,
      clientVersion: resolvedClientVersion,
      originator: resolvedOriginator,
      now,
    });
    if (!force && cacheState.catalog) {
      return { catalog: cacheState.catalog, skipped: false, source: "cache" };
    }
    const expiration = jwtExpiration(account.tokens.accessToken);
    const requestSafetySeconds = Math.ceil(refreshTimeoutMs / 1_000) +
      TOKEN_REQUEST_SAFETY_SECONDS;
    const deferLeadSeconds = cacheState.staleCatalog
      ? TOKEN_REFRESH_LEAD_SECONDS
      : requestSafetySeconds;
    if (expiration != null && expiration <= Math.floor(now() / 1_000) + deferLeadSeconds) {
      return {
        catalog: cacheState.staleCatalog,
        skipped: true,
        source: cacheState.staleCatalog ? "cache" : null,
        deferred: true,
        retryAfterMs: TOKEN_REFRESH_LEAD_SECONDS * 1_000,
      };
    }
    let catalog;
    try {
      catalog = await fetchOAuthCatalog({
        account,
        clientVersion: resolvedClientVersion,
        originator: resolvedOriginator,
        fetchImpl,
        now,
        refreshTimeoutMs,
      });
    } catch (error) {
      if (cacheState.staleCatalog) error.catalogFallbackCatalog = cacheState.staleCatalog;
      throw error;
    }
    await cacheState.save(catalog);
    return { catalog, skipped: false, source: "online" };
  }

  if (!executable) throw new Error("Codex CLI 路径为空");

  const temporaryHome = await mkdtemp(join(tmpdir(), TEMP_HOME_PREFIX));
  try {
    await writeOfficialCredentials(temporaryHome, account, { syncKeychain: false });
    const env = createOfficialCatalogEnvironment(temporaryHome);
    const { stdout } = await runCli(
      executable,
      ["-c", 'cli_auth_credentials_store="file"', "debug", "models"],
      {
        cwd: temporaryHome,
        env,
        timeout: REFRESH_TIMEOUT_MS,
        maxBuffer: MAX_CATALOG_OUTPUT_BYTES,
        windowsHide: true,
      },
    );
    const outputCatalog = parseCatalog(stdout);
    // API-key auth does not use the Codex account-catalog endpoint. The command
    // still provides the catalog bundled with the installed official CLI.
    return { catalog: outputCatalog, skipped: false, source: "bundled" };
  } finally {
    await rm(temporaryHome, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function fetchOAuthCatalog({
  account,
  clientVersion,
  originator,
  fetchImpl,
  now,
  refreshTimeoutMs,
}) {
  if (typeof fetchImpl !== "function") {
    throw catalogRequestError("当前 Node.js 环境不支持获取官方模型目录");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), refreshTimeoutMs);
  let phase = "request";
  try {
    const url = new URL(OFFICIAL_MODELS_URL);
    url.searchParams.set("client_version", clientVersion);
    const response = await fetchImpl(url.href, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${account.tokens.accessToken}`,
        "User-Agent": USER_AGENT,
        originator,
        ...(account.accountId
          ? { "ChatGPT-Account-Id": account.accountId }
          : {}),
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      const status = Number(response.status);
      const retryable = status >= 500 || [408, 409, 425, 429].includes(status);
      const retryAfterMs = status === 429
        ? parseRetryAfter(response.headers?.get?.("retry-after"), now())
        : null;
      throw catalogRequestError(`OpenAI 模型目录请求失败（HTTP ${status}）`, {
        retryable,
        retryAfterMs,
      });
    }

    const contentLength = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_CATALOG_OUTPUT_BYTES) {
      throw catalogRequestError("OpenAI 返回的官方模型目录过大");
    }

    phase = "body";
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > MAX_CATALOG_OUTPUT_BYTES) {
      throw catalogRequestError("OpenAI 返回的官方模型目录过大");
    }
    return parseCatalog(body, "OpenAI");
  } catch (error) {
    if (error?.catalogRetryable != null) throw error;
    if (controller.signal.aborted) {
      throw catalogRequestError("OpenAI 模型目录请求超时");
    }
    throw catalogRequestError(phase === "body"
      ? `读取 OpenAI 官方模型目录失败：${error.message}`
      : `OpenAI 模型目录请求失败：${error.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

function createOfficialCatalogEnvironment(codexHome) {
  const env = { ...process.env, CODEX_HOME: codexHome };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CODEX_QUOTA_")) delete env[key];
    if (key.startsWith("CODEX_APP_SERVER_")) delete env[key];
  }
  delete env.CODEX_CLI_PATH;
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  return env;
}

function parseCatalog(value, source = "Codex") {
  let catalog;
  try {
    catalog = JSON.parse(String(value ?? ""));
  } catch {
    throw catalogRequestError(`${source} 返回的官方模型目录不是有效 JSON`);
  }
  if (!isUsableCatalog(catalog)) {
    throw catalogRequestError(`${source} 返回的官方模型目录为空或包含重复模型`);
  }
  return catalog;
}

function catalogRequestError(message, { retryable = true, retryAfterMs = null } = {}) {
  const error = new Error(message);
  error.catalogRetryable = retryable;
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    error.catalogRetryAfterMs = retryAfterMs;
  }
  return error;
}

function parseRetryAfter(value, now) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

export function resolveCatalogOriginator(environment = process.env) {
  return normalizeCatalogOriginator(
    environment.CODEX_INTERNAL_ORIGINATOR_OVERRIDE,
  );
}

export function normalizeCatalogOriginator(value) {
  const text = String(value ?? "").trim();
  return text && text.length <= 256 && /^[\x20-\x7e]+$/.test(text)
    ? text
    : DEFAULT_ORIGINATOR;
}
