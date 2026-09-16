import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fetchOfficialModelCatalog } from "../src/official-model-catalog.mjs";
import { useTempDir } from "./helpers.mjs";

test("官方模型目录探测为 OAuth 隔离 refresh token，为 API Key 使用 CLI 输出", async (t) => {
  const directory = await useTempDir(t);
  const executable = "fixture-codex";
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
    runCli,
    account: { authMode: "apiKey", openaiApiKey: "sk-local" },
  });
  assert.equal(apiKey.source, "bundled");
  captured = JSON.parse(await readFile(capturePath, "utf8"));
  assert.equal(captured.auth.OPENAI_API_KEY, "sk-local");
  assert.equal(captured.auth.auth_mode, "apikey");
});
