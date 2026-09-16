import { TRANSFER_KIND, TRANSFER_VERSION, TRANSFER_MODES } from "./contract.mjs";

function parseCredentialInput(rawInput) {
  const input = String(rawInput ?? "").trim();
  if (!input) return { tokens: [], apiKeys: [], transfer: null };
  let value;
  try {
    value = JSON.parse(input);
  } catch {
    if (input.startsWith("at-") || input.split(".").length === 3) {
      return {
        tokens: [{ idToken: "", accessToken: input, refreshToken: null }],
        apiKeys: [],
        transfer: null,
      };
    }
    return {
      tokens: [{ idToken: "", accessToken: "", refreshToken: input }],
      apiKeys: [],
      transfer: null,
    };
  }
  let transfer = null;
  if (value?.kind === TRANSFER_KIND) {
    if (value.version !== TRANSFER_VERSION) {
      throw new Error(`不支持的账号迁移文件版本 ${value.version ?? "unknown"}`);
    }
    if (!TRANSFER_MODES.has(value.mode)) throw new Error("账号迁移文件模式无效");
    if (!Array.isArray(value.accounts)) throw new Error("账号迁移文件缺少账号列表");
    transfer = { mode: value.mode, exportedAt: value.exportedAt ?? null };
  }
  const items = Array.isArray(value)
    ? value
    : Array.isArray(value?.accounts)
      ? value.accounts
      : [value];
  const parsed = { tokens: [], apiKeys: [], transfer };
  for (const item of items) {
    const apiKey = item?.OPENAI_API_KEY ?? item?.openaiApiKey ?? item?.openai_api_key;
    if (typeof apiKey === "string" && apiKey.trim()) {
      parsed.apiKeys.push({
        apiKey: apiKey.trim(),
        name: String(item?.email ?? item?.name ?? item?.accountName ?? "API Key"),
      });
    }
    const tokens = item?.tokens ?? item?.auth?.tokens ?? item;
    const personal = item?.personal_access_token ?? item?.accessToken;
    const accessToken = tokens?.access_token ?? tokens?.accessToken ?? personal ?? "";
    const idToken = tokens?.id_token ?? tokens?.idToken ?? "";
    const refreshToken = tokens?.refresh_token ?? tokens?.refreshToken ?? null;
    const accountId = tokens?.account_id ?? tokens?.accountId ??
      item?.account_id ?? item?.accountId ?? null;
    const temporaryExpiresAt = Number(
      item?.temporary_expires_at ?? item?.temporaryExpiresAt,
    ) || null;
    if (accessToken || refreshToken) {
      parsed.tokens.push({
        idToken,
        accessToken,
        refreshToken,
        accountId,
        ...(temporaryExpiresAt ? { temporaryExpiresAt } : {}),
      });
    }
  }
  return parsed;
}

function parseTokenInput(rawInput) {
  return parseCredentialInput(rawInput).tokens;
}

export { parseCredentialInput, parseTokenInput };
