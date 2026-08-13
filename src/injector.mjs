import { AccountManager } from "./account-manager.mjs";
import { CdpClient, findCodexTarget } from "./cdp-client.mjs";
import { CodexContextManager } from "./codex-context.mjs";
import { prepareCodexLaunch } from "./codex-bridge.mjs";
import { DeepSeekManager } from "./deepseek-manager.mjs";
import { isCodexRunning, restartCodex } from "./platform.mjs";
import { TokenUsageManager } from "./token-usage.mjs";
import {
  widgetDrainActionsExpression,
  widgetInstallExpression,
  widgetUpdateExpression,
} from "./widget.mjs";

const DEFAULT_PORT = 9229;
const TARGET_POLL_MS = 1_500;
const QUOTA_REFRESH_MS = 60_000;
const DEEPSEEK_BALANCE_REFRESH_MS = 5 * 60_000;
const STARTUP_GRACE_MS = 30_000;

export async function runInjector({
  port = DEFAULT_PORT,
  once = false,
  accountManager = new AccountManager(),
  contextManager = new CodexContextManager(),
  deepSeekManager = new DeepSeekManager(),
  tokenUsageManager = new TokenUsageManager(),
  managersInitialized = false,
  prepareLaunch = () => prepareCodexLaunch({ deepSeekManager, contextManager }),
} = {}) {
  await accountManager.initialize();
  if (!managersInitialized) {
    await contextManager.initialize();
    await deepSeekManager.initialize();
  }
  const tokenInitialization = tokenUsageManager.initialize().catch((error) => {
    console.error(`[token-usage] 初始化失败: ${error.message}`);
  });
  if (once) await tokenInitialization;
  let cdp = null;
  let targetId = null;
  let widgetInstalled = false;
  let lastPushedJson = null;
  let widgetUpdatePromise = null;
  let widgetUpdateRequested = false;
  let removeTokenUsageListener = () => {};
  let activeAction = null;
  let restartingCodex = false;
  let hasSeenCodexProcess = false;
  let stopped = false;
  let stopping = false;
  let quotaRefreshTimer = null;
  let quotaRefreshPromise = null;
  let quotaRefreshRequested = false;
  let deepSeekBalanceTimer = null;
  const startupDeadline = Date.now() + STARTUP_GRACE_MS;

  const stop = () => {
    stopped = true;
    clearTimeout(quotaRefreshTimer);
    clearTimeout(deepSeekBalanceTimer);
    quotaRefreshTimer = null;
    removeTokenUsageListener();
    removeTokenUsageListener = () => {};
    cdp?.close();
    accountManager.close();
    deepSeekManager.close();
    tokenUsageManager.close();
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
      widgetInstalled = false;
      await contextManager.refresh();
    }
    if (!widgetInstalled) {
      await cdp.evaluate(widgetInstallExpression());
      widgetInstalled = true;
    }
    const tokenRefresh = tokenUsageManager.refresh().catch((error) => {
      console.error(`[token-usage] 刷新失败: ${error.message}`);
    });
    if (once) await tokenRefresh;
    void tokenRefresh
      .then(() => {
        if (!once) return requestWidgetUpdate();
        return undefined;
      })
      .catch((error) => {
        console.error(`[token-usage] 实时 Widget 刷新失败: ${error.message}`);
      });
    await requestWidgetUpdate();
    return true;
  }

  async function pushWidgetViewModel() {
    const currentCdp = cdp;
    if (!currentCdp?.isConnected || stopped) return false;
    const viewModel = {
      ...accountManager.getViewModel(),
      context: contextManager.getViewModel(),
      deepSeek: deepSeekManager.getViewModel(),
      tokenUsage: tokenUsageManager.getViewModel(),
    };
    const viewJson = JSON.stringify(viewModel);
    if (viewJson !== lastPushedJson) {
      await currentCdp.evaluate(widgetUpdateExpression(viewModel));
      if (cdp === currentCdp) lastPushedJson = viewJson;
    }
    return cdp === currentCdp;
  }

  function requestWidgetUpdate() {
    widgetUpdateRequested = true;
    if (widgetUpdatePromise) return widgetUpdatePromise;
    const task = (async () => {
      do {
        widgetUpdateRequested = false;
        await pushWidgetViewModel();
      } while (widgetUpdateRequested && !stopped);
    })().finally(() => {
      if (widgetUpdatePromise === task) widgetUpdatePromise = null;
    });
    widgetUpdatePromise = task;
    return task;
  }

  removeTokenUsageListener = tokenUsageManager.onChange(() => {
    void requestWidgetUpdate().catch((error) => {
      console.error(`[token-usage] 事件驱动 Widget 刷新失败: ${error.message}`);
    });
  });

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
        case "remove-account":
          await accountManager.removeAccount(action.accountId);
          break;
        case "context-refresh":
          await contextManager.refresh();
          break;
        case "context-save":
          await contextManager.setOverride(
            action.slug,
            action.contextWindow,
            action.maxContextWindow,
          );
          break;
        case "context-reset":
          await contextManager.resetOverride(action.slug);
          break;
        case "context-reset-all":
          await contextManager.resetAll();
          break;
        case "deepseek-save":
          await deepSeekManager.save({ apiKey: action.apiKey, enabled: action.enabled });
          await restartForConfigurationChange();
          break;
        case "deepseek-remove":
          await deepSeekManager.remove();
          await restartForConfigurationChange();
          break;
        case "deepseek-refresh-balance":
          await deepSeekManager.refreshBalance();
          break;
        case "switch-account":
          restartingCodex = true;
          try {
            await accountManager.switchAccount(action.accountId);
            await restartCodex(port, await prepareLaunch());
            cdp?.close();
            cdp = null;
            targetId = null;
            widgetInstalled = false;
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
      if (String(action?.type ?? "").startsWith("context-")) {
        contextManager.setError(error.message);
      }
      if (String(action?.type ?? "").startsWith("deepseek-") &&
        action?.type !== "deepseek-refresh-balance") {
        deepSeekManager.setError(error.message);
      }
      console.error(`[action] ${error.message}`);
    }
  }

  async function restartForConfigurationChange() {
    restartingCodex = true;
    try {
      await restartCodex(port, await prepareLaunch());
      deepSeekManager.markRestarted();
      scheduleDeepSeekBalanceRefresh();
      cdp?.close();
      cdp = null;
      targetId = null;
      widgetInstalled = false;
      lastPushedJson = null;
    } finally {
      restartingCodex = false;
    }
  }

  function scheduleDeepSeekBalanceRefresh() {
    clearTimeout(deepSeekBalanceTimer);
    const deepSeek = deepSeekManager.getViewModel();
    if (stopped || !deepSeek.enabled || !deepSeek.configured) return;
    deepSeekBalanceTimer = setTimeout(async () => {
      try {
        await deepSeekManager.refreshBalance();
      } catch (error) {
        console.error(`[deepseek-balance] ${error.message}`);
      } finally {
        scheduleDeepSeekBalanceRefresh();
      }
    }, DEEPSEEK_BALANCE_REFRESH_MS);
  }

  if (once) {
    await runQuotaRefresh();
  } else {
    accountManager.startOfficialCredentialWatch(() => {
      void runQuotaRefresh({ repeatIfRunning: true });
    });
    void runQuotaRefresh();
    const deepSeek = deepSeekManager.getViewModel();
    if (deepSeek.enabled && deepSeek.configured) {
      void deepSeekManager.refreshBalance().catch((error) => {
        console.error(`[deepseek-balance] ${error.message}`);
      });
      scheduleDeepSeekBalanceRefresh();
    }
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
      widgetInstalled = false;
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
