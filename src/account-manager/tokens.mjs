import { CLIENT_ID, TOKEN_ENDPOINT, TOKEN_REFRESH_LEAD_SECONDS } from "./contract.mjs";

async function refreshTokens(refreshToken, currentIdToken = "") {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    signal: AbortSignal.timeout(25_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = body.error?.code ?? body.error ?? "unknown";
    const error = new Error(`Token 刷新失败 ${response.status}: ${code}`);
    error.code = String(code);
    error.status = response.status;
    throw error;
  }
  if (!body.access_token) throw new Error("Token 刷新响应缺少 access_token");
  return {
    idToken: body.id_token ?? currentIdToken ?? "",
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? refreshToken,
  };
}

function decodeJwt(token) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function jwtExpiration(token) {
  const value = decodeJwt(token)?.exp;
  return Number.isFinite(value) ? value : null;
}

function sameTokens(left = {}, right = {}) {
  return left.idToken === right.idToken &&
    left.accessToken === right.accessToken &&
    left.refreshToken === right.refreshToken;
}

function isPermanentRefreshError(error) {
  const code = String(error?.code ?? "").toLowerCase();
  return code === "refresh_token_reused" ||
    code === "invalid_grant" ||
    code === "refresh_token_missing" ||
    code === "temporary_token_expired" ||
    (error?.status === 401 && String(error?.message ?? "").startsWith("Token 刷新失败"));
}

function createTemporaryTokenExpiredError(account) {
  const error = new Error(`${account.email} 的临时凭据已过期，需要重新导入或授权`);
  error.code = "temporary_token_expired";
  return error;
}

function isAuthenticationError(message) {
  const value = String(message ?? "");
  return value.includes("refresh_token_reused") ||
    value.includes("登录凭证已失效") ||
    value.includes("需要重新授权") ||
    value.includes("Token 刷新失败");
}

function createHttpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function createOAuthCancelledError() {
  const error = new Error("OpenAI OAuth 授权已取消");
  error.code = "CODEX_QUOTA_OAUTH_CANCELLED";
  return error;
}

async function ensureFreshTokens(store, account, { refreshIfExpirationUnknown = false } = {}) {
    if (account.authStatus === "transferred") {
      throw new Error(`${account.email} 已转出，请先恢复`);
    }
    if (account.authStatus === "needsReauth") {
      throw new Error(`${account.email} 的登录凭证已失效，需要重新授权`);
    }
    const expiration = jwtExpiration(account.tokens.accessToken);
    if (account.authStatus === "temporary") {
      if (expiration == null || expiration <= Math.floor(Date.now() / 1000)) {
        throw createTemporaryTokenExpiredError(account);
      }
      return account;
    }
    if (expiration == null) {
      if (refreshIfExpirationUnknown && account.tokens.refreshToken) {
        return refreshStoredTokens(store, account);
      }
      return account;
    }
    if (expiration > Math.floor(Date.now() / 1000) + TOKEN_REFRESH_LEAD_SECONDS) {
      return account;
    }
    return refreshStoredTokens(store, account);
  }

async function refreshStoredTokens(store, account) {
    if (account.authStatus === "transferred") {
      throw new Error(`${account.email} 已转出，请先恢复`);
    }
    if (!account.tokens.refreshToken) {
      const error = new Error(`${account.email} 的登录已过期，需要重新添加或授权`);
      error.code = "refresh_token_missing";
      throw error;
    }
    const tokens = await refreshTokens(account.tokens.refreshToken, account.tokens.idToken);
    return store.update(account.id, (latest) => ({
      tokens,
      authStatus: "active",
      tokenGeneration: (latest.tokenGeneration ?? 0) + 1,
    }));
  }

export { refreshTokens, jwtExpiration, sameTokens, isPermanentRefreshError, createTemporaryTokenExpiredError, createOAuthCancelledError, ensureFreshTokens, refreshStoredTokens, createHttpError, decodeJwt, isAuthenticationError };
