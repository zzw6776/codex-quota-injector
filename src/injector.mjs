import { AccountManager } from "./account-manager.mjs";
import { CdpClient, findCodexTarget } from "./cdp-client.mjs";
import { CodexContextManager } from "./codex-context.mjs";
import { prepareCodexLaunch } from "./codex-bridge.mjs";
import { DeepSeekManager } from "./deepseek-manager.mjs";
import { ExtraModelManager } from "./extra-model-manager.mjs";
import { isCodexRunning, restartCodex } from "./platform.mjs";
import { TokenUsageManager } from "./token-usage.mjs";
import packageJson from "../package.json" with { type: "json" };
import { isSea } from "node:sea";
import {
  widgetDrainActionsExpression,
  widgetInstallExpression,
  widgetTokenUsageDeltaUpdateExpressionJson,
  widgetUpdateExpressionJson,
  widgetRuntimeVersionExpression,
  WIDGET_RUNTIME_VERSION,
} from "./widget.mjs";

const DEFAULT_PORT = 9229;
const APP_VERSION = String(packageJson.version ?? "0.0.0");
const APP_DISPLAY_VERSION = isSea() ? APP_VERSION : `${APP_VERSION}.dev`;
const TARGET_POLL_MS = 1_500;
const QUOTA_REFRESH_MS = 60_000;
const DEEPSEEK_BALANCE_REFRESH_MS = 5 * 60_000;
const STARTUP_GRACE_MS = 30_000;
const TOKEN_USAGE_FALLBACK_MS = 15_000;
const WIDGET_HEALTH_CHECK_MS = 15_000;
const TOKEN_USAGE_STABILITY_GRACE_MS = 5_000;
const INJECTION_ERROR_LOG_INTERVAL_MS = 10_000;
const DEBUG_LOGGING = process.env.CODEX_QUOTA_DEBUG === "1";

