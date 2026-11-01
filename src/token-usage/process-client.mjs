import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { stat } from "node:fs/promises";
import { isSea } from "node:sea";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { defaultAccountDataDir } from "../platform.mjs";
import { TokenPricingManager } from "../token-pricing.mjs";
import {
  DISCOVERY_INTERVAL_MS,
  EVENT_WATCH_DEBOUNCE_MS,
  MAX_VIEW_TURNS,
  resolveCodexHome,
} from "./contract.mjs";
import {
  TOKEN_USAGE_FULL_DISCOVERY_MS,
  TOKEN_USAGE_PROCESS_IDLE_MS,
  TOKEN_USAGE_PROCESS_PROTOCOL_VERSION,
  TOKEN_USAGE_PROCESS_REQUEST_MS,
  TOKEN_USAGE_PROCESS_SHUTDOWN_MS,
} from "./process-contract.mjs";

function unknownTurnStateViewModel() {
  return { byteLength: null, model: null, observedAt: null };
}

function sourceLauncherPath() {
  const entryPath = resolve(String(process.argv[1] ?? ""));
  const entryDirectory = dirname(entryPath);
  if (basename(entryDirectory) === "src") return join(entryDirectory, "launcher.mjs");
  return resolve(process.cwd(), "src", "launcher.mjs");
}

