import { USAGE_URL, ACCOUNT_CHECK_URL, SUBSCRIPTIONS_URL, USER_AGENT } from "./contract.mjs";
import { createHttpError } from "./tokens.mjs";

async function fetchQuota(account) {
  const response = await fetch(USAGE_URL, {
    headers: apiHeaders(account),
    signal: AbortSignal.timeout(25_000),
  });
  const body = await response.text();
  if (!response.ok) throw createHttpError(`额度接口返回 ${response.status}`, response.status);
  const usage = JSON.parse(body);
  const windows = [
    usage.rate_limit?.primary_window,
    usage.rate_limit?.secondary_window,
  ]
    .filter(Boolean)
    .map(normalizeUsageWindow);
  const credits = normalizeCredits(usage.credits);
  return { windows, planType: usage.plan_type ?? null, credits };
}

async function fetchSubscription(account) {
  const timezoneOffsetMin = new Date().getTimezoneOffset();
  const checkUrl = new URL(ACCOUNT_CHECK_URL);
  checkUrl.searchParams.set("timezone_offset_min", String(timezoneOffsetMin));
  const response = await fetch(checkUrl, {
    headers: apiHeaders(account, checkUrl.pathname),
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw createHttpError(`订阅接口返回 ${response.status}`, response.status);
  const payload = await response.json();
  let snapshot = parseAccountCheck(payload, account.accountId);
  if (snapshot.subscriptionActiveUntil || !snapshot.accountId) return snapshot;

  const subscriptions = new URL(SUBSCRIPTIONS_URL);
  subscriptions.searchParams.set("account_id", snapshot.accountId);
  const fallback = await fetch(subscriptions, {
    headers: apiHeaders(account, subscriptions.pathname),
    signal: AbortSignal.timeout(25_000),
  });
  if (!fallback.ok) return snapshot;
  const data = await fallback.json();
  return {
    accountId: snapshot.accountId,
    planType: data.subscription_plan ?? data.plan_type ?? snapshot.planType,
    subscriptionActiveUntil: data.active_until ?? data.expires_at ?? null,
  };
}

function normalizeCredits(credits) {
  if (!credits || typeof credits !== "object") return null;
  const hasCredits = Boolean(credits.has_credits || credits.hasCredits);
  const unlimited = Boolean(credits.unlimited);
  const rawBalance = credits.balance != null ? Number(credits.balance) : null;
  const balance = Number.isFinite(rawBalance) ? rawBalance : null;
  const creditQuantity = balance != null ? Math.floor(balance) : null;
  const usdAmount = creditQuantity != null ? Number((creditQuantity * 0.04).toFixed(2)) : null;
  const formattedUsd = usdAmount != null ? `US$${usdAmount.toFixed(2)}` : null;
  return {
    hasCredits,
    unlimited,
    balance,
    creditQuantity,
    usdAmount,
    formattedUsd,
  };
}

function normalizeUsageWindow(window) {
  const used = clampPercent(window.used_percent);
  const minutes = Number.isFinite(window.limit_window_seconds)
    ? Math.ceil(window.limit_window_seconds / 60)
    : null;
  const resetsAt = Number.isFinite(window.reset_at)
    ? window.reset_at
    : Number.isFinite(window.reset_after_seconds)
      ? Math.floor(Date.now() / 1000) + window.reset_after_seconds
      : null;
  const label = formatWindow(minutes);
  return {
    label,
    compactLabel: label,
    usedPercent: used,
    remainingPercent: 100 - used,
    resetsAt,
    windowDurationMins: minutes,
  };
}

function formatWindow(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return "Usage";
  if (minutes >= 10_079) return "Weekly";
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function apiHeaders(account, targetPath = "/backend-api/wham/usage") {
  const headers = {
    Authorization: `Bearer ${account.tokens.accessToken}`,
    Accept: "application/json",
    Referer: "https://chatgpt.com/",
    "User-Agent": USER_AGENT,
    "x-openai-target-path": targetPath,
    "x-openai-target-route": targetPath,
  };
  if (account.accountId) headers["ChatGPT-Account-Id"] = account.accountId;
  return headers;
}

function parseAccountCheck(payload, preferredAccountId) {
  const source = payload?.accounts;
  const records = Array.isArray(source)
    ? source
    : source && typeof source === "object"
      ? Object.entries(source).map(([key, value]) => ({ ...value, __key: key }))
      : [];
  const selected = preferredAccountId ? records.find((record) => {
    const node = record.account ?? record;
    return [node.account_id, node.id, node.chatgpt_account_id, node.workspace_id, record.__key]
      .filter(Boolean)
      .includes(preferredAccountId);
  }) : records[0];
  if (!selected) {
    return { accountId: null, planType: null, subscriptionActiveUntil: null };
  }
  const account = selected.account ?? selected;
  const entitlement = selected.entitlement ?? {};
  return {
    accountId:
      preferredAccountId ?? account.account_id ?? account.id ??
      account.chatgpt_account_id ?? account.workspace_id ?? selected.__key ?? null,
    planType: entitlement.subscription_plan ?? account.plan_type ?? account.planType ?? null,
    subscriptionActiveUntil: entitlement.expires_at ?? account.expires_at ?? null,
  };
}

function clampPercent(value) {
  return Math.min(100, Math.max(0, Math.round(Number(value) || 0)));
}

export { fetchQuota, fetchSubscription, normalizeUsageWindow, parseAccountCheck };
