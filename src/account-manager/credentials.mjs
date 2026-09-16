import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { execFileAsync, atomicWrite, sha256 } from "./contract.mjs";
import { decodeJwt } from "./tokens.mjs";

async function writeOfficialCredentials(
  codexHome,
  account,
  { syncKeychain = process.platform === "darwin", strictKeychain = false } = {},
) {
  const payload = account.authMode === "apiKey"
    ? { auth_mode: "apikey", OPENAI_API_KEY: account.openaiApiKey }
    : account.tokens.idToken || account.tokens.refreshToken
      ? {
          OPENAI_API_KEY: null,
          tokens: {
            id_token: account.tokens.idToken,
            access_token: account.tokens.accessToken,
            refresh_token: account.tokens.refreshToken ?? "",
            account_id: account.accountId,
          },
          last_refresh: new Date().toISOString(),
        }
      : { OPENAI_API_KEY: null, personal_access_token: account.tokens.accessToken };
  await writeOfficialCredentialPayload(codexHome, payload, {
    syncKeychain: syncKeychain && account.authMode === "oauth",
    strictKeychain,
  });
}

async function clearOfficialCredentials(
  codexHome,
  { syncKeychain = process.platform === "darwin" } = {},
) {
  await writeOfficialCredentialPayload(codexHome, { OPENAI_API_KEY: null }, {
    syncKeychain,
    strictKeychain: true,
  });
}

async function writeOfficialCredentialPayload(
  codexHome,
  payload,
  { syncKeychain = false, strictKeychain = false } = {},
) {
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await atomicWrite(join(codexHome, "auth.json"), `${JSON.stringify(payload, null, 2)}\n`);
  if (!syncKeychain) return;
  try {
    const resolved = await realpath(codexHome).catch(() => codexHome);
    const keychainAccount = `cli|${sha256(resolved).slice(0, 16)}`;
    await execFileAsync("/usr/bin/security", [
      "add-generic-password",
      "-U",
      "-s",
      "Codex Auth",
      "-a",
      keychainAccount,
      "-w",
      JSON.stringify(payload),
    ]);
  } catch (error) {
    if (strictKeychain) throw new Error(`Codex 钥匙串清理失败：${error.message}`);
    console.error(`[switch] Keychain 更新失败，已保留 auth.json: ${error.message}`);
  }
}

function matchOfficialAccount(credentials, accounts) {
  if (!credentials || typeof credentials !== "object") return undefined;

  const apiKey = typeof credentials.OPENAI_API_KEY === "string"
    ? credentials.OPENAI_API_KEY.trim()
    : "";
  if (apiKey) {
    return accounts.find((account) =>
      account.authMode === "apiKey" && account.openaiApiKey === apiKey
    ) ?? null;
  }

  const tokens = credentials.tokens && typeof credentials.tokens === "object"
    ? credentials.tokens
    : {};
  const idToken = tokens.id_token ?? tokens.idToken ?? "";
  const accessToken =
    tokens.access_token ?? tokens.accessToken ?? credentials.personal_access_token ?? "";
  const idClaims = decodeJwt(idToken) ?? {};
  const accessClaims = decodeJwt(accessToken) ?? {};
  const auth = idClaims["https://api.openai.com/auth"] ??
    accessClaims["https://api.openai.com/auth"] ?? {};
  const profile = accessClaims["https://api.openai.com/profile"] ?? {};
  const accountId = tokens.account_id ?? tokens.accountId ?? auth.chatgpt_account_id ?? null;
  const email = idClaims.email ?? profile.email ?? auth.email ?? null;

  if (!accountId && !email && !accessToken) return undefined;

  if (accountId) {
    // The same email may belong to several workspaces; never borrow its other credentials.
    return accounts.find((account) => account.accountId === accountId) ?? null;
  }
  if (email) {
    const normalizedEmail = String(email).trim().toLowerCase();
    const byEmail = accounts.find((account) =>
      account.email.trim().toLowerCase() === normalizedEmail
    );
    if (byEmail) return byEmail;
  }
  if (accessToken) {
    return accounts.find((account) => account.tokens.accessToken === accessToken) ?? null;
  }
  return null;
}

export { writeOfficialCredentials, matchOfficialAccount, clearOfficialCredentials };
