import { AccountManager } from "./account-manager.mjs";
import { CdpClient, findCodexTarget } from "./cdp-client.mjs";
import { isCodexRunning, restartCodex } from "./platform.mjs";
import {
  widgetDrainActionsExpression,
  widgetInstallExpression,
  widgetUpdateExpression,
} from "./widget.mjs";

const DEFAULT_PORT = 9229;
const TARGET_POLL_MS = 1_500;
const QUOTA_REFRESH_MS = 60_000;
const STARTUP_GRACE_MS = 30_000;

export async function runInjector({ port = DEFAULT_PORT, once = false } = {}) {
  const accountManager = new AccountManager();
  await accountManager.initialize();
  let cdp = null;
  let targetId = null;
  let lastPushedJson = null;
  let activeAction = null;
  let restartingCodex = false;
  let hasSeenCodexProcess = false;
  let stopped = false;
  let stopping = false;
  let quotaRefreshTimer = null;
  let quotaRefreshPromise = null;
  let quotaRefreshRequested = false;
  const startupDeadline = Date.now() + STARTUP_GRACE_MS;

  const stop = () => {
    stopped = true;
    clearTimeout(quotaRefreshTimer);
    quotaRefreshTimer = null;
    cdp?.close();
    accountManager.close();
  };
  const stopAndExit = async () => {
    if (stopping) return;
    stopping = true;
    await accountManager.syncCurrentAccountFromOfficialCredentials().catch((error) => {
      console.error(`[lifecycle] 退出前同步 Codex 凭证失败: ${error.message}`);
    });
    stop();
    setTimeout(() => process.exit(0), 250);
  };
  process.once("SIGINT", () => void stopAndExit());
  process.once("SIGTERM", () => void stopAndExit());

  async function refreshQuotas() {
    if (accountManager.store.list().length > 0) {
      await accountManager.refreshAll();
    }
  }

  function scheduleQuotaRefresh(delayMs = QUOTA_REFRESH_MS) {
    clearTimeout(quotaRefreshTimer);
    if (stopped) return;
    quotaRefreshTimer = setTimeout(() => {
      quotaRefreshTimer = null;
      void runQuotaRefresh({ repeatIfRunning: true });
    }, delayMs);
  }

  async function runQuotaRefresh({ repeatIfRunning = false } = {}) {
    if (quotaRefreshPromise) {
      if (repeatIfRunning) quotaRefreshRequested = true;
      return quotaRefreshPromise;
    }
    const task = (async () => {
      do {
        quotaRefreshRequested = false;
        try {
          await refreshQuotas();
        } catch (error) {
          console.error(`[quota] ${error.message}`);
        }
      } while (quotaRefreshRequested && !stopped);
    })()
      .finally(() => {
        if (quotaRefreshPromise === task) quotaRefreshPromise = null;
        scheduleQuotaRefresh();
      });
    quotaRefreshPromise = task;
    return task;
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
    const viewModel = accountManager.getViewModel();
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
        case "oauth-cancel":
          accountManager.cancelOAuthLogin();
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
        case "export-all":
          await accountManager.exportAccounts();
          break;
        case "refresh-all":
          await accountManager.refreshAllWithOperation();
          break;
        case "switch-account":
          restartingCodex = true;
          try {
            await accountManager.switchAccount(action.accountId);
            await restartCodex(port);
            cdp?.close();
            cdp = null;
            targetId = null;
            lastPushedJson = null;
            scheduleQuotaRefresh(0);
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

  if (once) {
    await runQuotaRefresh();
  } else {
    accountManager.startOfficialCredentialWatch(() => {
      void runQuotaRefresh({ repeatIfRunning: true });
    });
    void runQuotaRefresh();
  }
  while (!stopped) {
    if (!cdp?.isConnected && !restartingCodex) {
      const codexRunning = await isCodexRunning();
      if (codexRunning) {
        hasSeenCodexProcess = true;
      } else if (hasSeenCodexProcess || Date.now() >= startupDeadline) {
        console.log("[lifecycle] Codex 已退出，注入器同步停止");
        await stopAndExit();
        break;
      }
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
    return accountManager.getViewModel();
  }
  stop();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { DEFAULT_PORT };
