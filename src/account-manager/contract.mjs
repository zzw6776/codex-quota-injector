import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, createHash } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const execFileAsync = promisify(execFile);

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

const AUTH_ENDPOINT = "https://auth.openai.com/oauth/authorize";

const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

const ACCOUNT_CHECK_URL = "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27";

const SUBSCRIPTIONS_URL = "https://chatgpt.com/backend-api/subscriptions";

const OAUTH_CALLBACK_PORT = 1455;

const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

const SUBSCRIPTION_REFRESH_MS = 12 * 60 * 60 * 1000;

const TOKEN_REFRESH_LEAD_SECONDS = 5 * 60;

const OFFICIAL_SYNC_DEBOUNCE_MS = 250;

const TRANSFER_KIND = "codex-account-transfer";

const TRANSFER_VERSION = 2;

const TRANSFER_MODES = new Set(["temporary", "handoff"]);

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(temp, content, { mode: 0o600 });
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function resolveCodexHome() {
  const configured = String(process.env.CODEX_HOME ?? "").trim().replace(/^['"]|['"]$/g, "");
  return configured || join(homedir(), ".codex");
}

export { CLIENT_ID, AUTH_ENDPOINT, OAUTH_CALLBACK_PORT, OAUTH_TIMEOUT_MS, SUBSCRIPTION_REFRESH_MS, OFFICIAL_SYNC_DEBOUNCE_MS, sha256, resolveCodexHome, USAGE_URL, ACCOUNT_CHECK_URL, SUBSCRIPTIONS_URL, TOKEN_ENDPOINT, execFileAsync, atomicWrite, USER_AGENT, TRANSFER_KIND, TRANSFER_VERSION, TRANSFER_MODES, TOKEN_REFRESH_LEAD_SECONDS };
