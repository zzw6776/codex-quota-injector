const HTTPS_URL = /https:\/\/[^\s<>"'`]+/giu;
const TRAILING_PUNCTUATION = /[),.;!?，。；！、]+$/u;

export function findOfficialAppServerUrl(text) {
  return findHttpsUrl(text, (url) => {
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    if (!path.includes("app-server") && !path.includes("app_server")) return false;
    return host === "developers.openai.com" || host === "learn.chatgpt.com" ||
      (host === "github.com" && path.startsWith("/openai/codex/"));
  });
}

// The backend smoke test verifies live search and an official source, not a
// documentation URL convention. Desktop search/open/find has a separate contract.
export function findOfficialSearchSourceUrl(text) {
  return findHttpsUrl(text, (url) => {
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    return host === "openai.com" || host === "developers.openai.com" ||
      host === "learn.chatgpt.com" ||
      (host === "github.com" && (path === "/openai/codex" || path.startsWith("/openai/codex/")));
  });
}

function findHttpsUrl(text, accepts) {
  if (typeof text !== "string") return null;
  for (const match of text.match(HTTPS_URL) ?? []) {
    const candidate = match.replace(TRAILING_PUNCTUATION, "");
    let url;
    try { url = new URL(candidate); }
    catch { continue; }
    if (accepts(url)) return url.href;
  }
  return null;
}
