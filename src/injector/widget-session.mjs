import { randomUUID } from "node:crypto";
import {
  WIDGET_HEALTH_CHECK_MS,
  TOKEN_USAGE_STABILITY_GRACE_MS,
} from "./contract.mjs";

function createWidgetSession(dependencies) {
  let connection = null;
  let dataRevision = 0;
  let updatePromise = null;
  let updateRequested = false;
  let stableUsage = null;
  let stableUsageAt = 0;

  function markWidgetDataDirty() {
    dataRevision += 1;
  }

  function reset() {
    connection = null;
    markWidgetDataDirty();
  }

  // Rollout reconciliation can temporarily publish an empty view. Keep this
  // existing display policy separate from the per-connection delivery state.
  function tokenUsageView(now) {
    const usage = dependencies.tokenUsageManager.getViewModel();
    const hasTurns = usage.turns.length > 0;
    if (usage.status === "ready" &&
      (hasTurns || !stableUsage || now - stableUsageAt >= TOKEN_USAGE_STABILITY_GRACE_MS)) {
      stableUsage = usage;
      stableUsageAt = now;
    }
    return stableUsage && now - stableUsageAt < TOKEN_USAGE_STABILITY_GRACE_MS &&
      (!hasTurns || usage.status !== "ready")
      ? { ...stableUsage, status: usage.status, error: usage.error }
      : usage;
  }

  function snapshot(previous) {
    const account = dependencies.accountManager.getViewModel();
    const core = {
      version: dependencies.appDisplayVersion,
      injectionMode: dependencies.injectionMode,
      accounts: account.accounts.map((item) => ({
        ...item,
        wakeup: dependencies.wakeupManager.getViewModel(item.id),
      })),
      windows: account.windows,
      currentAccountId: account.currentAccountId,
      operation: account.operation,
      context: dependencies.contextManager.getViewModel(),
      hostHealth: dependencies.hostHealth,
    };
    const extraModels = dependencies.extraModelManager.getViewModel();
    const network = dependencies.modelRouterManager.getNetworkViewModel?.() ?? null;
    const usage = tokenUsageView(Date.now());
    const sameTurns = usage.turns === previous?.usage.turns;
    const signatures = sameTurns ? previous.signatures : new Map();
    const updates = [];
    if (!sameTurns) {
      for (const turn of usage.turns) {
        const signature = JSON.stringify(turn);
        signatures.set(turn.turnId, signature);
        if (signature !== previous?.signatures.get(turn.turnId)) updates.push(turn);
      }
    }
    const removedTurnIds = sameTurns || !previous ? []
      : [...previous.signatures.keys()].filter((id) => !signatures.has(id));
    return {
      core, extraModels, network, usage, signatures,
      coreJson: JSON.stringify(core),
      modelsJson: JSON.stringify(extraModels),
      networkJson: JSON.stringify(network),
      usageDelta: { status: usage.status, error: usage.error ?? null, updates, removedTurnIds },
    };
  }

  function updatesFor(next, previous, widget, revision) {
    if (!previous) {
      // A surviving page may still have revisions from an earlier injector.
      // Connection-scoped revisions always replace that earlier baseline.
      return [widget.widgetUpdateExpressionJson(JSON.stringify({
        ...next.core, extraModels: next.extraModels, network: next.network, tokenUsage: next.usage,
      }), revision)];
    }
    const updates = [];
    if (next.coreJson !== previous.coreJson) {
      updates.push(widget.widgetUpdateExpressionJson(JSON.stringify({
        ...next.core, extraModels: next.extraModels,
      }), revision));
    } else if (next.modelsJson !== previous.modelsJson) {
      updates.push(widget.widgetExtraModelsUpdateExpressionJson(next.modelsJson, revision));
    }
    if (next.networkJson !== previous.networkJson) {
      updates.push(widget.widgetNetworkUpdateExpressionJson(next.networkJson));
    }
    if (next.usage.status !== previous.usage.status ||
      (next.usage.error ?? null) !== (previous.usage.error ?? null) ||
      next.usageDelta.updates.length || next.usageDelta.removedTurnIds.length) {
      updates.push(widget.widgetTokenUsageDeltaUpdateExpressionJson(
        JSON.stringify(next.usageDelta), revision,
      ));
    }
    return updates;
  }

  async function pushWidgetViewModel() {
    const cdp = dependencies.cdp;
    const widget = dependencies.widget;
    if (!cdp?.isConnected || dependencies.stopped) return false;
    if (connection?.cdp !== cdp || connection?.widget !== widget) {
      connection = { id: randomUUID(), cdp, widget, installed: false, checkedAt: 0,
        snapshot: null, sentRevision: -1, updateRevision: 0 };
    }
    const current = connection;
    const isCurrent = () => connection === current && dependencies.cdp === cdp &&
      dependencies.widget === widget && !dependencies.stopped;
    if (current.installed && Date.now() - current.checkedAt >= WIDGET_HEALTH_CHECK_MS) {
      const version = await cdp.evaluate(widget.widgetRuntimeVersionExpression());
      if (!isCurrent()) return false;
      current.checkedAt = Date.now();
      current.installed = version === widget.WIDGET_RUNTIME_VERSION;
    }
    if (!current.installed) {
      const version = await cdp.evaluate(widget.widgetInstallExpression());
      if (!isCurrent()) return false;
      if (version !== widget.WIDGET_RUNTIME_VERSION) throw new Error("Widget 安装版本不匹配");
      current.installed = true;
      current.checkedAt = Date.now();
      current.snapshot = null;
      current.sentRevision = -1;
    }
    if (current.sentRevision === dataRevision) return true;
    const revision = dataRevision;
    const next = snapshot(current.snapshot);
    const updates = updatesFor(next, current.snapshot, widget, `${current.id}:${++current.updateRevision}`);
    if (updates.length) {
      // One browser task applies all channels. Missing/replaced runtimes do not
      // acknowledge delivery, so the next attempt starts with a full snapshot.
      const applied = await cdp.evaluate(`(() => {
        if (window.__codexQuotaWidget?.version !== ${widget.WIDGET_RUNTIME_VERSION}) return false;
        ${updates.join(";\n")};
        return true;
      })()`);
      if (!isCurrent()) return false;
      if (!applied) {
        current.installed = false;
        updateRequested = true;
        return false;
      }
    }
    current.snapshot = next;
    current.sentRevision = revision;
    if (dataRevision !== revision) updateRequested = true;
    return true;
  }

  function requestWidgetUpdate() {
    if (dependencies.widgetReloading) return Promise.resolve(false);
    updateRequested = true;
    if (updatePromise) return updatePromise;
    updatePromise = Promise.resolve().then(async () => {
      let applied;
      do {
        updateRequested = false;
        applied = await pushWidgetViewModel();
      } while (updateRequested && !dependencies.stopped && !dependencies.widgetReloading);
      return applied;
    }).finally(() => { updatePromise = null; });
    return updatePromise;
  }

  return {
    reset,
    whenIdle: () => updatePromise ?? Promise.resolve(),
    markWidgetDataDirty,
    requestWidgetUpdate,
  };
}

export { createWidgetSession };
