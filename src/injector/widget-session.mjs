import {
  WIDGET_HEALTH_CHECK_MS,
  TOKEN_USAGE_STABILITY_GRACE_MS,
} from "./contract.mjs";

function createWidgetSession(dependencies) {
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

  let lastStableTokenUsage = null;

  let lastStableTokenUsageAt = 0;

  let lastWidgetHealthCheckAt = 0;

  function markWidgetDataDirty() {
    widgetDataDirty = true;
    widgetDataRevision += 1;
  }

  async function pushWidgetViewModel() {
    const currentCdp = dependencies.cdp;
    if (!currentCdp?.isConnected || !widgetInstalled || dependencies.stopped)
      return false;
    if (
      widgetInstalled &&
      Date.now() - lastWidgetHealthCheckAt >= WIDGET_HEALTH_CHECK_MS
    ) {
      lastWidgetHealthCheckAt = Date.now();
      const runtimeVersion = await currentCdp.evaluate(
        dependencies.widget.widgetRuntimeVersionExpression(),
      );
      if (runtimeVersion !== dependencies.widget.WIDGET_RUNTIME_VERSION) {
        await currentCdp.evaluate(
          dependencies.widget.widgetInstallExpression(),
        );
        widgetInstalled = true;
        lastStaticJson = null;
        lastTokenUsageSignatures = new Map();
        lastTokenUsageStatus = null;
        lastTokenUsageError = null;
        widgetUpdateRevision = 0;
        markWidgetDataDirty();
      }
    }
    if (!widgetDataDirty) return dependencies.cdp === currentCdp;
    const dataRevisionAtStart = widgetDataRevision;
    const tokenUsage = dependencies.tokenUsageManager.getViewModel();
    const hasCurrentTurns =
      Array.isArray(tokenUsage.turns) && tokenUsage.turns.length > 0;
    if (
      tokenUsage.status === "ready" &&
      (hasCurrentTurns || !lastStableTokenUsage)
    ) {
      lastStableTokenUsage = tokenUsage;
      lastStableTokenUsageAt = Date.now();
    }
    const keepStableTokenUsage =
      lastStableTokenUsage &&
      Date.now() - lastStableTokenUsageAt < TOKEN_USAGE_STABILITY_GRACE_MS;
    if (
      !hasCurrentTurns &&
      tokenUsage.status === "ready" &&
      !keepStableTokenUsage
    ) {
      lastStableTokenUsage = tokenUsage;
      lastStableTokenUsageAt = Date.now();
    }
    const stableTokenUsage =
      keepStableTokenUsage &&
      (!hasCurrentTurns || tokenUsage.status !== "ready")
        ? {
            ...lastStableTokenUsage,
            status: tokenUsage.status,
            error: tokenUsage.error,
          }
        : tokenUsage;
    const viewModel = {
      ...dependencies.accountManager.getViewModel(),
      context: dependencies.contextManager.getViewModel(),
      extraModels: dependencies.extraModelManager.getViewModel(),
      network: dependencies.modelRouterManager.getNetworkViewModel?.() ?? null,
      tokenUsage: stableTokenUsage,
    };
    const staticViewModel = {
      version: dependencies.appDisplayVersion,
      injectionMode: dependencies.injectionMode,
      accounts: viewModel.accounts.map((account) => ({
        ...account,
        wakeup: dependencies.wakeupManager.getViewModel(account.id),
      })),
      windows: viewModel.windows,
      currentAccountId: viewModel.currentAccountId,
      operation: viewModel.operation,
      context: viewModel.context,
      extraModels: viewModel.extraModels,
      network: viewModel.network,
      hostHealth: dependencies.hostHealth,
    };
    const staticJson = JSON.stringify(staticViewModel);
    const { extraModels: _extraModels, ...staticCoreViewModel } =
      staticViewModel;
    const staticCoreJson = JSON.stringify(staticCoreViewModel);
    const nextTokenUsageSignatures = new Map();
    const tokenUsageUpdates = [];
    for (const turn of Array.isArray(stableTokenUsage.turns)
      ? stableTokenUsage.turns
      : []) {
      const turnId = String(turn?.turnId ?? "");
      if (!turnId) continue;
      const signature = JSON.stringify(turn);
      nextTokenUsageSignatures.set(turnId, signature);
      if (signature !== lastTokenUsageSignatures.get(turnId))
        tokenUsageUpdates.push(turn);
    }
    const removedTurnIds = [...lastTokenUsageSignatures.keys()].filter(
      (turnId) => !nextTokenUsageSignatures.has(turnId),
    );
    const tokenUsageDelta = {
      status: stableTokenUsage.status,
      error: stableTokenUsage.error ?? null,
      updates: tokenUsageUpdates,
      removedTurnIds,
    };
    const tokenUsageChanged =
      stableTokenUsage.status !== lastTokenUsageStatus ||
      (stableTokenUsage.error ?? null) !== lastTokenUsageError ||
      tokenUsageUpdates.length > 0 ||
      removedTurnIds.length > 0;
    if (staticJson !== lastStaticJson) {
      if (lastStaticJson != null && staticCoreJson === lastStaticCoreJson) {
        await currentCdp.evaluate(
          dependencies.widget.widgetExtraModelsUpdateExpressionJson(
            JSON.stringify(staticViewModel.extraModels),
            ++widgetUpdateRevision,
          ),
        );
        if (tokenUsageChanged) {
          await currentCdp.evaluate(
            dependencies.widget.widgetTokenUsageDeltaUpdateExpressionJson(
              JSON.stringify(tokenUsageDelta),
              ++widgetUpdateRevision,
            ),
          );
        }
      } else {
        await currentCdp.evaluate(
          dependencies.widget.widgetUpdateExpressionJson(
            JSON.stringify({
              ...staticViewModel,
              tokenUsage: stableTokenUsage,
            }),
            ++widgetUpdateRevision,
          ),
        );
      }
      if (dependencies.cdp === currentCdp) {
        lastStaticJson = staticJson;
        lastStaticCoreJson = staticCoreJson;
        lastTokenUsageSignatures = nextTokenUsageSignatures;
        lastTokenUsageStatus = stableTokenUsage.status;
        lastTokenUsageError = stableTokenUsage.error ?? null;
      }
    } else if (tokenUsageChanged) {
      await currentCdp.evaluate(
        dependencies.widget.widgetTokenUsageDeltaUpdateExpressionJson(
          JSON.stringify(tokenUsageDelta),
          ++widgetUpdateRevision,
        ),
      );
      if (dependencies.cdp === currentCdp) {
        lastTokenUsageSignatures = nextTokenUsageSignatures;
        lastTokenUsageStatus = stableTokenUsage.status;
        lastTokenUsageError = stableTokenUsage.error ?? null;
      }
    }
    if (
      dependencies.cdp === currentCdp &&
      widgetDataRevision === dataRevisionAtStart
    ) {
      widgetDataDirty = false;
    }
    return dependencies.cdp === currentCdp;
  }

  function requestWidgetUpdate() {
    if (dependencies.widgetReloading) return Promise.resolve(false);
    widgetUpdateRequested = true;
    if (widgetUpdatePromise) return widgetUpdatePromise;
    const task = (async () => {
      do {
        widgetUpdateRequested = false;
        await pushWidgetViewModel();
      } while (widgetUpdateRequested && !dependencies.stopped);
    })().finally(() => {
      if (widgetUpdatePromise === task) widgetUpdatePromise = null;
    });
    widgetUpdatePromise = task;
    return task;
  }

  return {
    get widgetInstalled() {
      return widgetInstalled;
    },
    set widgetInstalled(value) {
      widgetInstalled = value;
    },
    get lastStaticJson() {
      return lastStaticJson;
    },
    set lastStaticJson(value) {
      lastStaticJson = value;
    },
    get lastTokenUsageSignatures() {
      return lastTokenUsageSignatures;
    },
    set lastTokenUsageSignatures(value) {
      lastTokenUsageSignatures = value;
    },
    get lastTokenUsageStatus() {
      return lastTokenUsageStatus;
    },
    set lastTokenUsageStatus(value) {
      lastTokenUsageStatus = value;
    },
    get lastTokenUsageError() {
      return lastTokenUsageError;
    },
    set lastTokenUsageError(value) {
      lastTokenUsageError = value;
    },
    get widgetUpdateRevision() {
      return widgetUpdateRevision;
    },
    set widgetUpdateRevision(value) {
      widgetUpdateRevision = value;
    },
    get widgetUpdatePromise() {
      return widgetUpdatePromise;
    },
    set widgetUpdatePromise(value) {
      widgetUpdatePromise = value;
    },
    get lastWidgetHealthCheckAt() {
      return lastWidgetHealthCheckAt;
    },
    set lastWidgetHealthCheckAt(value) {
      lastWidgetHealthCheckAt = value;
    },
    markWidgetDataDirty,
    requestWidgetUpdate,
  };
}

export { createWidgetSession };
