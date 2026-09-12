const HTTPS_URL = /https:\/\/[^\s<>"'`]+/giu;
const TRAILING_PUNCTUATION = /[),.;!?，。；！、]+$/u;

export function findOfficialAppServerUrl(text) {
  if (typeof text !== "string") return null;
  for (const match of text.match(HTTPS_URL) ?? []) {
    const candidate = match.replace(TRAILING_PUNCTUATION, "");
    let url;
    try { url = new URL(candidate); }
    catch { continue; }
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    if (!path.includes("app-server") && !path.includes("app_server")) continue;
    if (host === "developers.openai.com" || host === "learn.chatgpt.com") return url.href;
    if (host === "github.com" && path.startsWith("/openai/codex/")) return url.href;
  }
  return null;
}
