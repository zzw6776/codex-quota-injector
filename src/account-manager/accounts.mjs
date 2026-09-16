import { sha256 } from "./contract.mjs";
import { decodeJwt, jwtExpiration, isAuthenticationError } from "./tokens.mjs";
import { canExportAccount } from "./transfer.mjs";

function toPublicAccount(account, current) {
  return {
    id: account.id,
    email: account.email,
    authMode: account.authMode,
    planType: account.planType,
    subscriptionActiveUntil: account.subscriptionActiveUntil,
    windows: account.quota?.windows ?? [],
    credits: account.quota?.credits ?? null,
    quotaUpdatedAt: account.quotaUpdatedAt,
    quotaError: account.quotaError,
    authStatus: account.authStatus,
    transferredAt: account.transferredAt,
    temporaryExpiresAt: account.temporaryExpiresAt,
    canTransfer: canExportAccount(account, "handoff"),
    canTemporaryTransfer: canExportAccount(account, "temporary"),
    current,
  };
}

async function upsertOAuthTokens(store, tokens, existingAccount = null, { authStatus = null, temporaryExpiresAt = null } = {}) {
    if (!tokens.accessToken) throw new Error("OAuth 凭据缺少 access_token");
    const idClaims = decodeJwt(tokens.idToken) ?? {};
    const accessClaims = decodeJwt(tokens.accessToken) ?? {};
    const auth = idClaims["https://api.openai.com/auth"] ??
      accessClaims["https://api.openai.com/auth"] ?? {};
    const profile = accessClaims["https://api.openai.com/profile"] ?? {};
    const email = idClaims.email ?? profile.email ?? auth.email;
    if (!email) throw new Error("无法从凭据中识别账号邮箱");
    // auth.json can explicitly select a workspace different from the JWT default.
    const accountId = tokens.accountId ?? auth.chatgpt_account_id ?? null;
    const organizationId = auth.chatgpt_organization_id ?? auth.organization_id ?? null;
    const existing = existingAccount ?? store.list().find((account) =>
      (accountId && account.accountId === accountId) ||
      (!accountId && account.email.toLowerCase() === String(email).toLowerCase()),
    );
    if (authStatus === "temporary" && existing?.authStatus === "active" &&
      existing.authMode === "oauth" && existing.tokens.refreshToken) {
      return existing;
    }
    const id = existing?.id ?? `codex_${sha256(
      `${email}:${accountId ?? ""}:${organizationId ?? ""}`,
    ).slice(0, 32)}`;
    const nextAuthStatus = authStatus ??
      (existing?.authStatus === "temporary" && !tokens.refreshToken ? "temporary" : "active");
    return store.upsert({
      id,
      email,
      authMode: "oauth",
      tokens: {
        idToken: tokens.idToken || existing?.tokens.idToken || "",
        accessToken: tokens.accessToken,
        refreshToken: nextAuthStatus === "temporary"
          ? null
          : tokens.refreshToken ?? existing?.tokens.refreshToken ?? null,
      },
      accountId: accountId ?? existing?.accountId ?? null,
      organizationId: organizationId ?? existing?.organizationId ?? null,
      planType: auth.chatgpt_plan_type ?? existing?.planType ?? null,
      authStatus: nextAuthStatus,
      transferredAt: null,
      temporaryExpiresAt: nextAuthStatus === "temporary"
        ? temporaryExpiresAt ?? jwtExpiration(tokens.accessToken)
        : null,
      quotaError: isAuthenticationError(existing?.quotaError) ? null : existing?.quotaError,
      tokenGeneration: (existing?.tokenGeneration ?? 0) + 1,
    });
  }

async function upsertApiKey(store, apiKey, accountName = "API Key") {
    const key = String(apiKey ?? "").trim();
    if (!key) throw new Error("API Key 不能为空");
    return store.upsert({
      id: `apikey_${sha256(key).slice(0, 32)}`,
      email: String(accountName ?? "API Key").trim() || "API Key",
      authMode: "apiKey",
      openaiApiKey: key,
      planType: "API_KEY",
      tokens: {},
      authStatus: "active",
      transferredAt: null,
      temporaryExpiresAt: null,
    });
  }

export { toPublicAccount, upsertOAuthTokens, upsertApiKey };
