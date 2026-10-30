import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { isUsableModelCatalog as isUsableCatalog } from "./model-catalog-validation.mjs";

const CACHE_VERSION = 3;
const FRESH_MS = 60 * 60_000;

export async function accountCatalogCache({
  account,
  dataDir,
  clientVersion,
  originator,
  now = Date.now,
}) {
  const key = createHash("sha256")
    .update(JSON.stringify([
      CACHE_VERSION,
      accountIdentity(account),
      clientVersion,
      originator,
    ]))
    .digest("hex");
  const path = join(dataDir, "official-model-catalog", `${key}.json`);
  const record = await json(path);
  const staleCatalog = validRecord(record, { clientVersion, originator })
    ? record.catalog
    : null;
  const catalog = staleCatalog && fresh(record, now()) ? staleCatalog : null;

  return {
    catalog,
    staleCatalog,
    async save(nextCatalog) {
      if (!isUsableCatalog(nextCatalog)) return;
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      const savedAt = new Date(now()).toISOString();
      try {
        await writeFile(
          temporary,
          JSON.stringify({
            version: CACHE_VERSION,
            clientVersion,
            originator,
            savedAt,
            catalog: nextCatalog,
          }),
          { mode: 0o600 },
        );
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
    },
  };
}

function accountIdentity(account) {
  const recordId = String(account?.id ?? "").trim();
  const workspaceId = String(account?.accountId ?? "").trim();
  if (recordId || workspaceId) return [recordId || null, workspaceId || null];

  // Imported credentials can temporarily lack account metadata. Keep those
  // caches isolated, accepting that a token rotation will force one refresh.
  const tokenIdentity = String(
    account?.tokens?.idToken || account?.tokens?.accessToken || "",
  );
  return [null, createHash("sha256").update(tokenIdentity).digest("hex")];
}

function validRecord(record, { clientVersion, originator }) {
  return record?.version === CACHE_VERSION &&
    record.clientVersion === clientVersion &&
    record.originator === originator &&
    Number.isFinite(Date.parse(record.savedAt)) &&
    isUsableCatalog(record.catalog);
}

function fresh(record, now) {
  const age = now - Date.parse(record.savedAt);
  return age >= 0 && age < FRESH_MS;
}

async function json(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}
