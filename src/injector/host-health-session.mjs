import {
  directHostHealth,
  hostHealthPollInterval,
  readHostHealthViewModel,
  watchHostHealthFiles,
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
    ensureHostHealthWatcher(binding, now);
    const pollMs =
      binding?.hostToolsRequired && !hostHealthWatcher?.active
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
        dependencies.markWidgetDataDirty();
      }
      return hostHealth;
    })()
      .catch((error) => {
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
