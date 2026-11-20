import { spawn } from "node:child_process";
import { resolveCodexCliExecutable } from "./platform/executables.mjs";
import { stopCodex } from "./platform/lifecycle.mjs";

const OFFICIAL_LOGIN_TIMEOUT_MS = 10 * 60_000;
const MAX_DIAGNOSTIC_LENGTH = 8_192;

async function runOfficialCodexLogin({
  executable = null,
  codexHome,
  signal = null,
  timeoutMs = OFFICIAL_LOGIN_TIMEOUT_MS,
  resolveExecutable = resolveCodexCliExecutable,
  spawnProcess = spawn,
} = {}) {
  if (!codexHome) throw new Error("Codex 官方登录缺少凭据目录");
  signal?.throwIfAborted();
  const command = executable ?? await resolveExecutable();
  signal?.throwIfAborted();

  const env = { ...process.env, CODEX_HOME: codexHome };
  const child = spawnProcess(command, ["login"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let diagnostics = "";
  let settled = false;
  let timer = null;
  const appendDiagnostics = (chunk) => {
    diagnostics = `${diagnostics}${String(chunk ?? "")}`.slice(-MAX_DIAGNOSTIC_LENGTH);
  };
  child.stdout?.on("data", appendDiagnostics);
  child.stderr?.on("data", appendDiagnostics);

  try {
    await new Promise((resolve, reject) => {
      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        process.removeListener("exit", onProcessExit);
        if (error) reject(error);
        else resolve();
      };
      const stopLogin = (error) => {
        child.kill();
        finish(error);
      };
      const onAbort = () => stopLogin(new Error("Codex 官方登录已取消"));
      const onProcessExit = () => child.kill();

      signal?.addEventListener("abort", onAbort, { once: true });
      process.once("exit", onProcessExit);
      timer = setTimeout(() => {
        stopLogin(new Error("Codex 官方登录超时，请重新启动注入器后再试"));
      }, timeoutMs);
      child.once("error", (error) => {
        finish(new Error(`无法启动 Codex 官方登录：${error.code ?? error.message}`));
      });
      child.once("close", (code, closeSignal) => {
        if (code === 0) {
          finish();
          return;
        }
        const detail = safeLoginDiagnostic(diagnostics);
        finish(new Error(
          `Codex 官方登录未完成（${code ?? closeSignal ?? "未知退出状态"}）` +
          (detail ? `：${detail}` : ""),
        ));
      });
      if (signal?.aborted) onAbort();
    });
  } finally {
    child.stdout?.removeListener("data", appendDiagnostics);
    child.stderr?.removeListener("data", appendDiagnostics);
  }
}

async function recoverWithOfficialCodexLogin(accountManager, {
  executable = null,
  signal = null,
  stop = stopCodex,
  login = runOfficialCodexLogin,
} = {}) {
  await stop();
  await login({
    executable,
    codexHome: accountManager.codexHome,
    signal,
  });
  await accountManager.syncCurrentAccountFromOfficialCredentials();
  const accountId = accountManager.store.index.currentAccountId;
  const account = accountId ? accountManager.store.get(accountId) : null;
  if (!account || account.authStatus === "needsReauth" || account.authStatus === "transferred") {
    throw new Error("Codex 官方登录已结束，但没有读取到可用的新登录凭据");
  }
  return account;
}

function safeLoginDiagnostic(value) {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^https?:\/\//i.test(line) && !line.includes("auth.openai.com"))
    .slice(-2)
    .join("；")
    .slice(0, 500);
}

export {
  OFFICIAL_LOGIN_TIMEOUT_MS,
  recoverWithOfficialCodexLogin,
  runOfficialCodexLogin,
  safeLoginDiagnostic,
};
