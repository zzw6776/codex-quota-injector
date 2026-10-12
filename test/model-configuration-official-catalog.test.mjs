import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fetchOfficialModelCatalog } from "../src/official-model-catalog.mjs";
import { useTempDir } from "./helpers.mjs";
import { refreshCodexModelCatalog } from "../src/codex-bridge.mjs";

test("官方模型目录探测为 OAuth 隔离 refresh token，为 API Key 使用 CLI 输出", async (t) => {
  const directory = await useTempDir(t);
  const executable = join(directory, "fixture-codex");
  await writeFile(executable, "fixture");
  const capturePath = join(directory, "capture.json");
  const catalog = { models: [{ slug: "catalog-model" }] };
  const runCli = async (receivedExecutable, args, options) => {
    const auth = JSON.parse(await readFile(join(options.env.CODEX_HOME, "auth.json"), "utf8"));
    await writeFile(capturePath, JSON.stringify({ executable: receivedExecutable, auth, args }));
    if (auth.tokens) {
      await writeFile(join(options.env.CODEX_HOME, "models_cache.json"), JSON.stringify(catalog));
    }
    return { stdout: JSON.stringify(catalog), stderr: "" };
  };

  const oauth = await fetchOfficialModelCatalog({
    executable,
    dataDir: directory, codexHome: directory,
    runCli,
    account: {
      authMode: "oauth",
      accountId: "account",
      tokens: { idToken: "id", accessToken: "access", refreshToken: "must-not-copy" },
    },
  });
  assert.equal(oauth.source, "online");
  let captured = JSON.parse(await readFile(capturePath, "utf8"));
  assert.equal(captured.executable, executable);
  assert.equal(captured.auth.tokens.refresh_token, "");
  assert.deepEqual(captured.args, ["-c", "cli_auth_credentials_store=\"file\"", "debug", "models"]);

  const apiKey = await fetchOfficialModelCatalog({
    executable,
    dataDir: directory, codexHome: directory,
    runCli,
    account: { authMode: "apiKey", openaiApiKey: "sk-local" },
  });
  assert.equal(apiKey.source, "bundled");
  captured = JSON.parse(await readFile(capturePath, "utf8"));
  assert.equal(captured.auth.OPENAI_API_KEY, "sk-local");
  assert.equal(captured.auth.auth_mode, "apikey");
});

test("账号目录已有在线证明后复用官方同身份的新缓存，不再每次冷启动网络刷新", async t => {
  const directory = await useTempDir(t);
  const executable = join(directory, "codex");
  await writeFile(executable, "fixture");
  let time = Date.parse("2026-10-12T09:00:00Z"), calls = 0;
  const account = { authMode: "oauth", accountId: "account-a",
    tokens: { idToken: "identity-a", accessToken: "access", refreshToken: "never-copy" } };
  const online = { identity: "a".repeat(64), client_version: "0.162.0", fetched_at: new Date(time).toISOString(),
    models: [{ slug: "online-model" }] };
  await writeFile(join(directory, "models_cache.json"), JSON.stringify({ ...online, identity: "b".repeat(64) }));
  const options = { executable, account, dataDir: directory, codexHome: directory, now: () => time,
    async runCli(_file, _args, config) {
      calls++;
      const auth = JSON.parse(await readFile(join(config.cwd, "auth.json"), "utf8"));
      assert.equal(auth.tokens.refresh_token, "");
      await writeFile(join(config.cwd, "models_cache.json"), JSON.stringify(online));
      return { stdout: JSON.stringify({ models: [{ slug: "bundled-model" }] }) };
    } };
  assert.equal((await fetchOfficialModelCatalog(options)).source, "online");
  assert.equal(calls, 1, "没有账号在线证明时不能借用共享目录");
  time += 270_000;
  const updated = { ...online, fetched_at: new Date(time).toISOString(), models: [{ slug: "new-online-model" }] };
  await writeFile(join(directory, "models_cache.json"), JSON.stringify(updated));
  const cached = await fetchOfficialModelCatalog(options);
  assert.equal(cached.source, "cache"); assert.deepEqual(cached.catalog.models, updated.models);
  assert.equal(calls, 1, "计划刷新在官方有效期内复用同账号目录，不重复冷联网");
  await writeFile(join(directory, "models_cache.json"), JSON.stringify({ ...updated, identity: "b".repeat(64) }));
  assert.deepEqual((await fetchOfficialModelCatalog(options)).catalog.models, online.models,
    "共享目录身份变化时仅能使用自己仍有效的目录");
});

