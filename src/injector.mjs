import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { AccountManager } from "./account-manager.mjs";
import { AppServerClient, selectQuotaWindows, toWidgetQuotas } from "./app-server.mjs";
import { CdpClient, findCodexTarget } from "./cdp-client.mjs";
import {
  widgetDrainActionsExpression,
  widgetInstallExpression,
  widgetUpdateExpression,
} from "./widget.mjs";

const DEFAULT_PORT = 9229;
const TARGET_POLL_MS = 1_500;
const QUOTA_REFRESH_MS = 60_000;
const STARTUP_GRACE_MS = 30_000;
const CHATGPT_APP = "/Applications/ChatGPT.app";
const CHATGPT_EXECUTABLE = `${CHATGPT_APP}/Contents/MacOS/ChatGPT`;
const execFileAsync = promisify(execFile);

export async function runInjector({ port = DEFAULT_PORT, once = false } = {}) {
  const accountManager = new AccountManager();
  await accountManager.initialize();
  let appServer = new AppServerClient();
  let cdp = null;
  let targetId = null;
  let fallbackQuota = null;
  let lastPushedJson = null;
  let activeAction = null;
  let restartingCodex = false;
  let hasSeenCodexProcess = false;
  let stopped = false;
  const startupDeadline = Date.now() + STARTUP_GRACE_MS;

  const stop = () => {
    stopped = true;
    cdp?.close();
    appServer.close();
  };
  const stopAndExit = () => {
    stop();
    setTimeout(() => process.exit(0), 250);
  };
  process.once("SIGINT", stopAndExit);
  process.once("SIGTERM", stopAndExit);

  async function refreshQuotas() {
    if (accountManager.store.list().length > 0) {
      await accountManager.refreshAll();
      return;
    }
    const response = await appServer.readRateLimits();
    fallbackQuota = toWidgetQuotas(selectQuotaWindows(response));
  }

  async function connectAndInject() {
    if (!cdp?.isConnected) {
      const target = await findCodexTarget(port);
      if (!target) return false;
      cdp?.close();
      cdp = new CdpClient(target.webSocketDebuggerUrl);
      await cdp.connect();
      targetId = target.id;
      lastPushedJson = null;
    }
    await cdp.evaluate(widgetInstallExpression());
    const viewModel = accountManager.getViewModel({ fallbackQuota });
    const viewJson = JSON.stringify(viewModel);
    if (viewJson !== lastPushedJson) {
      await cdp.evaluate(widgetUpdateExpression(viewModel));
      lastPushedJson = viewJson;
    }
    return true;
  }

  async function startAction(action) {
    try {
      switch (action?.type) {
        case "oauth-add":
          accountManager.beginOAuthLogin();
          break;
        case "token-add":
          await accountManager.importTokenInput(action.token);
          break;
        case "api-key-add":
          await accountManager.addApiKey(action.apiKey, action.name);
          break;
        case "local-import":
          await accountManager.importLocalAccount();
          break;
        case "refresh-all":
          await accountManager.refreshAllWithOperation();
          break;
        case "switch-account":
          restartingCodex = true;
          try {
            await accountManager.switchAccount(action.accountId);
            appServer.close();
            appServer = new AppServerClient();
            await restartCodex(port);
            cdp?.close();
            cdp = null;
            targetId = null;
            lastPushedJson = null;
          } finally {
            restartingCodex = false;
          }
          break;
        default:
          console.error(`[action] 未知操作: ${action?.type ?? "empty"}`);
      }
    } catch (error) {
      console.error(`[action] ${error.message}`);
    }
  }

  try {
    await refreshQuotas();
  } catch (error) {
    console.error(`[quota] ${error.message}`);
  }
  let nextRefresh = Date.now() + QUOTA_REFRESH_MS;
  while (!stopped) {
    if (!cdp?.isConnected && !restartingCodex) {
      const codexRunning = await isCodexRunning();
      if (codexRunning) {
        hasSeenCodexProcess = true;
      } else if (hasSeenCodexProcess || Date.now() >= startupDeadline) {
        console.log("[lifecycle] Codex 已退出，注入器同步停止");
        stopAndExit();
        break;
      }
    }
    if (Date.now() >= nextRefresh) {
      try {
        await refreshQuotas();
      } catch (error) {
        console.error(`[quota] ${error.message}`);
      }
      nextRefresh = Date.now() + QUOTA_REFRESH_MS;
    }
    try {
      const injected = await connectAndInject();
      if (injected && !activeAction) {
        const actions = await cdp.evaluate(widgetDrainActionsExpression());
        if (Array.isArray(actions) && actions.length > 0) {
          activeAction = (async () => {
            for (const action of actions) await startAction(action);
          })().finally(() => {
            activeAction = null;
          });
        }
      }
      if (injected && once) break;
    } catch (error) {
      if (once) throw error;
      cdp?.close();
      cdp = null;
      targetId = null;
    }
    await delay(TARGET_POLL_MS);
  }

  if (once) {
    stop();
    return accountManager.getViewModel({ fallbackQuota });
  }
  stop();
}

async function isCodexRunning() {
  if (process.platform !== "darwin") return true;
  return (await findCodexProcessIds()).length > 0;
}

async function restartCodex(port) {
  if (process.platform !== "darwin") {
    throw new Error("账号已写入，但当前系统不支持自动重启 Codex");
  }
  const processIds = await findCodexProcessIds();
  for (const processId of processIds) {
    try {
      process.kill(processId, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if ((await findCodexProcessIds()).length === 0) break;
    await delay(250);
  }
  await execFileAsync("/usr/bin/open", [
    "-na",
    CHATGPT_APP,
    "--args",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
  ]);
}

async function findCodexProcessIds() {
  const { stdout } = await execFileAsync("/bin/ps", ["-axww", "-o", "pid=,comm="]);
  return parseCodexProcessIds(stdout);
}

function parseCodexProcessIds(processList) {
  const processIds = [];
  for (const line of processList.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (match?.[2] === CHATGPT_EXECUTABLE) {
      processIds.push(Number(match[1]));
    }
  }
  return processIds;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { DEFAULT_PORT, isCodexRunning, parseCodexProcessIds, restartCodex };
