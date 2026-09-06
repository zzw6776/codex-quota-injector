import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { writeOfficialCredentials } from "./account-manager.mjs";

const execFileAsync = promisify(execFile);
const REFRESH_TIMEOUT_MS = 15_000;
const MAX_CATALOG_OUTPUT_BYTES = 16 * 1024 * 1024;
const TEMP_HOME_PREFIX = "codex-quota-model-catalog-";

export async function fetchOfficialModelCatalog({ executable, account }) {
  if (!executable) throw new Error("Codex CLI 路径为空");
  const hasOAuth = account?.authMode === "oauth" && account.tokens?.accessToken;
  const hasApiKey = account?.authMode === "apiKey" && account.openaiApiKey;
  if (!hasOAuth && !hasApiKey) {
    return { catalog: null, skipped: true, source: null };
  }

  const temporaryHome = await mkdtemp(join(tmpdir(), TEMP_HOME_PREFIX));
  try {
    // The temporary CLI may refresh and rotate a token when access expires. A
    // token rotated inside this disposable home would invalidate the real Codex
    // credentials when the directory is removed, so catalog probes never receive
    // the account's refresh token. A stale access token simply preserves the last
    // usable catalog until Codex updates its official credentials.
    const probeAccount = hasOAuth
      ? {
          ...account,
          tokens: { ...account.tokens, refreshToken: null },
        }
      : account;
    await writeOfficialCredentials(temporaryHome, probeAccount, { syncKeychain: false });
    const env = createOfficialCatalogEnvironment(temporaryHome);
    const { stdout } = await execFileAsync(
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
    const cache = await readJson(join(temporaryHome, "models_cache.json"));
    if (hasOAuth) {
      // `debug models` deliberately falls back to the bundled catalog when its
      // network refresh fails. Only a newly written cache proves that the OAuth
      // account's online catalog was actually fetched.
      if (!isUsableCatalog(cache)) {
        throw new Error("Codex 未写入账号在线模型缓存，已保留上次可用目录");
      }
      return { catalog: cache, skipped: false, source: "online" };
    }
    // API-key auth does not use the Codex account-catalog endpoint. The command
    // still provides the catalog bundled with the installed official CLI.
    return { catalog: outputCatalog, skipped: false, source: "bundled" };
  } finally {
    await rm(temporaryHome, { recursive: true, force: true }).catch(() => undefined);
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

function parseCatalog(value) {
  let catalog;
  try {
    catalog = JSON.parse(String(value ?? ""));
  } catch {
    throw new Error("Codex 返回的官方模型目录不是有效 JSON");
  }
  if (!isUsableCatalog(catalog)) {
    throw new Error("Codex 返回的官方模型目录为空或包含重复模型");
  }
  return catalog;
}

function isUsableCatalog(value) {
  if (!value || !Array.isArray(value.models) || value.models.length === 0) return false;
  const slugs = new Set();
  return value.models.every((model) => {
    const slug = typeof model?.slug === "string" ? model.slug.trim() : "";
    if (!slug || slugs.has(slug)) return false;
    slugs.add(slug);
    return true;
  });
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}