test("目录过期、凭据身份或 CLI 变化后不能借用缓存；内置目录不冒充在线成功", async t => {
  const directory = await useTempDir(t), executable = join(directory, "codex");
  await writeFile(executable, "fixture");
  let time = Date.parse("2026-10-12T09:00:00Z"), online = true;
  const account = { authMode: "oauth", accountId: "a", tokens: { idToken: "identity-a", accessToken: "access" } };
  const catalog = { identity: "a".repeat(64), client_version: "0.162.0", fetched_at: new Date(time).toISOString(),
    models: [{ slug: "online-model" }] };
  const options = { executable, account, dataDir: directory, codexHome: directory, now: () => time,
    async runCli(_file, _args, config) {
      if (online) await writeFile(join(config.cwd, "models_cache.json"), JSON.stringify(catalog));
      return { stdout: JSON.stringify({ models: [{ slug: "bundled-model" }] }) };
    } };
  await fetchOfficialModelCatalog(options); online = false;
  await assert.rejects(fetchOfficialModelCatalog({ ...options, account: { ...account, accountId: "b" } }), /未写入/);
  await assert.rejects(fetchOfficialModelCatalog({ ...options, account: { ...account,
    tokens: { ...account.tokens, idToken: "identity-b" } } }), /未写入/);
  const previousBase = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = "https://different-provider.example.test";
  try { await assert.rejects(fetchOfficialModelCatalog(options), /未写入/); }
  finally { if (previousBase == null) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = previousBase; }
  time += 300_000;
  await assert.rejects(fetchOfficialModelCatalog(options), /未写入/);
  time -= 300_000;
  await writeFile(executable, "updated-fixture");
  await assert.rejects(fetchOfficialModelCatalog(options), /未写入/);
});

test("桥接复用有效目录时保留 official-cache 来源，不标成本轮在线检查", async t => {
  const directory = await useTempDir(t), executable = join(directory, "codex");
  await writeFile(executable, "fixture");
  const account = { authMode: "oauth", accountId: "a", tokens: { idToken: "identity-a", accessToken: "access" } };
  const catalog = { identity: "a".repeat(64), client_version: "0.162.0", fetched_at: new Date().toISOString(),
    models: [{ slug: "online-model" }] };
  await fetchOfficialModelCatalog({ executable, account, dataDir: directory, codexHome: directory,
    runCli: async (_file, _args, options) => {
      await writeFile(join(options.cwd, "models_cache.json"), JSON.stringify(catalog));
      return { stdout: JSON.stringify(catalog) };
    } });
  const previous = [process.env.CODEX_HOME, process.env.CODEX_QUOTA_DATA_DIR];
  process.env.CODEX_HOME = directory; process.env.CODEX_QUOTA_DATA_DIR = directory;
  try {
    let applied;
    const result = await refreshCodexModelCatalog({ executable,
      accountManager: { getCurrentModelCatalogAccount: async () => account },
      contextManager: { selectModelCatalogAccount() {}, refresh: async () => {},
        useOfficialCatalog: async (_catalog, options) => { applied = options; return { changed: false }; } },
    });
    assert.equal(result.officialCatalogSource, "cache"); assert.equal(result.officialCatalogChecked, false);
    assert.deepEqual(applied, { source: "official-cache", persist: true });
  } finally {
    for (const [index, key] of ["CODEX_HOME", "CODEX_QUOTA_DATA_DIR"].entries()) {
      if (previous[index] == null) delete process.env[key]; else process.env[key] = previous[index];
    }
  }
});