export async function runInjector({
  port = DEFAULT_PORT,
  once = false,
  injectionMode = null,
  accountManager = new AccountManager(),
  contextManager = new CodexContextManager(),
  deepSeekManager = new DeepSeekManager(),
  extraModelManager = new ExtraModelManager(),
  tokenUsageManager = new TokenUsageManager(),
  managersInitialized = false,
  prepareLaunch = () => prepareCodexLaunch({ deepSeekManager, extraModelManager, contextManager }),
} = {}) {
  await accountManager.initialize();
  if (!managersInitialized) {
    await contextManager.initialize();
    await deepSeekManager.initialize();
    await extraModelManager.initialize();
  }
  const tokenInitialization = tokenUsageManager.initialize().catch((error) => {
    console.error(`[token-usage] 初始化失败: ${error.message}`);
  });
  if (once) await tokenInitialization;
  let cdp = null;
  let targetId = null;
  let widgetInstalled = false;
  let lastStaticJson = null;
  let lastTokenUsageSignatures = new Map();
  let lastTokenUsageStatus = null;
  let lastTokenUsageError = null;
  let widgetUpdateRevision = 0;
  let widgetUpdatePromise = null;
  let widgetUpdateRequested = false;
  let widgetDataDirty = true;
  let widgetDataRevision = 0;
  let lastAccountOperationJson = null;
  let lastStableTokenUsage = null;
  let lastStableTokenUsageAt = 0;
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
  let tokenUsageFallbackTimer = null;
  let lastWidgetHealthCheckAt = 0;
  let lastInjectionError = null;
  let lastInjectionErrorAt = 0;
  const startupDeadline = Date.now() + STARTUP_GRACE_MS;

  function markWidgetDataDirty() {
    widgetDataDirty = true;
    widgetDataRevision += 1;
  }

  function syncAsyncAccountOperation() {
    const operationJson = JSON.stringify(accountManager.operation ?? null);
    if (operationJson === lastAccountOperationJson) return;
    lastAccountOperationJson = operationJson;
    markWidgetDataDirty();
  }

  const stop = () => {
    stopped = true;
    clearTimeout(quotaRefreshTimer);
    clearTimeout(deepSeekBalanceTimer);
    clearTimeout(tokenUsageFallbackTimer);
    quotaRefreshTimer = null;
    tokenUsageFallbackTimer = null;
    removeTokenUsageListener();
    removeTokenUsageListener = () => {};
    cdp?.close();
    accountManager.close();
    deepSeekManager.close();
    extraModelManager.close();
    tokenUsageManager.close();
  };
  const stopAndExit = async () => {
    if (stopping) return;
    stopping = true;
    await accountManager.syncCurrentAccountFromOfficialCredentials().catch((error) => {
      console.error(`[lifecycle] 退出前同步 Codex 凭证失败: ${error.message}`);
    });
    stop();
    await tokenUsageManager.flush().catch((error) => {
      console.error(`[token-usage] 退出前保存缓存失败: ${error.message}`);
    });
    setTimeout(() => process.exit(0), 250);
  };
  process.once("SIGINT", () => void stopAndExit());
  process.once("SIGTERM", () => void stopAndExit());

  async function refreshQuotas() {
    if (accountManager.store.list().length > 0) {
      await accountManager.refreshAll();
      markWidgetDataDirty();
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
          markWidgetDataDirty();
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
    let reconnected = false;
    if (!cdp?.isConnected) {
      const target = await findCodexTarget(port);
      if (!target) throw new Error("CDP 已连接，但未找到 Codex 主页面");
      cdp?.close();
      cdp = new CdpClient(target.webSocketDebuggerUrl);
      await cdp.connect();
      targetId = target.id;
      lastStaticJson = null;
      lastTokenUsageSignatures = new Map();
      lastTokenUsageStatus = null;
      lastTokenUsageError = null;
      widgetUpdateRevision = 0;
      widgetInstalled = false;
      lastWidgetHealthCheckAt = 0;
      lastAccountOperationJson = null;
      markWidgetDataDirty();
      reconnected = true;
      await contextManager.refresh();
    }
    if (!widgetInstalled) {
      await cdp.evaluate(widgetInstallExpression());
      widgetInstalled = true;
      lastWidgetHealthCheckAt = Date.now();
      markWidgetDataDirty();
    }
    if (reconnected) {
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
      scheduleTokenUsageFallback();
    }
    await requestWidgetUpdate();
    if (reconnected) {
      if (lastInjectionError) console.log("[injector] Codex 页面连接已恢复");
      console.log(`[injector] 已连接并注入 Codex 主页面（${targetId}）`);
      lastInjectionError = null;
      lastInjectionErrorAt = 0;
    }
    return true;
  }

  function scheduleTokenUsageFallback() {
    clearTimeout(tokenUsageFallbackTimer);
    if (stopped || once) return;
    tokenUsageFallbackTimer = setTimeout(async () => {
      tokenUsageFallbackTimer = null;
      try {
        await tokenUsageManager.refresh({ notify: true });
      } catch (error) {
        console.error(`[token-usage] 兜底刷新失败: ${error.message}`);
      } finally {
        scheduleTokenUsageFallback();
      }
    }, TOKEN_USAGE_FALLBACK_MS);
  }

  async function pushWidgetViewModel() {
    const currentCdp = cdp;
    if (!currentCdp?.isConnected || stopped) return false;
    if (widgetInstalled && Date.now() - lastWidgetHealthCheckAt >= WIDGET_HEALTH_CHECK_MS) {
      lastWidgetHealthCheckAt = Date.now();
      const runtimeVersion = await currentCdp.evaluate(widgetRuntimeVersionExpression());
      if (runtimeVersion !== WIDGET_RUNTIME_VERSION) {
        await currentCdp.evaluate(widgetInstallExpression());
        widgetInstalled = true;
        lastStaticJson = null;
        lastTokenUsageSignatures = new Map();
        lastTokenUsageStatus = null;
        lastTokenUsageError = null;
        widgetUpdateRevision = 0;
        markWidgetDataDirty();
      }
    }
    if (!widgetDataDirty) return cdp === currentCdp;
    const dataRevisionAtStart = widgetDataRevision;
    const tokenUsage = tokenUsageManager.getViewModel();
    const hasCurrentTurns = Array.isArray(tokenUsage.turns) && tokenUsage.turns.length > 0;
    if (tokenUsage.status === "ready" &&
      (hasCurrentTurns || !lastStableTokenUsage)) {
      lastStableTokenUsage = tokenUsage;
      lastStableTokenUsageAt = Date.now();
    }
    const keepStableTokenUsage = lastStableTokenUsage &&
      Date.now() - lastStableTokenUsageAt < TOKEN_USAGE_STABILITY_GRACE_MS;
    if (!hasCurrentTurns && tokenUsage.status === "ready" && !keepStableTokenUsage) {
      lastStableTokenUsage = tokenUsage;
      lastStableTokenUsageAt = Date.now();
    }
    const stableTokenUsage = keepStableTokenUsage &&
      (!hasCurrentTurns || tokenUsage.status !== "ready")
      ? {
          ...lastStableTokenUsage,
          status: tokenUsage.status,
          error: tokenUsage.error,
        }
      : tokenUsage;
    const viewModel = {
      ...accountManager.getViewModel(),
      context: contextManager.getViewModel(),
      deepSeek: deepSeekManager.getViewModel(),
      extraModels: extraModelManager.getViewModel(),
      tokenUsage: stableTokenUsage,
    };
    const staticViewModel = {
      version: APP_DISPLAY_VERSION,
      injectionMode,
      accounts: viewModel.accounts,
      windows: viewModel.windows,
      currentAccountId: viewModel.currentAccountId,
      operation: viewModel.operation,
      context: viewModel.context,
      deepSeek: viewModel.deepSeek,
      extraModels: viewModel.extraModels,
    };
    const staticJson = JSON.stringify(staticViewModel);
    const nextTokenUsageSignatures = new Map();
    const tokenUsageUpdates = [];
    for (const turn of Array.isArray(stableTokenUsage.turns) ? stableTokenUsage.turns : []) {
      const turnId = String(turn?.turnId ?? "");
      if (!turnId) continue;
      const signature = JSON.stringify(turn);
      nextTokenUsageSignatures.set(turnId, signature);
      if (signature !== lastTokenUsageSignatures.get(turnId)) tokenUsageUpdates.push(turn);
    }
    const removedTurnIds = [...lastTokenUsageSignatures.keys()]
      .filter((turnId) => !nextTokenUsageSignatures.has(turnId));
    const tokenUsageDelta = {
      status: stableTokenUsage.status,
      error: stableTokenUsage.error ?? null,
      updates: tokenUsageUpdates,
      removedTurnIds,
    };
    const tokenUsageChanged = stableTokenUsage.status !== lastTokenUsageStatus ||
      (stableTokenUsage.error ?? null) !== lastTokenUsageError ||
      tokenUsageUpdates.length > 0 || removedTurnIds.length > 0;
    if (staticJson !== lastStaticJson) {
      await currentCdp.evaluate(widgetUpdateExpressionJson(
        JSON.stringify({ ...staticViewModel, tokenUsage: stableTokenUsage }),
        ++widgetUpdateRevision,
      ));
      if (cdp === currentCdp) {
        lastStaticJson = staticJson;
        lastTokenUsageSignatures = nextTokenUsageSignatures;
        lastTokenUsageStatus = stableTokenUsage.status;
        lastTokenUsageError = stableTokenUsage.error ?? null;
      }
    } else if (tokenUsageChanged) {
      await currentCdp.evaluate(widgetTokenUsageDeltaUpdateExpressionJson(
        JSON.stringify(tokenUsageDelta),
        ++widgetUpdateRevision,
      ));
      if (cdp === currentCdp) {
        lastTokenUsageSignatures = nextTokenUsageSignatures;
        lastTokenUsageStatus = stableTokenUsage.status;
        lastTokenUsageError = stableTokenUsage.error ?? null;
      }
    }
    if (cdp === currentCdp && widgetDataRevision === dataRevisionAtStart) {
      widgetDataDirty = false;
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
    markWidgetDataDirty();
    void requestWidgetUpdate().catch((error) => {
      console.error(`[token-usage] 事件驱动 Widget 刷新失败: ${error.message}`);
    });
  });

  async function startAction(action) {
    markWidgetDataDirty();
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
        case "extra-platform-save":
          await extraModelManager.savePlatform(action.platform, {
            reservedModelIds: [
              ...contextManager.getViewModel().models.map((model) => model.slug),
              deepSeekManager.getViewModel().model.slug,
            ],
          });
          await restartForConfigurationChange();
          break;
        case "extra-platform-remove":
          await extraModelManager.removePlatform(action.platformId);
          await restartForConfigurationChange();
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
            lastStaticJson = null;
            lastWidgetHealthCheckAt = 0;
            markWidgetDataDirty();
            lastTokenUsageSignatures = new Map();
            lastTokenUsageStatus = null;
            lastTokenUsageError = null;
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
      if (String(action?.type ?? "").startsWith("extra-platform-")) {
        extraModelManager.setError(error.message);
      }
      console.error(`[action] ${error.message}`);
    }
  }

  async function restartForConfigurationChange() {
    restartingCodex = true;
    try {
      await restartCodex(port, await prepareLaunch());
      deepSeekManager.markRestarted();
      extraModelManager.markRestarted();
      scheduleDeepSeekBalanceRefresh();
      cdp?.close();
      cdp = null;
      targetId = null;
      widgetInstalled = false;
      lastStaticJson = null;
      lastWidgetHealthCheckAt = 0;
      markWidgetDataDirty();
      lastTokenUsageSignatures = new Map();
      lastTokenUsageStatus = null;
      lastTokenUsageError = null;
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
        markWidgetDataDirty();
        void requestWidgetUpdate().catch((error) => {
          console.error(`[deepseek-balance] Widget 刷新失败: ${error.message}`);
        });
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
      void deepSeekManager.refreshBalance()
        .then(() => {
          markWidgetDataDirty();
          return requestWidgetUpdate();
        })
        .catch((error) => {
          markWidgetDataDirty();
          console.error(`[deepseek-balance] ${error.message}`);
        });
      scheduleDeepSeekBalanceRefresh();
    }
  }
  let _loopCount = 0;
  while (!stopped) {
    _loopCount++;
    debugLog(`[DEBUG] loop#${_loopCount} cdp=${!!cdp} cdp.isConnected=${cdp?.isConnected} restartingCodex=${restartingCodex} hasSeenCodexProcess=${hasSeenCodexProcess} stopped=${stopped} deadline=${Date.now() >= startupDeadline}`);
    if (!cdp?.isConnected && !restartingCodex) {
      const codexRunning = await isCodexRunning();
      debugLog(`[DEBUG] loop#${_loopCount} isCodexRunning=${codexRunning}`);
      if (codexRunning) {
        hasSeenCodexProcess = true;
      } else if (hasSeenCodexProcess || Date.now() >= startupDeadline) {
        console.log("[lifecycle] Codex 已退出，注入器同步停止");
        await stopAndExit();
        break;
      }
    }
    try {
      syncAsyncAccountOperation();
      debugLog(`[DEBUG] loop#${_loopCount} calling connectAndInject...`);
      const injected = await connectAndInject();
      debugLog(`[DEBUG] loop#${_loopCount} injected=${injected}`);
      if (injected && !activeAction) {
        const actions = await cdp.evaluate(widgetDrainActionsExpression());
        if (Array.isArray(actions) && actions.length > 0) {
          activeAction = (async () => {
            for (const action of actions) await startAction(action);
          })().finally(() => {
            activeAction = null;
            markWidgetDataDirty();
            void requestWidgetUpdate().catch((error) => {
              console.error(`[widget] 操作后刷新失败: ${error.message}`);
            });
          });
        }
      }
      if (injected && once) break;
    } catch (error) {
      if (once) throw error;
      const message = error?.message ?? String(error);
      const now = Date.now();
      debugLog(`[DEBUG] loop#${_loopCount} catch: ${message}`);
      if (message !== lastInjectionError || now - lastInjectionErrorAt >= INJECTION_ERROR_LOG_INTERVAL_MS) {
        console.error(`[injector] 连接或注入失败: ${message}`);
        lastInjectionError = message;
        lastInjectionErrorAt = now;
      }
      cdp?.close();
      cdp = null;
      targetId = null;
      widgetInstalled = false;
      lastWidgetHealthCheckAt = 0;
      markWidgetDataDirty();
    }
    await delay(TARGET_POLL_MS);
  }

  if (once) {
    stop();
    await tokenUsageManager.flush().catch((error) => {
      console.error(`[token-usage] 保存缓存失败: ${error.message}`);
    });
    return accountManager.getViewModel();
  }
  stop();
  await tokenUsageManager.flush().catch((error) => {
    console.error(`[token-usage] 保存缓存失败: ${error.message}`);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function debugLog(message) {
  if (DEBUG_LOGGING) console.log(message);
}

export { DEFAULT_PORT };
