export const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";

export async function fetchDeepSeekBalance({ apiKey, fetchImpl = fetch, signal } = {}) {
  const key = String(apiKey ?? "").trim();
  if (!key) throw new Error("请先填写并保存 DeepSeek API Key");
  const response = await fetchImpl(DEEPSEEK_BALANCE_URL, {
    method: "GET",
    headers: { Authorization: `Bearer ${key}` },
    signal,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload?.error?.message ?? payload?.message ?? `HTTP ${response.status}`;
    throw new Error(`余额查询失败：${detail}`);
  }
  if (!payload || !Array.isArray(payload.balance_infos)) {
    throw new Error("余额查询失败：返回数据格式不正确");
  }
  return {
    available: Boolean(payload.is_available),
    items: payload.balance_infos.map((item) => ({
      currency: String(item.currency ?? ""),
      totalBalance: String(item.total_balance ?? ""),
      grantedBalance: String(item.granted_balance ?? ""),
      toppedUpBalance: String(item.topped_up_balance ?? ""),
    })),
  };
}
