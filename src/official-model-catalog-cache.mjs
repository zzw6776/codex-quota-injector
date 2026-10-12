import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const CACHE_VERSION = 1;
// Match the official models manager's five-minute freshness window.
const FRESH_MS = 5 * 60_000;

export async function accountCatalogCache({ executable, account, dataDir, codexHome, now = Date.now }) {
  const binary = await stat(executable);
  const key = createHash('sha256').update(JSON.stringify([executable, binary.size, binary.mtimeMs,
    account.accountId, account.tokens.idToken || account.tokens.accessToken,
    process.env.OPENAI_BASE_URL ?? null, process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE ?? null])).digest('hex');
  const path = join(dataDir, 'official-model-catalog', `${key}.json`);
  const record = await json(path);
  const proven = record?.version === CACHE_VERSION && metadata(record.catalog) ? record.catalog : null;
  const native = proven ? await json(join(codexHome, 'models_cache.json')) : null;
  const candidates = [proven, native && native.identity === proven?.identity &&
    native.client_version === proven?.client_version ? native : null].filter(catalog => fresh(catalog, now()));
  candidates.sort((a, b) => Date.parse(b.fetched_at) - Date.parse(a.fetched_at));
  return { catalog: candidates[0] ?? null, async save(catalog) {
    if (!metadata(catalog)) return;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: CACHE_VERSION, catalog }), { mode: 0o600 });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  } };
}

function metadata(catalog) {
  return /^[a-f0-9]{64}$/.test(catalog?.identity ?? '') && typeof catalog.client_version === 'string' &&
    Number.isFinite(Date.parse(catalog.fetched_at)) && Array.isArray(catalog.models) && catalog.models.length > 0 &&
    catalog.models.every(model => typeof model?.slug === 'string' && model.slug.trim()) &&
    new Set(catalog.models.map(model => model.slug)).size === catalog.models.length;
}
function fresh(catalog, now) {
  const age = now - Date.parse(catalog?.fetched_at);
  return metadata(catalog) && age >= 0 && age < FRESH_MS;
}
async function json(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } }
