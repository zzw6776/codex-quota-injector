import { AccountManager } from "./account-manager.mjs";
import { AccountWakeupManager } from "./account-wakeup.mjs";
import { CdpClient, findCodexTarget } from "./cdp-client.mjs";
import { CodexContextManager } from "./codex-context.mjs";
import {
  prepareCodexLaunch,
  refreshCodexModelCatalog,
} from "./codex-bridge.mjs";
import { ExtraModelManager } from "./extra-model-manager.mjs";
import { requestHostToolReload } from "./host-health.mjs";
import { ModelRouterManager } from "./model-router.mjs";
import {
  isCodexRunning,
  isRelayStateCurrent,
  restartCodex,
} from "./platform.mjs";
import { TokenUsageManager } from "./token-usage.mjs";
import { isSea } from "node:sea";
import * as initialWidget from "./widget.mjs";
import {
  DEFAULT_PORT,
  APP_DISPLAY_VERSION,
  TARGET_POLL_MS,
  QUOTA_REFRESH_MS,
  MODEL_CATALOG_REFRESH_MS,
  MODEL_CATALOG_BUSY_RETRY_MS,
  DEEPSEEK_BALANCE_REFRESH_MS,
  STARTUP_GRACE_MS,
  TOKEN_USAGE_FALLBACK_MS,
  INJECTION_ERROR_LOG_INTERVAL_MS,
} from "./injector/contract.mjs";
import { delay, debugLog } from "./injector/logging.mjs";
import { createWidgetSession } from "./injector/widget-session.mjs";
import { createHostHealthSession } from "./injector/host-health-session.mjs";

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
  prepareLaunch = () =>
    prepareCodexLaunch({
      accountManager,
      extraModelManager,
      contextManager,
      modelRouterManager,
    }),
  refreshModelCatalog = () =>
    refreshCodexModelCatalog({ accountManager, contextManager }),
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

  let lastAccountOperationJson = null;

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

  let lastInjectionError = null;
  let lastInjectionErrorAt = 0;
  let launchRecoveryRequested = false;
  let widget = initialWidget;
  let appDisplayVersion = APP_DISPLAY_VERSION;
  let pendingWidgetReload = null;
  let widgetReloading = false;
  let modelRouterClosePromise = null;

  const startupDeadline = Date.now() + STARTUP_GRACE_MS;
  const widgetSession = createWidgetSession({
    get injectionMode() {
      return injectionMode;
    },
    get accountManager() {
      return accountManager;
    },
    get contextManager() {
      return contextManager;
    },
    get extraModelManager() {
      return extraModelManager;
    },
    get modelRouterManager() {
      return modelRouterManager;
    },
    get tokenUsageManager() {
      return tokenUsageManager;
    },
    get cdp() {
      return cdp;
    },
    get stopped() {
      return stopped;
    },
    get widget() {
      return widget;
    },
    get appDisplayVersion() {
      return appDisplayVersion;
    },
    get widgetReloading() {
      return widgetReloading;
    },
    get hostHealth() {
      return hostHealthSession.hostHealth;
    },
    get wakeupManager() {
      return wakeupManager;
    },
  });

  const hostHealthSession = createHostHealthSession({
    get getLaunchOptions() {
      return getLaunchOptions;
    },
    get stopped() {
      return stopped;
    },
    get markWidgetDataDirty() {
      return widgetSession.markWidgetDataDirty;
    },
    get requestWidgetUpdate() {
      return widgetSession.requestWidgetUpdate;
    },
  });

  const wakeupManager = new AccountWakeupManager(accountManager, () => {
    widgetSession.markWidgetDataDirty();
    void widgetSession.requestWidgetUpdate().catch((error) => {
      console.error(`[wakeup] 面板刷新失败：${error.message}`);
    });
  });

  function syncAsyncAccountOperation() {
    const operationJson = JSON.stringify(accountManager.operation ?? null);
    if (operationJson === lastAccountOperationJson) return;
    lastAccountOperationJson = operationJson;
    widgetSession.markWidgetDataDirty();
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
    hostHealthSession.closeHostHealthWatcher();
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
    await accountManager
      .syncCurrentAccountFromOfficialCredentials()
      .catch((error) => {
        console.error(
          `[lifecycle] 退出前同步 Codex 凭证失败: ${error.message}`,
        );
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
    if (!stopped && !isSea())
      pendingWidgetReload = { widget: nextWidget, version };
  });

  async function refreshQuotas() {
    if (accountManager.store.list().length > 0) {
      await accountManager.refreshAll();
      widgetSession.markWidgetDataDirty();
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
          widgetSession.markWidgetDataDirty();
          console.error(`[quota] ${error.message}`);
        }
      } while (quotaRefreshRequested && !stopped);
    })().finally(() => {
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
      widgetSession.lastStaticJson = null;
      widgetSession.lastTokenUsageSignatures = new Map();
      widgetSession.lastTokenUsageStatus = null;
      widgetSession.lastTokenUsageError = null;
      widgetSession.widgetUpdateRevision = 0;
      widgetSession.widgetInstalled = false;
      widgetSession.lastWidgetHealthCheckAt = 0;
      lastAccountOperationJson = null;
      widgetSession.markWidgetDataDirty();
      reconnected = true;
      await contextManager.refresh();
    }
    if (!widgetSession.widgetInstalled) {
      await cdp.evaluate(widget.widgetInstallExpression());
      widgetSession.widgetInstalled = true;
      widgetSession.lastWidgetHealthCheckAt = Date.now();
      widgetSession.markWidgetDataDirty();
    }
    if (reconnected) {
      const tokenRefresh = tokenUsageManager.refresh().catch((error) => {
        console.error(`[token-usage] 刷新失败: ${error.message}`);
      });
      if (once) await tokenRefresh;
      void tokenRefresh
        .then(() => {
          if (!once) return widgetSession.requestWidgetUpdate();
          return undefined;
        })
        .catch((error) => {
          console.error(`[token-usage] 实时 Widget 刷新失败: ${error.message}`);
        });
      scheduleTokenUsageFallback();
    }
    await widgetSession.requestWidgetUpdate();
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

  removeTokenUsageListener = tokenUsageManager.onChange(() => {
    widgetSession.markWidgetDataDirty();
    void widgetSession.requestWidgetUpdate().catch((error) => {
      console.error(`[token-usage] 事件驱动 Widget 刷新失败: ${error.message}`);
    });
  });
  removeNetworkListener =
    modelRouterManager.onNetworkChange?.(() => {
      widgetSession.markWidgetDataDirty();
      void widgetSession.requestWidgetUpdate().catch((error) => {
        console.error(
          `[model-router] 网络状态 Widget 刷新失败: ${error.message}`,
        );
      });
    }) ?? (() => {});
  removeExtraModelListener =
    extraModelManager.onChange?.(() => {
      widgetSession.markWidgetDataDirty();
      void widgetSession.requestWidgetUpdate().catch((error) => {
        console.error(`[extra-models] 面板状态刷新失败: ${error.message}`);
      });
    }) ?? (() => {});

  async function startAction(action) {
    widgetSession.markWidgetDataDirty();
    try {
      switch (action?.type) {
        case "host-health-recheck":
          hostHealthSession.hostHealthActionError = null;
          await requestHostToolReload(getLaunchOptions?.()?.relay);
          hostHealthSession.lastHostHealthCheckAt = 0;
          await hostHealthSession.syncHostHealth({ force: true });
          break;
        case "host-health-open-logs":
          hostHealthSession.hostHealthActionError = null;
          if (typeof openLogs !== "function")
            throw new Error("当前启动入口没有日志打开能力");
          await openLogs();
          hostHealthSession.lastHostHealthCheckAt = 0;
          await hostHealthSession.syncHostHealth({ force: true });
          break;
        case "host-health-restart":
          hostHealthSession.hostHealthActionError = null;
          await restartForHostHealth();
          break;
        case "wakeup-save":
          await wakeupManager.save(action.accountId, {
            enabled: action.enabled,
            times: action.times,
          });
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
            reservedModelIds: contextManager
              .getViewModel()
              .models.map((model) => model.slug),
            requestId: action.requestId,
          });
          scheduleDeepSeekBalanceRefresh();
          break;
        }
        case "extra-platform-models-refresh":
          await extraModelManager.refreshPresetModels(action.platform);
          break;
        case "extra-model-detect": {
          await extraModelManager.detectModel(action.platform, action.modelId, {
            requestId: action.requestId,
          });
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
        hostHealthSession.hostHealthActionError = error.message;
        hostHealthSession.lastHostHealthCheckAt = 0;
        await hostHealthSession.syncHostHealth({ force: true });
      }
      if (String(action?.type ?? "").startsWith("context-")) {
        contextManager.setError(error.message);
      }
      if (
        (String(action?.type ?? "").startsWith("extra-platform-") ||
          action?.type === "extra-model-detect") &&
        action?.type !== "extra-deepseek-refresh-balance"
      ) {
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
      hostHealthSession.lastHostHealthCheckAt = 0;
      await hostHealthSession.syncHostHealth({ force: true });
    } finally {
      restartingCodex = false;
    }
  }

  async function restartForConfigurationChange({ context = false } = {}) {
    restartingCodex = true;
    try {
      const options = await prepareLaunch();
      if (options.preparationError) {
        throw new Error(
          `模型中继准备失败，配置尚未生效：${options.preparationError}`,
        );
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
    widgetSession.widgetInstalled = false;
    widgetSession.lastStaticJson = null;
    widgetSession.lastWidgetHealthCheckAt = 0;
    hostHealthSession.lastHostHealthCheckAt = 0;
    widgetSession.lastTokenUsageSignatures = new Map();
    widgetSession.lastTokenUsageStatus = null;
    widgetSession.lastTokenUsageError = null;
    widgetSession.markWidgetDataDirty();
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
    if (
      !manual &&
      (activeAction || activeModelDetections.size > 0 || restartingCodex)
    ) {
      scheduleModelCatalogRefresh(MODEL_CATALOG_BUSY_RETRY_MS);
      return undefined;
    }

    const task = (async () => {
      try {
        if (!manual) {
          if (!(await isCodexRunning())) return;
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
        const relayCurrent =
          !relayRequired ||
          (await isRelayStateCurrent(relay.statePath, relay.generation, {
            wslNative: relay.wslNative === true,
          }));
        const catalogReloadRequired = options.officialCatalogChanged;
        if (relayRequired && (catalogReloadRequired || !relayCurrent)) {
          if (!(await isCodexRunning())) return;
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
          contextManager.setError(
            `官方模型目录刷新失败：${options.officialCatalogError}`,
          );
        } else if (options.officialCatalogChecked) {
          contextManager.markOfficialCatalogCurrent();
        } else if (options.officialCatalogSource === "bundled") {
          contextManager.markBundledCatalogCurrent();
        } else {
          await contextManager.refresh({ sync: false });
        }
      } catch (error) {
        if (manual)
          contextManager.setError(`官方模型目录刷新失败：${error.message}`);
        console.error(`[models] 官方模型目录刷新失败: ${error.message}`);
      } finally {
        if (manual) restartingCodex = false;
        widgetSession.markWidgetDataDirty();
        void widgetSession.requestWidgetUpdate().catch((error) => {
          console.error(`[models] Widget 刷新失败: ${error.message}`);
        });
      }
    })().finally(() => {
      if (modelCatalogRefreshPromise === task)
        modelCatalogRefreshPromise = null;
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
        widgetSession.markWidgetDataDirty();
        void widgetSession.requestWidgetUpdate().catch((error) => {
          console.error(`[deepseek-balance] Widget 刷新失败: ${error.message}`);
        });
        scheduleDeepSeekBalanceRefresh();
      }
    }, DEEPSEEK_BALANCE_REFRESH_MS);
  }

  function deepSeekBalanceTarget() {
    const managed = extraModelManager
      .getViewModel()
      .platforms.find(
        (platform) =>
          platform.preset === "deepseek" && platform.enabled && platform.apiKey,
      );
    return managed
      ? { refresh: () => extraModelManager.refreshDeepSeekBalance() }
      : null;
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
      void balanceTarget
        .refresh()
        .then(() => {
          widgetSession.markWidgetDataDirty();
          return widgetSession.requestWidgetUpdate();
        })
        .catch((error) => {
          widgetSession.markWidgetDataDirty();
          console.error(`[deepseek-balance] ${error.message}`);
        });
      scheduleDeepSeekBalanceRefresh();
    }
  }
  let _loopCount = 0;
  while (!stopped) {
    if (
      pendingWidgetReload &&
      !activeAction &&
      activeModelDetections.size === 0 &&
      !restartingCodex &&
      !modelCatalogRefreshPromise
    ) {
      widgetReloading = true;
      try {
        await widgetSession.widgetUpdatePromise?.catch(() => {});
        const next = pendingWidgetReload;
        pendingWidgetReload = null;
        widget = next.widget;
        appDisplayVersion = `${next.version}.dev`;
        widgetSession.widgetInstalled = false;
        widgetSession.lastStaticJson = null;
        widgetSession.lastTokenUsageSignatures = new Map();
        widgetSession.lastTokenUsageStatus = null;
        widgetSession.lastTokenUsageError = null;
        widgetSession.widgetUpdateRevision = 0;
        widgetSession.lastWidgetHealthCheckAt = 0;
        widgetSession.markWidgetDataDirty();
      } finally {
        widgetReloading = false;
      }
    }
    _loopCount++;
    debugLog(
      `[DEBUG] loop#${_loopCount} cdp=${!!cdp} cdp.isConnected=${cdp?.isConnected} restartingCodex=${restartingCodex} hasSeenCodexProcess=${hasSeenCodexProcess} stopped=${stopped} deadline=${Date.now() >= startupDeadline}`,
    );
    if (
      launchRecoveryRequested &&
      !activeAction &&
      activeModelDetections.size === 0 &&
      !restartingCodex &&
      !modelCatalogRefreshPromise
    ) {
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
      await hostHealthSession.syncHostHealth();
      syncAsyncAccountOperation();
      debugLog(`[DEBUG] loop#${_loopCount} calling connectAndInject...`);
      const injected = await connectAndInject();
      debugLog(`[DEBUG] loop#${_loopCount} injected=${injected}`);
      if (
        injected &&
        !activeAction &&
        !restartingCodex &&
        !modelCatalogRefreshPromise
      ) {
        const actions = await cdp.evaluate(
          widget.widgetDrainActionsExpression(),
        );
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
                widgetSession.markWidgetDataDirty();
                void widgetSession
                  .requestWidgetUpdate()
                  .catch((error) =>
                    console.error(`[widget] 检测后刷新失败: ${error.message}`),
                  );
              });
              activeModelDetections.add(pending);
            }
          })().finally(() => {
            activeAction = null;
            widgetSession.markWidgetDataDirty();
            void widgetSession.requestWidgetUpdate().catch((error) => {
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
      if (
        message !== lastInjectionError ||
        now - lastInjectionErrorAt >= INJECTION_ERROR_LOG_INTERVAL_MS
      ) {
        console.error(`[injector] 连接或注入失败: ${message}`);
        lastInjectionError = message;
        lastInjectionErrorAt = now;
      }
      cdp?.close();
      cdp = null;
      targetId = null;
      widgetSession.widgetInstalled = false;
      widgetSession.lastWidgetHealthCheckAt = 0;
      widgetSession.markWidgetDataDirty();
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

export { DEFAULT_PORT };
