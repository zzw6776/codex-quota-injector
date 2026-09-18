import {
  directHostHealth,
  hostHealthPollInterval,
  readHostHealthViewModel,
  watchHostHealthFiles,
  requestHostToolReload,
} from "../host-health.mjs";

function createHostHealthSession(dependencies) {
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
  let scopeKey = null;
  let selectedTask = null;
  let selectedRuntime = null;

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
      if (hostHealthWatcher || key !== hostHealthWatcherKey)
        closeHostHealthWatcher();
      hostHealthWatcherKey = key;
      return;
    }
    if (
      key === hostHealthWatchAttemptKey &&
      now - lastHostHealthWatchAttemptAt < hostHealthPollInterval("starting")
    )
      return;

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
      if (dependencies.stopped) return;
      lastHostHealthCheckAt = 0;
      await syncHostHealth({ force: true });
      await dependencies.requestWidgetUpdate();
    } catch (error) {
      console.error(`[host-health] 事件刷新失败：${error.message}`);
    }
  }

  async function syncHostHealth({ force = false } = {}) {
    const now = Date.now();
    const binding = dependencies.getLaunchOptions?.()?.relay;
    const activeTask = await dependencies.readActiveTask?.() ?? null;
    const nextScopeKey = JSON.stringify([hostHealthBindingKey(binding), activeTask]);
    if (nextScopeKey !== scopeKey) {
      scopeKey = nextScopeKey;
      selectedTask = activeTask;
      selectedRuntime = null;
      lastHostHealthCheckAt = 0;
      hostHealthActionError = null;
      force = true;
      if (binding?.hostToolsRequired) {
        hostHealth = { required: true, status: activeTask?.hostId === "local" ? "starting" : "idle",
          threadId: activeTask?.hostId === "local" ? activeTask.threadId : null,
          canCheck: false, message: "正在读取当前任务的检查结果" };
        hostHealthJson = JSON.stringify(hostHealth);
        dependencies.markWidgetDataDirty();
      }
    }
    ensureHostHealthWatcher(binding, now);
    const pollMs =
      binding?.hostToolsRequired && !hostHealthWatcher?.active
        ? hostHealthPollInterval("starting")
        : hostHealthPollInterval(hostHealth.status);
    if (!force && now - lastHostHealthCheckAt < pollMs) return hostHealth;
    if (hostHealthSyncPromise) {
      await hostHealthSyncPromise;
      return syncHostHealth({ force });
    }
    lastHostHealthCheckAt = now;
    const task = (async () => {
      let next;
      if (binding?.hostToolsRequired && (!activeTask || activeTask.hostId !== "local")) {
        next = { required: true, status: "idle", threadId: null, canCheck: false,
          message: activeTask ? "当前远程任务未在本机检查" : "选择本机任务后自动检查任务工具" };
      } else {
        next = await (dependencies.readViewModel ?? readHostHealthViewModel)(binding, { threadId: activeTask?.threadId });
      }
      if (scopeKey !== nextScopeKey || dependencies.stopped) return hostHealth;
      if (activeTask && next.canCheck) {
        const runtime = `${nextScopeKey}:${next.sessionId}`;
        if (runtime !== selectedRuntime) {
          selectedRuntime = runtime;
          await (dependencies.requestCheck ?? requestHostToolReload)(binding, { action: "select", threadId: activeTask.threadId });
        }
      }
      if (scopeKey !== nextScopeKey) return hostHealth;
      const displayed = hostHealthActionError
        ? { ...next, actionError: hostHealthActionError }
        : next;
      const nextJson = JSON.stringify(displayed);
      if (nextJson !== hostHealthJson) {
        hostHealth = displayed;
        hostHealthJson = nextJson;
        dependencies.markWidgetDataDirty();
      }
      return hostHealth;
    })()
      .catch((error) => {
        if (scopeKey !== nextScopeKey) return hostHealth;
        const displayed = {
          ...hostHealth,
          status: "unconfirmed",
          code: "health-check-failed",
          message: "无法读取 Codex 任务工具状态",
          detail: error.message,
        };
        const nextJson = JSON.stringify(displayed);
        if (nextJson !== hostHealthJson) {
          hostHealth = displayed;
          hostHealthJson = nextJson;
          dependencies.markWidgetDataDirty();
        }
        return hostHealth;
      })
      .finally(() => {
        if (hostHealthSyncPromise === task) hostHealthSyncPromise = null;
      });
    hostHealthSyncPromise = task;
    return task;
  }

  return {
    get selectedTask() { return selectedTask; },
    get hostHealth() {
      return hostHealth;
    },
    set hostHealth(value) {
      hostHealth = value;
    },
    get hostHealthActionError() {
      return hostHealthActionError;
    },
    set hostHealthActionError(value) {
      hostHealthActionError = value;
    },
    get lastHostHealthCheckAt() {
      return lastHostHealthCheckAt;
    },
    set lastHostHealthCheckAt(value) {
      lastHostHealthCheckAt = value;
    },
    closeHostHealthWatcher,
    syncHostHealth,
  };
}

export { createHostHealthSession };
