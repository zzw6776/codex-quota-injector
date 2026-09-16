import { AccountManager } from "./account-manager.mjs";
import { AccountWakeupManager } from "./account-wakeup.mjs";
import { CdpClient, findCodexTarget } from "./cdp-client.mjs";
import { CodexContextManager } from "./codex-context.mjs";
import { prepareCodexLaunch, refreshCodexModelCatalog } from "./codex-bridge.mjs";
import { ExtraModelManager } from "./extra-model-manager.mjs";
import {
  directHostHealth,
  hostHealthPollInterval,
  readHostHealthViewModel,
  requestHostToolReload,
  watchHostHealthFiles,
} from "./host-health.mjs";
import { ModelRouterManager } from "./model-router.mjs";
import { isCodexRunning, isRelayStateCurrent, restartCodex } from "./platform.mjs";
import { TokenUsageManager } from "./token-usage.mjs";
import packageJson from "../package.json" with { type: "json" };
import { isSea } from "node:sea";
import * as initialWidget from "./widget.mjs";

const DEFAULT_PORT = 9229;
const APP_VERSION = String(packageJson.version ?? "0.0.0");
const APP_DISPLAY_VERSION = isSea() ? APP_VERSION : `${APP_VERSION}.dev`;
const TARGET_POLL_MS = 1_500;
const QUOTA_REFRESH_MS = 60_000;
const MODEL_CATALOG_REFRESH_MS = 4 * 60_000 + 30_000;
const MODEL_CATALOG_BUSY_RETRY_MS = 30_000;
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
  extraModelManager = new ExtraModelManager(),
  modelRouterManager = new ModelRouterManager(),
  tokenUsageManager = new TokenUsageManager(),
  managersInitialized = false,
  accountManagerInitialized = false,
  prepareLaunch = () => prepareCodexLaunch({
    accountManager,
    extraModelManager,
    contextManager,
    modelRouterManager,
  }),
  refreshModelCatalog = () => refreshCodexModelCatalog({ accountManager, contextManager }),
  recoverLaunch = null,
  registerLaunchRecovery = null,
  registerWidgetReload = null,
  getLaunchOptions = () => null,
  openLogs = null,
} = {}) {
  if (!accountManagerInitialized) await accountManager.initialize();
  if (!managersInitialized) {
    await contextManager.initialize();
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
  let lastStaticCoreJson = null;
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
  let removeNetworkListener = () => {};
  let removeExtraModelListener = () => {};
  let activeAction = null;
  const activeModelDetections = new Set();
  let restartingCodex = false;
  let hasSeenCodexProcess = false;
  let stopped = false;
  let stopping = false;
  let quotaRefreshTimer = null;
  let quotaRefreshPromise = null;
  let quotaRefreshRequested = false;
  let deepSeekBalanceTimer = null;
  let modelCatalogRefreshTimer = null;
  let modelCatalogRefreshPromise = null;
  let tokenUsageFallbackTimer = null;
  let lastWidgetHealthCheckAt = 0;
  let lastInjectionError = null;
  let lastInjectionErrorAt = 0;
  let launchRecoveryRequested = false;
  let widget = initialWidget;
  let appDisplayVersion = APP_DISPLAY_VERSION;
  let pendingWidgetReload = null;
  let widgetReloading = false;
  let modelRouterClosePromise = null;
  let hostHealth = directHostHealth();
  let hostHealthJson = JSON.stringify(hostHealth);
  let hostHealthActionError = null;
  let hostHealthSyncPromise = null;
  let lastHostHealthCheckAt = 0;
  let hostHealthWatcher = null;
  let hostHealthWatcherKey = null;
  let hostHealthWatchAttemptKey = null;
  let lastHostHealthWatchAttemptAt = 0;
  let lastHostHealthWatchError = null;
  const startupDeadline = Date.now() + STARTUP_GRACE_MS;
  const wakeupManager = new AccountWakeupManager(accountManager, () => {
    markWidgetDataDirty();
    void requestWidgetUpdate().catch((error) => {
      console.error(`[wakeup] 面板刷新失败：${error.message}`);
    });
  });

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

  function closeHostHealthWatcher() {
    hostHealthWatcher?.close();
    hostHealthWatcher = null;
    hostHealthWatcherKey = null;
  }

  function hostHealthBindingKey(binding) {
    if (!binding?.hostToolsRequired) return "direct";
    return JSON.stringify([
      String(binding.statePath ?? ""),
      String(binding.healthPath ?? ""),
      String(binding.generation ?? ""),
      binding.wslNative === true,
    ]);
  }

  function ensureHostHealthWatcher(binding, now = Date.now()) {
    const key = hostHealthBindingKey(binding);
    if (hostHealthWatcher?.active && key === hostHealthWatcherKey) return;
    if (!binding?.hostToolsRequired) {
      if (hostHealthWatcher || key !== hostHealthWatcherKey) closeHostHealthWatcher();
      hostHealthWatcherKey = key;
      return;
    }
    if (key === hostHealthWatchAttemptKey &&
      now - lastHostHealthWatchAttemptAt < hostHealthPollInterval("starting")) return;

    closeHostHealthWatcher();
    hostHealthWatcherKey = key;
    hostHealthWatchAttemptKey = key;
    lastHostHealthWatchAttemptAt = now;
    const watcher = watchHostHealthFiles(binding, {
      onChange() {
        void refreshHostHealthFromEvent();
      },
      onError(error) {
        closeHostHealthWatcher();
        const message = error?.message ?? String(error);
        if (message !== lastHostHealthWatchError) {
          console.error(`[host-health] 状态文件监听失败，回退轮询：${message}`);
          lastHostHealthWatchError = message;
        }
      },
    });
    if (watcher.active) {
      hostHealthWatcher = watcher;
      lastHostHealthWatchError = null;
    } else {
      hostHealthWatcherKey = null;
    }
  }

  async function refreshHostHealthFromEvent() {
    try {
      await hostHealthSyncPromise;
      if (stopped) return;
      lastHostHealthCheckAt = 0;
      await syncHostHealth({ force: true });
      await requestWidgetUpdate();
    } catch (error) {
      console.error(`[host-health] 事件刷新失败：${error.message}`);
    }
  }

  async function syncHostHealth({ force = false } = {}) {
    const now = Date.now();
    const binding = getLaunchOptions?.()?.relay;
    ensureHostHealthWatcher(binding, now);
    const pollMs = binding?.hostToolsRequired && !hostHealthWatcher?.active
      ? hostHealthPollInterval("starting")
      : hostHealthPollInterval(hostHealth.status);
    if (!force && now - lastHostHealthCheckAt < pollMs) return hostHealth;
    if (hostHealthSyncPromise) return hostHealthSyncPromise;
    lastHostHealthCheckAt = now;
    const task = (async () => {
      const next = await readHostHealthViewModel(binding);
      const displayed = hostHealthActionError
        ? { ...next, actionError: hostHealthActionError }
        : next;
      const nextJson = JSON.stringify(displayed);
      if (nextJson !== hostHealthJson) {
        hostHealth = displayed;
        hostHealthJson = nextJson;
        markWidgetDataDirty();
      }
      return hostHealth;
    })().catch((error) => {
      const displayed = {
        ...hostHealth,
        status: "degraded",
        code: "health-check-failed",
        message: "无法读取 Codex 任务工具状态",
        detail: error.message,
      };
      const nextJson = JSON.stringify(displayed);
      if (nextJson !== hostHealthJson) {
        hostHealth = displayed;
        hostHealthJson = nextJson;
        markWidgetDataDirty();
      }
      return hostHealth;
    }).finally(() => {
      if (hostHealthSyncPromise === task) hostHealthSyncPromise = null;
    });
    hostHealthSyncPromise = task;
    return task;
  }

  const stop = () => {
    stopped = true;
    registerLaunchRecovery?.(null);
    registerWidgetReload?.(null);
    wakeupManager.close();
    clearTimeout(quotaRefreshTimer);
    clearTimeout(deepSeekBalanceTimer);
    clearTimeout(modelCatalogRefreshTimer);
    clearTimeout(tokenUsageFallbackTimer);
    closeHostHealthWatcher();
    quotaRefreshTimer = null;
    modelCatalogRefreshTimer = null;
    tokenUsageFallbackTimer = null;
    removeTokenUsageListener();
    removeTokenUsageListener = () => {};
    removeNetworkListener();
    removeNetworkListener = () => {};
    removeExtraModelListener();
    removeExtraModelListener = () => {};
    cdp?.close();
    accountManager.close();
    extraModelManager.close();
    tokenUsageManager.close();
    modelRouterClosePromise ??= modelRouterManager.close().catch((error) => {
      console.error(`[model-router] 关闭失败：${error.message}`);
    });
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
    await modelRouterClosePromise;
    setTimeout(() => process.exit(0), 250);
  };
  process.once("SIGINT", () => void stopAndExit());
  process.once("SIGTERM", () => void stopAndExit());

  if (typeof recoverLaunch === "function") {
    registerLaunchRecovery?.(() => {
      if (!stopped) launchRecoveryRequested = true;
    });
  }
  registerWidgetReload?.((nextWidget, version) => {
    if (!stopped && !isSea()) pendingWidgetReload = { widget: nextWidget, version };
  });

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
      await cdp.evaluate(widget.widgetInstallExpression());
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
    if (!currentCdp?.isConnected || !widgetInstalled || stopped) return false;
    if (widgetInstalled && Date.now() - lastWidgetHealthCheckAt >= WIDGET_HEALTH_CHECK_MS) {
      lastWidgetHealthCheckAt = Date.now();
      const runtimeVersion = await currentCdp.evaluate(widget.widgetRuntimeVersionExpression());
      if (runtimeVersion !== widget.WIDGET_RUNTIME_VERSION) {
        await currentCdp.evaluate(widget.widgetInstallExpression());
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
      extraModels: extraModelManager.getViewModel(),
      network: modelRouterManager.getNetworkViewModel?.() ?? null,
      tokenUsage: stableTokenUsage,
    };
    const staticViewModel = {
      version: appDisplayVersion,
      injectionMode,
      accounts: viewModel.accounts.map((account) => ({
        ...account,
        wakeup: wakeupManager.getViewModel(account.id),
      })),
      windows: viewModel.windows,
      currentAccountId: viewModel.currentAccountId,
      operation: viewModel.operation,
      context: viewModel.context,
      extraModels: viewModel.extraModels,
      network: viewModel.network,
      hostHealth,
    };
    const staticJson = JSON.stringify(staticViewModel);
    const { extraModels: _extraModels, ...staticCoreViewModel } = staticViewModel;
    const staticCoreJson = JSON.stringify(staticCoreViewModel);
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
      if (lastStaticJson != null && staticCoreJson === lastStaticCoreJson) {
        await currentCdp.evaluate(widget.widgetExtraModelsUpdateExpressionJson(
          JSON.stringify(staticViewModel.extraModels),
          ++widgetUpdateRevision,
        ));
        if (tokenUsageChanged) {
          await currentCdp.evaluate(widget.widgetTokenUsageDeltaUpdateExpressionJson(
            JSON.stringify(tokenUsageDelta),
            ++widgetUpdateRevision,
          ));
        }
      } else {
        await currentCdp.evaluate(widget.widgetUpdateExpressionJson(
          JSON.stringify({ ...staticViewModel, tokenUsage: stableTokenUsage }),
          ++widgetUpdateRevision,
        ));
      }
      if (cdp === currentCdp) {
        lastStaticJson = staticJson;
        lastStaticCoreJson = staticCoreJson;
        lastTokenUsageSignatures = nextTokenUsageSignatures;
        lastTokenUsageStatus = stableTokenUsage.status;
        lastTokenUsageError = stableTokenUsage.error ?? null;
      }
    } else if (tokenUsageChanged) {
      await currentCdp.evaluate(widget.widgetTokenUsageDeltaUpdateExpressionJson(
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
    if (widgetReloading) return Promise.resolve(false);
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
  removeNetworkListener = modelRouterManager.onNetworkChange?.(() => {
    markWidgetDataDirty();
    void requestWidgetUpdate().catch((error) => {
      console.error(`[model-router] 网络状态 Widget 刷新失败: ${error.message}`);
    });
  }) ?? (() => {});
  removeExtraModelListener = extraModelManager.onChange?.(() => {
    markWidgetDataDirty();
    void requestWidgetUpdate().catch((error) => {
      console.error(`[extra-models] 面板状态刷新失败: ${error.message}`);
    });
  }) ?? (() => {});

  async function startAction(action) {
    markWidgetDataDirty();
    try {
      switch (action?.type) {
        case "host-health-recheck":
          hostHealthActionError = null;
          await requestHostToolReload(getLaunchOptions?.()?.relay);
          lastHostHealthCheckAt = 0;
          await syncHostHealth({ force: true });
          break;
        case "host-health-open-logs":
          hostHealthActionError = null;
          if (typeof openLogs !== "function") throw new Error("当前启动入口没有日志打开能力");
          await openLogs();
          lastHostHealthCheckAt = 0;
          await syncHostHealth({ force: true });
          break;
        case "host-health-restart":
          hostHealthActionError = null;
          await restartForHostHealth();
          break;
        case "wakeup-save":
          await wakeupManager.save(action.accountId, { enabled: action.enabled, times: action.times });
          break;
        case "wakeup-now":
          wakeupManager.trigger(action.accountId);
          break;
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
        case "account-transfer": {
          const transfer = await accountManager.exportAccounts({
            mode: action.mode,
            accountIds: action.accountIds,
          });
          if (transfer.restartRequired) await restartForAccountChange();
          break;
        }
        case "restore-transferred":
          await accountManager.restoreTransferredAccount(action.accountId);
          break;
        case "refresh-all":
          await accountManager.refreshAllWithOperation();
          break;
        case "remove-account":
          await accountManager.removeAccount(action.accountId);
          break;
        case "context-refresh":
          await runModelCatalogRefresh({ manual: true });
          break;
        case "context-save":
          await contextManager.setOverride(
            action.slug,
            action.contextWindow,
            action.maxContextWindow,
          );
          await restartForConfigurationChange({ context: true });
          break;
        case "context-reset":
          await contextManager.resetOverride(action.slug);
          await restartForConfigurationChange({ context: true });
          break;
        case "context-reset-all":
          await contextManager.resetAll();
          await restartForConfigurationChange({ context: true });
          break;
        case "extra-deepseek-refresh-balance":
          await extraModelManager.refreshDeepSeekBalance();
          break;
        case "extra-platform-save": {
          await extraModelManager.savePlatform(action.platform, {
            reservedModelIds: contextManager.getViewModel().models.map((model) => model.slug),
            requestId: action.requestId,
          });
          scheduleDeepSeekBalanceRefresh();
          break;
        }
        case "extra-platform-models-refresh":
          await extraModelManager.refreshPresetModels(action.platform);
          break;
        case "extra-model-detect": {
          await extraModelManager.detectModel(action.platform, action.modelId, { requestId: action.requestId });
          break;
        }
        case "extra-platform-remove":
          await extraModelManager.removePlatform(action.platformId);
          break;
        case "switch-account":
          await accountManager.switchAccount(action.accountId);
          await restartForAccountChange();
          break;
        default:
          console.error(`[action] 未知操作: ${action?.type ?? "empty"}`);
      }
    } catch (error) {
      if (String(action?.type ?? "").startsWith("host-health-")) {
        hostHealthActionError = error.message;
        lastHostHealthCheckAt = 0;
        await syncHostHealth({ force: true });
      }
      if (String(action?.type ?? "").startsWith("context-")) {
        contextManager.setError(error.message);
      }
      if ((String(action?.type ?? "").startsWith("extra-platform-") || action?.type === "extra-model-detect") &&
        action?.type !== "extra-deepseek-refresh-balance") {
        extraModelManager.setError(error.message);
      }
      console.error(`[action] ${error.message}`);
    }
  }

  async function restartForAccountChange() {
    restartingCodex = true;
    try {
      const options = await prepareLaunch();
      await restartCodex(port, options);
      extraModelManager.markRestarted();
      if (options.officialCatalogChanged) {
        if (options.officialCatalogSource === "bundled") {
          contextManager.markBundledCatalogCurrent({ restarted: true });
        } else {
          contextManager.markOfficialCatalogRestarted();
        }
      }
      resetAfterCodexRestart();
      scheduleQuotaRefresh(0);
    } finally {
      restartingCodex = false;
    }
  }

  async function restartForHostHealth() {
    restartingCodex = true;
    try {
      const options = await prepareLaunch();
      if (options.preparationError) throw new Error(options.preparationError);
      await restartCodex(port, options);
      extraModelManager.markRestarted();
      resetAfterCodexRestart();
      lastHostHealthCheckAt = 0;
      await syncHostHealth({ force: true });
    } finally {
      restartingCodex = false;
    }
  }

  async function restartForConfigurationChange({ context = false } = {}) {
    restartingCodex = true;
    try {
      const options = await prepareLaunch();
      if (options.preparationError) {
        throw new Error(`模型中继准备失败，配置尚未生效：${options.preparationError}`);
      }
      await restartCodex(port, options);
      extraModelManager.markRestarted();
      if (context) contextManager.markRestarted();
      scheduleDeepSeekBalanceRefresh();
      resetAfterCodexRestart();
    } finally {
      restartingCodex = false;
    }
  }

  function resetAfterCodexRestart() {
    cdp?.close();
    cdp = null;
    targetId = null;
    widgetInstalled = false;
    lastStaticJson = null;
    lastWidgetHealthCheckAt = 0;
    lastHostHealthCheckAt = 0;
    lastTokenUsageSignatures = new Map();
    lastTokenUsageStatus = null;
    lastTokenUsageError = null;
    markWidgetDataDirty();
  }

  function scheduleModelCatalogRefresh(delayMs = MODEL_CATALOG_REFRESH_MS) {
    clearTimeout(modelCatalogRefreshTimer);
    if (stopped || once) return;
    modelCatalogRefreshTimer = setTimeout(() => {
      modelCatalogRefreshTimer = null;
      void runModelCatalogRefresh();
    }, delayMs);
  }

  async function runModelCatalogRefresh({ manual = false } = {}) {
    if (modelCatalogRefreshPromise) return modelCatalogRefreshPromise;
    if (!manual && (activeAction || activeModelDetections.size > 0 || restartingCodex)) {
      scheduleModelCatalogRefresh(MODEL_CATALOG_BUSY_RETRY_MS);
      return undefined;
    }

    const task = (async () => {
      try {
        if (!manual) {
          if (!await isCodexRunning()) return;
          // Scheduled refreshes only update the cache. Rebuilding relay files or
          // restarting here can interrupt an unrelated in-flight user task.
          const refresh = await refreshModelCatalog();
          if (!stopped && refresh.officialCatalogChanged) {
            contextManager.markOfficialCatalogAvailable();
          }
          return;
        }
        restartingCodex = true;
        const options = await prepareLaunch();
        if (stopped) return;
        if (options.preparationError) throw new Error(options.preparationError);
        const relay = options?.relay;
        const relayRequired = Boolean(relay && !relay.expectAbsent);
        const relayCurrent = !relayRequired || await isRelayStateCurrent(
          relay.statePath,
          relay.generation,
          { wslNative: relay.wslNative === true },
        );
        const catalogReloadRequired = options.officialCatalogChanged;
        if (relayRequired && (catalogReloadRequired || !relayCurrent)) {
          if (!await isCodexRunning()) return;
          console.log(
            catalogReloadRequired
              ? "[models] 检测到官方模型目录更新，正在重启 Codex 以加载最新模型"
              : "[models] 模型中继目录版本已变化，正在重启 Codex 重新加载",
          );
          await restartCodex(port, options);
          extraModelManager.markRestarted();
          if (catalogReloadRequired) {
            if (options.officialCatalogSource === "bundled") {
              contextManager.markBundledCatalogCurrent({ restarted: true });
            } else {
              contextManager.markOfficialCatalogRestarted();
            }
          } else if (options.officialCatalogSource === "bundled") {
            contextManager.markBundledCatalogCurrent({ restarted: true });
          } else {
            contextManager.markOfficialCatalogRestarted();
          }
          scheduleDeepSeekBalanceRefresh();
          resetAfterCodexRestart();
        } else if (options.officialCatalogError) {
          contextManager.setError(`官方模型目录刷新失败：${options.officialCatalogError}`);
        } else if (options.officialCatalogChecked) {
          contextManager.markOfficialCatalogCurrent();
        } else if (options.officialCatalogSource === "bundled") {
          contextManager.markBundledCatalogCurrent();
        } else {
          await contextManager.refresh({ sync: false });
        }
      } catch (error) {
        if (manual) contextManager.setError(`官方模型目录刷新失败：${error.message}`);
        console.error(`[models] 官方模型目录刷新失败: ${error.message}`);
      } finally {
        if (manual) restartingCodex = false;
        markWidgetDataDirty();
        void requestWidgetUpdate().catch((error) => {
          console.error(`[models] Widget 刷新失败: ${error.message}`);
        });
      }
    })().finally(() => {
      if (modelCatalogRefreshPromise === task) modelCatalogRefreshPromise = null;
      scheduleModelCatalogRefresh();
    });
    modelCatalogRefreshPromise = task;
    return task;
  }

  function scheduleDeepSeekBalanceRefresh() {
    clearTimeout(deepSeekBalanceTimer);
    const target = deepSeekBalanceTarget();
    if (stopped || !target) return;
    deepSeekBalanceTimer = setTimeout(async () => {
      try {
        await target.refresh();
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

  function deepSeekBalanceTarget() {
    const managed = extraModelManager.getViewModel().platforms
      .find((platform) => platform.preset === "deepseek" && platform.enabled && platform.apiKey);
    return managed ? { refresh: () => extraModelManager.refreshDeepSeekBalance() } : null;
  }

  if (once) {
    await runQuotaRefresh();
  } else {
    await wakeupManager.start();
    accountManager.startOfficialCredentialWatch(() => {
      void runQuotaRefresh({ repeatIfRunning: true });
      scheduleModelCatalogRefresh(0);
    });
    void runQuotaRefresh();
    scheduleModelCatalogRefresh();
    const balanceTarget = deepSeekBalanceTarget();
    if (balanceTarget) {
      void balanceTarget.refresh()
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
    if (pendingWidgetReload && !activeAction && activeModelDetections.size === 0 && !restartingCodex && !modelCatalogRefreshPromise) {
      widgetReloading = true;
      try {
        await widgetUpdatePromise?.catch(() => {});
        const next = pendingWidgetReload;
        pendingWidgetReload = null;
        widget = next.widget;
        appDisplayVersion = `${next.version}.dev`;
        widgetInstalled = false;
        lastStaticJson = null;
        lastTokenUsageSignatures = new Map();
        lastTokenUsageStatus = null;
        lastTokenUsageError = null;
        widgetUpdateRevision = 0;
        lastWidgetHealthCheckAt = 0;
        markWidgetDataDirty();
      } finally {
        widgetReloading = false;
      }
    }
    _loopCount++;
    debugLog(`[DEBUG] loop#${_loopCount} cdp=${!!cdp} cdp.isConnected=${cdp?.isConnected} restartingCodex=${restartingCodex} hasSeenCodexProcess=${hasSeenCodexProcess} stopped=${stopped} deadline=${Date.now() >= startupDeadline}`);
    if (launchRecoveryRequested && !activeAction && activeModelDetections.size === 0 && !restartingCodex && !modelCatalogRefreshPromise) {
      launchRecoveryRequested = false;
      restartingCodex = true;
      try {
        const restarted = await recoverLaunch();
        if (restarted) {
          extraModelManager.markRestarted();
          resetAfterCodexRestart();
        }
      } catch (error) {
        console.error(`[lifecycle] Codex 启动状态恢复失败: ${error.message}`);
      } finally {
        restartingCodex = false;
      }
    }
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
      await syncHostHealth();
      syncAsyncAccountOperation();
      debugLog(`[DEBUG] loop#${_loopCount} calling connectAndInject...`);
      const injected = await connectAndInject();
      debugLog(`[DEBUG] loop#${_loopCount} injected=${injected}`);
      if (injected && !activeAction && !restartingCodex && !modelCatalogRefreshPromise) {
        const actions = await cdp.evaluate(widget.widgetDrainActionsExpression());
        if (Array.isArray(actions) && actions.length > 0) {
          activeAction = (async () => {
            await modelCatalogRefreshPromise;
            for (const action of actions) {
              if (action.type !== "extra-model-detect") {
                await startAction(action);
                continue;
              }
              const pending = startAction(action).finally(() => {
                activeModelDetections.delete(pending);
                markWidgetDataDirty();
                void requestWidgetUpdate().catch(error => console.error(`[widget] 检测后刷新失败: ${error.message}`));
              });
              activeModelDetections.add(pending);
            }
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
    await modelRouterClosePromise;
    return accountManager.getViewModel();
  }
  stop();
  await tokenUsageManager.flush().catch((error) => {
    console.error(`[token-usage] 保存缓存失败: ${error.message}`);
  });
  await modelRouterClosePromise;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function debugLog(message) {
  if (DEBUG_LOGGING) console.log(message);
}

export { DEFAULT_PORT };
