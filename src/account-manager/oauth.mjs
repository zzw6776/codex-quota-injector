import { spawn } from "node:child_process";
import { CLIENT_ID, TOKEN_ENDPOINT } from "./contract.mjs";
import { createOAuthCancelledError } from "./tokens.mjs";

async function exchangeAuthorizationCode(code, verifier, redirectUri, signal) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: CLIENT_ID,
    code_verifier: verifier,
  });
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Token 交换失败 ${response.status}`);
  return {
    idToken: data.id_token ?? "",
    accessToken: data.access_token ?? "",
    refreshToken: data.refresh_token ?? null,
  };
}

function waitForOAuthCallback(server, expectedState, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("OAuth 授权超时，请重试")), timeoutMs);
    const finish = (error, code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      server.removeAllListeners("request");
      if (error) reject(error);
      else resolve(code);
    };
    const onAbort = () => finish(signal.reason ?? createOAuthCancelledError());
    if (signal?.aborted) {
      finish(signal.reason ?? createOAuthCancelledError());
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    server.on("request", (request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== "/auth/callback") {
        response.writeHead(404).end("Not found");
        return;
      }
      if (url.searchParams.get("state") !== expectedState) {
        response.writeHead(400).end("OAuth state mismatch");
        return;
      }
      const code = url.searchParams.get("code");
      const authError = url.searchParams.get("error");
      if (!code) {
        response.writeHead(400).end("Authorization failed");
        finish(new Error(authError || "OAuth 回调缺少 code"));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<!doctype html><meta charset=utf-8><title>授权成功</title><style>body{font:16px -apple-system;display:grid;place-items:center;height:100vh;margin:0;background:#18181f;color:#eee}</style><h2>授权成功，可以关闭此窗口并返回 Codex</h2>");
      finish(null, code);
    });
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function openExternal(url) {
  if (process.platform === "darwin") {
    spawn("/usr/bin/open", [url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  const command = process.platform === "win32" ? "rundll32.exe" : "xdg-open";
  const args = process.platform === "win32"
    ? ["url.dll,FileProtocolHandler", url]
    : [url];
  spawn(command, args, { detached: true, stdio: "ignore" }).unref();
}

function base64Url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

export { exchangeAuthorizationCode, waitForOAuthCallback, listen, closeServer, openExternal, base64Url };