function milliseconds(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function tokenUsageServiceCommand({
  sea = isSea(),
  executable = process.execPath,
  launcherPath = null,
} = {}) {
  return { command: executable, args: sea ? [] : [launcherPath ?? sourceLauncherPath()] };
}

class TokenUsageProcessClient {
  constructor({
    codexHome = resolveCodexHome(),
    dataDir = defaultAccountDataDir(),
    discoveryIntervalMs = DISCOVERY_INTERVAL_MS,
    maxViewTurns = MAX_VIEW_TURNS,
    idleTimeoutMs = TOKEN_USAGE_PROCESS_IDLE_MS,
    shutdownTimeoutMs = TOKEN_USAGE_PROCESS_SHUTDOWN_MS,
    requestTimeoutMs = TOKEN_USAGE_PROCESS_REQUEST_MS,
    fullDiscoveryIntervalMs = TOKEN_USAGE_FULL_DISCOVERY_MS,
    eventWatchDebounceMs = EVENT_WATCH_DEBOUNCE_MS,
    watchSources = true,
    sea = isSea(),
    executable = process.execPath,
    launcherPath = null,
    spawnImpl = spawn,
    pricingManager = new TokenPricingManager({ dataDir }),
  } = {}) {
    this.codexHome = codexHome;
    this.dataDir = dataDir;
    this.eventPath = join(dataDir, "token-usage-events.jsonl");
    this.sessionsPath = join(codexHome, "sessions");
    this.discoveryIntervalMs = milliseconds(discoveryIntervalMs, DISCOVERY_INTERVAL_MS);
    this.maxViewTurns = Math.max(1, Number(maxViewTurns) || MAX_VIEW_TURNS);
    this.idleTimeoutMs = milliseconds(idleTimeoutMs, TOKEN_USAGE_PROCESS_IDLE_MS);
    this.shutdownTimeoutMs = milliseconds(shutdownTimeoutMs, TOKEN_USAGE_PROCESS_SHUTDOWN_MS);
    this.requestTimeoutMs = milliseconds(requestTimeoutMs, TOKEN_USAGE_PROCESS_REQUEST_MS);
    this.fullDiscoveryIntervalMs = milliseconds(
      fullDiscoveryIntervalMs,
      TOKEN_USAGE_FULL_DISCOVERY_MS,
    );
    this.eventWatchDebounceMs = milliseconds(
      eventWatchDebounceMs,
      EVENT_WATCH_DEBOUNCE_MS,
    );
    this.watchSources = Boolean(watchSources);
    this.sea = Boolean(sea);
    this.executable = executable;
    this.launcherPath = this.sea ? null : launcherPath ?? sourceLauncherPath();
    this.spawnImpl = spawnImpl;
    this.pricingManager = pricingManager;

    this.viewModel = { status: "loading", error: null, turns: [] };
    this.viewThreadId = null;
    this.turns = new Map();
    this.turnSignatures = new Map();
    this.turnStates = new Map();
    this.stateSignatures = new Map();
    this.sourceSnapshot = null;
    this.lastFullDiscoveryAt = 0;
    this.changeListeners = new Set();
    this.sourceWatchers = new Set();
    this.sourceWatcherKeys = new Set();
    this.sourceWatchTimer = null;
    this.scheduledRefresh = null;
    this.service = null;
    this.requestId = 0;
    this.activeRequests = new Set();
    this.initializationPromise = null;
    this.refreshPromise = null;
    this.pendingRefresh = null;
    this.shutdownPromise = null;
    this.initialized = false;
    this.closed = false;
    this.pricingRevision = 0;
    this.appliedPricingRevision = 0;
    this.removePricingListener = this.pricingManager.onChange?.(() => {
      this.pricingRevision += 1;
      if (this.initialized && !this.closed) {
        this.#scheduleRefresh({ notify: true, forceProcess: true, restartService: true });
      }
    }) ?? (() => {});
  }

  get servicePid() {
    return this.service?.child.pid ?? null;
  }

  onChange(listener) {
    if (typeof listener !== "function") return () => {};
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  initialize() {
    if (this.initialized) return Promise.resolve(this.viewModel);
    if (this.initializationPromise) return this.initializationPromise;
    const task = (async () => {
      await this.pricingManager.initialize?.();
      const pricingRevision = this.pricingRevision;
      const response = await this.#request("initialize", { forceDiscovery: true });
      this.appliedPricingRevision = pricingRevision;
      this.initialized = true;
      this.#applyDelta(response.delta, { notify: true });
      if (response.fullDiscoveryCompleted && response.delta?.status === "ready") {
        this.lastFullDiscoveryAt = Date.now();
      }
      this.#startSourceWatchers();
      if (this.pricingRevision !== this.appliedPricingRevision) {
        this.#scheduleRefresh({ notify: true, forceProcess: true, restartService: true });
      }
      return this.viewModel;
    })().catch((error) => {
      this.#setError(error, { notify: true });
      return this.viewModel;
    }).finally(() => {
      if (this.initializationPromise === task) this.initializationPromise = null;
    });
    this.initializationPromise = task;
    return task;
  }

  refresh({ forceDiscovery = false, forceProcess = false, notify = false } = {}) {
    if (this.closed) return Promise.resolve(this.viewModel);
    this.pendingRefresh = {
      forceDiscovery: Boolean(forceDiscovery) || Boolean(this.pendingRefresh?.forceDiscovery),
      forceProcess: Boolean(forceProcess) || Boolean(this.pendingRefresh?.forceProcess),
      notify: Boolean(notify) || Boolean(this.pendingRefresh?.notify),
    };
    if (this.refreshPromise) return this.refreshPromise;
    const task = (async () => {
      while (this.pendingRefresh && !this.closed) {
        const request = this.pendingRefresh;
        this.pendingRefresh = null;
        await this.#refreshOnce(request);
      }
      return this.viewModel;
    })().finally(() => {
      if (this.refreshPromise === task) this.refreshPromise = null;
    });
    this.refreshPromise = task;
    return task;
  }

  getViewModel() {
    return this.viewModel;
  }

  setViewThread(threadId) {
    const normalized = String(threadId ?? "").trim() || null;
    if (normalized === this.viewThreadId) return false;
    this.viewThreadId = normalized;
    if (!this.closed && (this.initialized || this.initializationPromise)) {
      this.#scheduleRefresh({ notify: true, forceProcess: true });
    }
    return true;
  }

  getTurnStateViewModel(threadId) {
    const state = this.turnStates.get(String(threadId ?? "").trim());
    return state ? { ...state } : unknownTurnStateViewModel();
  }

  async flush() {
    if (this.closed) return this.shutdownPromise;
    await Promise.allSettled([
      this.initializationPromise,
      this.refreshPromise,
      ...this.activeRequests,
    ].filter(Boolean));
    const service = this.service;
    if (!service) return;
    if (service.ending) return service.exitPromise;
    await this.#sendRequest(service, { action: "flush" });
  }

  close() {
    if (this.closed) return this.shutdownPromise;
    this.closed = true;
    this.pendingRefresh = null;
    clearTimeout(this.sourceWatchTimer);
    this.sourceWatchTimer = null;
    for (const watcher of this.sourceWatchers) watcher.close();
    this.sourceWatchers.clear();
    this.sourceWatcherKeys.clear();
    this.removePricingListener();
    this.removePricingListener = () => {};
    this.changeListeners.clear();
    this.shutdownPromise = this.#shutdown();
    // Some tests and one-shot callers only invoke close(). Keep a later
    // flush() able to observe the rejection without creating an unhandled one.
    void this.shutdownPromise.catch(() => {});
    return this.shutdownPromise;
  }

  async #refreshOnce({ forceDiscovery, forceProcess, notify }) {
    if (!this.initialized) await this.initialize();
    if (!this.initialized || this.closed) return this.viewModel;
    void Promise.resolve(this.pricingManager.refreshExchangeRate?.()).catch((error) => {
      console.error(`[exchange-rate] ${error.message}`);
    });
    const discoveryDue = this.fullDiscoveryIntervalMs === 0 ||
      Date.now() - this.lastFullDiscoveryAt >= this.fullDiscoveryIntervalMs;
    const pricingChanged = this.pricingRevision !== this.appliedPricingRevision;
    const sourceChanges = await this.#sourceChanges();
    const needsProcess = forceDiscovery || forceProcess || discoveryDue || pricingChanged ||
      sourceChanges.changed;
    if (!needsProcess) return this.viewModel;
    if (pricingChanged && this.service) await this.#beginRetirement(this.service);
    const requestForceDiscovery = forceDiscovery || discoveryDue;
    const pricingRevision = this.pricingRevision;
    try {
      const response = await this.#request("refresh", {
        forceDiscovery: requestForceDiscovery,
        rolloutPaths: sourceChanges.rolloutPaths,
      });
      this.appliedPricingRevision = pricingRevision;
      this.#applyDelta(response.delta, { notify });
      if (requestForceDiscovery && response.fullDiscoveryCompleted &&
        response.delta?.status === "ready") {
        this.lastFullDiscoveryAt = Date.now();
      }
      if (this.pricingRevision !== this.appliedPricingRevision) {
        this.#scheduleRefresh({ notify: true, forceProcess: true, restartService: true });
      }
    } catch (error) {
      this.#setError(error, { notify });
    }
    return this.viewModel;
  }

  #applyDelta(delta, { notify }) {
    if (!delta || typeof delta !== "object") throw new Error("Token 用量服务返回了无效结果");
    let turnsChanged = false;
    for (const turnId of Array.isArray(delta.removedTurnIds) ? delta.removedTurnIds : []) {
      turnsChanged = this.turns.delete(String(turnId)) || turnsChanged;
      this.turnSignatures.delete(String(turnId));
    }
    for (const update of Array.isArray(delta.turnUpdates) ? delta.turnUpdates : []) {
      const turnId = String(update?.value?.turnId ?? "");
      if (!turnId || !update?.signature) continue;
      this.turns.set(turnId, update.value);
      this.turnSignatures.set(turnId, String(update.signature));
      turnsChanged = true;
    }
    const turnIds = Array.isArray(delta.turnIds) ? delta.turnIds.map(String) : [];
    const previousIds = this.viewModel.turns.map((turn) => String(turn.turnId));
    if (turnIds.length !== previousIds.length ||
      turnIds.some((turnId, index) => turnId !== previousIds[index])) {
      turnsChanged = true;
    }

    let statesChanged = false;
    for (const threadId of Array.isArray(delta.removedStateIds) ? delta.removedStateIds : []) {
      statesChanged = this.turnStates.delete(String(threadId)) || statesChanged;
      this.stateSignatures.delete(String(threadId));
    }
    for (const update of Array.isArray(delta.stateUpdates) ? delta.stateUpdates : []) {
      const threadId = String(update?.threadId ?? "");
      if (!threadId || !update?.signature || !update?.value) continue;
      this.turnStates.set(threadId, update.value);
      this.stateSignatures.set(threadId, String(update.signature));
      statesChanged = true;
    }

    const status = String(delta.status ?? "error");
    const error = delta.error == null ? null : String(delta.error);
    const coreChanged = status !== this.viewModel.status || error !== this.viewModel.error;
    if (turnsChanged || coreChanged) {
      const turns = turnsChanged
        ? turnIds.map((turnId) => this.turns.get(turnId)).filter(Boolean)
        : this.viewModel.turns;
      this.viewModel = { status, error, turns };
    }
    this.sourceSnapshot = delta.sourceSnapshot ?? this.sourceSnapshot;
    this.#startSourceWatchers();
    if ((turnsChanged || statesChanged || coreChanged) && notify) this.#notifyChange();
    return turnsChanged || statesChanged || coreChanged;
  }

  #setError(error, { notify }) {
    const message = error?.message ?? String(error);
    const changed = this.viewModel.status !== "error" || this.viewModel.error !== message;
    if (changed) {
      this.viewModel = { ...this.viewModel, status: "error", error: message };
      if (notify) this.#notifyChange();
    }
  }

  #notifyChange() {
    for (const listener of this.changeListeners) {
      try {
        listener(this.viewModel);
      } catch (error) {
        console.error(`[token-usage] 变更监听器失败: ${error.message}`);
      }
    }
  }

  async #sourceChanges() {
    if (!this.sourceSnapshot) return { changed: true, rolloutPaths: [] };
    const expected = [
      { ...this.sourceSnapshot.event, rollout: false },
      ...(Array.isArray(this.sourceSnapshot.rollouts) ? this.sourceSnapshot.rollouts : [])
        .map((entry) => ({ ...entry, rollout: true })),
    ].filter((entry) => entry?.path);
    const results = await Promise.all(expected.map(async (entry) => {
      try {
        const info = await stat(entry.path);
        const same = entry.exists === true && info.size === Number(entry.size) &&
          (entry.mtimeMs == null || info.mtimeMs === Number(entry.mtimeMs));
        return { entry, same };
      } catch (error) {
        if (error.code === "ENOENT") return { entry, same: entry.exists === false };
        return { entry, same: false };
      }
    }));
    return {
      changed: results.some((result) => !result.same),
      rolloutPaths: results
        .filter((result) => !result.same && result.entry.rollout)
        .map((result) => result.entry.path),
    };
  }

  #startSourceWatchers() {
    if (!this.watchSources || this.closed) return;
    this.#watchDirectory(dirname(this.eventPath), { persistent: false },
      (_eventType, fileName) => {
        if (fileName && String(fileName) !== basename(this.eventPath)) return;
        this.#scheduleRefresh({ notify: true });
      });
    this.#startSessionsWatcher();
    this.#watchDirectory(this.codexHome, { persistent: false },
      (eventType, fileName) => {
        if (eventType === "rename" && (!fileName || String(fileName) === "sessions")) {
          this.#startSessionsWatcher();
          this.#scheduleRefresh({ notify: true, forceDiscovery: true });
        }
      });
  }

  #startSessionsWatcher() {
    this.#watchDirectory(this.sessionsPath, { persistent: false, recursive: true },
      (eventType, fileName) => {
        // Existing rollout growth is covered by the 15-second source probe.
        // Creation/rotation and a resumed rollout no longer present in the
        // compact probe set need an immediate catalog discovery.
        const changedName = fileName ? basename(String(fileName)) : null;
        const known = changedName && this.sourceSnapshot?.rollouts?.some((entry) =>
          basename(String(entry.path)) === changedName);
        if (eventType === "rename" || (eventType === "change" && changedName && !known)) {
          this.#scheduleRefresh({ notify: true, forceDiscovery: true });
        }
      });
  }

  #watchDirectory(path, options, listener) {
    const key = `${path}\u0000${options.recursive === true ? "recursive" : "direct"}`;
    if (this.sourceWatcherKeys.has(key)) return;
    try {
      const watcher = watch(path, options, listener);
      this.sourceWatchers.add(watcher);
      this.sourceWatcherKeys.add(key);
      watcher.on("error", (error) => {
        if (!this.sourceWatchers.delete(watcher)) return;
        this.sourceWatcherKeys.delete(key);
        watcher.close();
        console.warn(`[token-usage] 文件监听已回退到定时探测：${error.message}`);
      });
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn(`[token-usage] 无法监听 ${path}，已回退到定时探测：${error.message}`);
      }
    }
  }

  #scheduleRefresh({
    notify = false,
    forceDiscovery = false,
    forceProcess = false,
    restartService = false,
  } = {}) {
    if (this.closed) return;
    this.scheduledRefresh = {
      notify: Boolean(notify) || Boolean(this.scheduledRefresh?.notify),
      forceDiscovery: Boolean(forceDiscovery) || Boolean(this.scheduledRefresh?.forceDiscovery),
      forceProcess: Boolean(forceProcess) || Boolean(this.scheduledRefresh?.forceProcess),
      restartService: Boolean(restartService) || Boolean(this.scheduledRefresh?.restartService),
    };
    clearTimeout(this.sourceWatchTimer);
    this.sourceWatchTimer = setTimeout(() => {
      this.sourceWatchTimer = null;
      const request = this.scheduledRefresh;
      this.scheduledRefresh = null;
      void (async () => {
        if (request.restartService && this.service) {
          await this.#beginRetirement(this.service);
        }
        await this.refresh(request);
      })().catch((error) => this.#setError(error, { notify: request.notify }));
    }, this.eventWatchDebounceMs);
    this.sourceWatchTimer.unref?.();
  }

  async #request(action, { forceDiscovery = false, rolloutPaths = [] } = {}) {
    const service = await this.#ensureService();
    return this.#sendRequest(service, {
      action,
      forceDiscovery,
      rolloutPaths,
      viewThreadId: this.viewThreadId,
      turnSignatures: [...this.turnSignatures],
      stateSignatures: [...this.stateSignatures],
    });
  }

  async #ensureService() {
    if (this.closed) throw new Error("Token 用量客户端已关闭");
    if (this.service?.ending) await this.service.exitPromise;
    if (this.service) return this.service;
    const { command, args } = tokenUsageServiceCommand({
      sea: this.sea,
      executable: this.executable,
      launcherPath: this.launcherPath,
    });
    const child = this.spawnImpl(command, args, {
      env: {
        ...process.env,
        CODEX_QUOTA_ROLE: "token-usage-service",
        CODEX_QUOTA_TOKEN_USAGE_CODEX_HOME: this.codexHome,
        CODEX_QUOTA_TOKEN_USAGE_DATA_DIR: this.dataDir,
        CODEX_QUOTA_TOKEN_USAGE_DISCOVERY_INTERVAL_MS: String(this.discoveryIntervalMs),
        CODEX_QUOTA_TOKEN_USAGE_MAX_VIEW_TURNS: String(this.maxViewTurns),
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const service = {
      child,
      requests: new Map(),
      ending: false,
      retireWhenIdle: false,
      idleTimer: null,
      forceTimer: null,
      resolveExit: null,
      exitPromise: null,
      reader: null,
    };
    service.exitPromise = new Promise((resolve) => { service.resolveExit = resolve; });
    this.service = service;
    service.reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    service.reader.on("line", (line) => this.#handleProtocolLine(service, line));
    service.reader.on("error", (error) => this.#failService(service, error));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      const message = String(chunk).trimEnd();
      if (message) console.error(`[token-usage-service] ${message}`);
    });
    child.stdin.on("error", (error) => this.#failService(service, error));
    child.once("error", (error) => this.#failService(service, error));
    child.once("close", (code, signal) => this.#handleServiceClose(service, code, signal));
    return service;
  }

  #sendRequest(service, body) {
    clearTimeout(service.idleTimer);
    service.idleTimer = null;
    const id = ++this.requestId;
    const message = {
      protocol: TOKEN_USAGE_PROCESS_PROTOCOL_VERSION,
      id,
      ...body,
    };
    const request = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        service.requests.delete(id);
        reject(new Error(`Token 用量服务请求超时（${body.action}）`));
        service.child.kill();
      }, this.requestTimeoutMs);
      timer.unref?.();
      service.requests.set(id, { resolve, reject, timer });
      try {
        service.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
          if (!error) return;
          const pending = service.requests.get(id);
          if (!pending) return;
          service.requests.delete(id);
          clearTimeout(pending.timer);
          pending.reject(error);
        });
      } catch (error) {
        service.requests.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
    this.activeRequests.add(request);
    request.then(
      () => this.activeRequests.delete(request),
      () => this.activeRequests.delete(request),
    );
    return request;
  }

  #handleProtocolLine(service, line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.#failService(service, new Error(`Token 用量服务协议损坏：${error.message}`));
      return;
    }
    if (message?.protocol !== TOKEN_USAGE_PROCESS_PROTOCOL_VERSION ||
      message?.type !== "response") return;
    const pending = service.requests.get(message.id);
    if (!pending) return;
    service.requests.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message);
    else pending.reject(new Error(message.error || "Token 用量服务执行失败"));
    this.#afterServiceRequest(service);
  }

  #afterServiceRequest(service) {
    if (service.requests.size > 0) return;
    if (service.retireWhenIdle) {
      void this.#beginRetirement(service);
      return;
    }
    clearTimeout(service.idleTimer);
    service.idleTimer = setTimeout(() => {
      service.idleTimer = null;
      void this.#beginRetirement(service);
    }, this.idleTimeoutMs);
    service.idleTimer.unref?.();
  }

  #failService(service, error) {
    for (const pending of service.requests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    service.requests.clear();
    if (!service.ending) service.child.kill();
  }

  #handleServiceClose(service, code, signal) {
    clearTimeout(service.idleTimer);
    clearTimeout(service.forceTimer);
    service.reader?.close();
    const error = new Error(
      `Token 用量服务已退出（${signal || (code ?? "unknown")}）`,
    );
    for (const pending of service.requests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    service.requests.clear();
    if (this.service === service) this.service = null;
    service.resolveExit();
    if (!service.ending && code !== 0 && !this.closed) {
      console.error(`[token-usage] ${error.message}`);
    }
  }

  #beginRetirement(service) {
    if (!service || this.service !== service) return Promise.resolve();
    if (service.ending) return service.exitPromise;
    if (service.requests.size > 0) {
      service.retireWhenIdle = true;
      return service.exitPromise;
    }
    service.ending = true;
    clearTimeout(service.idleTimer);
    service.idleTimer = null;
    service.child.stdin.end();
    service.forceTimer = setTimeout(() => service.child.kill(), this.shutdownTimeoutMs);
    service.forceTimer.unref?.();
    return service.exitPromise;
  }

  async #shutdown() {
    await Promise.allSettled([
      this.initializationPromise,
      this.refreshPromise,
      ...this.activeRequests,
    ].filter(Boolean));
    const service = this.service;
    if (!service) return;
    let flushError = null;
    if (!service.ending) {
      try {
        await this.#sendRequest(service, { action: "flush" });
      } catch (error) {
        flushError = error;
      }
    }
    await this.#beginRetirement(service);
    if (flushError) throw flushError;
  }
}

export { TokenUsageProcessClient, tokenUsageServiceCommand };
