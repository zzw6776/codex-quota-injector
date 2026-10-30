import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { defaultAccountDataDir } from "../platform/directories.mjs";
import { resolveCodexCliExecutable } from "../platform/executables.mjs";
import {
  installCodexRuntime,
  readCodexRuntimeFingerprint,
  readCodexRuntimeVersion,
  readRuntimeMetadata,
  verifyCodexRuntime,
  verifyManagedCodexRuntime,
} from "./install.mjs";
import {
  codexReleaseCandidate,
  compareCodexVersions,
  fetchCodexReleases,
  parseCodexVersion,
  supportsMcpConnectionSharing,
} from "./releases.mjs";

const SETTINGS_VERSION = 4;
const SETTINGS_FILE = "codex-runtime-settings.json";
const RUNTIME_DIRECTORY = "codex-runtimes";
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MODES = new Set(["bundled", "alpha", "custom"]);
const RUNTIME_DISPOSITIONS = new Set([
  "selected",
  "degraded-official",
  "runtime-fallback",
]);

function defaultSettings() {
  return {
    version: SETTINGS_VERSION,
    mode: "bundled",
    alphaVersion: null,
    customPath: null,
    mcpConnectionSharingEnabled: false,
    bundledVersionAtLastLaunch: null,
    lastKnownGood: null,
  };
}

function normalizeSelection(value) {
  if (!value || !MODES.has(value.mode)) return null;
  const version = parseCodexVersion(value.version)?.raw ?? null;
  const executable = typeof value.executable === "string" && isAbsolute(value.executable)
    ? resolve(value.executable)
    : null;
  if (!version || !executable) return null;
  return {
    mode: value.mode,
    version,
    executable,
    fingerprint: normalizeFingerprint(value.fingerprint),
    mcpConnectionSharing: value.mcpConnectionSharing === true &&
      supportsMcpConnectionSharing(version),
  };
}

function normalizeFingerprint(value) {
  if (!value || typeof value.realpath !== "string" || !isAbsolute(value.realpath)) return null;
  const fields = ["dev", "ino", "size", "mtimeNs"];
  if (fields.some((field) => !/^\d+$/.test(String(value[field] ?? "")))) return null;
  return {
    realpath: resolve(value.realpath),
    dev: String(value.dev),
    ino: String(value.ino),
    size: String(value.size),
    mtimeNs: String(value.mtimeNs),
  };
}

function fingerprintKey(value) {
  const fingerprint = normalizeFingerprint(value);
  return fingerprint
    ? JSON.stringify([
        fingerprint.realpath,
        fingerprint.dev,
        fingerprint.ino,
        fingerprint.size,
        fingerprint.mtimeNs,
      ])
    : null;
}

function runtimeId(selection, mcpConnectionSharing = false) {
  return createHash("sha256")
    .update(JSON.stringify([
      selection?.mode ?? null,
      selection?.version ?? null,
      typeof selection?.executable === "string" ? resolve(selection.executable) : null,
      fingerprintKey(selection?.fingerprint),
      mcpConnectionSharing === true,
    ]))
    .digest("hex");
}

function normalizeSettings(value) {
  if (!value || ![1, 2, 3, SETTINGS_VERSION].includes(value.version) || !MODES.has(value.mode)) {
    return defaultSettings();
  }
  return {
    version: SETTINGS_VERSION,
    mode: value.mode,
    alphaVersion: parseCodexVersion(value.alphaVersion)?.raw ?? null,
    customPath: typeof value.customPath === "string" && isAbsolute(value.customPath)
      ? resolve(value.customPath)
      : null,
    mcpConnectionSharingEnabled: value.version >= 2 &&
      value.mcpConnectionSharingEnabled === true,
    bundledVersionAtLastLaunch: value.version >= 3
      ? parseCodexVersion(
          value.bundledVersionAtLastLaunch ?? value.bundledVersionAtValidation,
        )?.raw ?? null
      : null,
    lastKnownGood: normalizeSelection(value.lastKnownGood),
  };
}

function selectionKey(selection) {
  return selection
    ? JSON.stringify([
        selection.mode,
        selection.version,
        typeof selection.executable === "string" ? resolve(selection.executable) : null,
        fingerprintKey(selection.fingerprint),
        selection.mcpConnectionSharing === true,
      ])
    : null;
}

async function resolveBundledCodexRuntime() {
  const environment = { ...process.env };
  delete environment.CODEX_QUOTA_UPSTREAM_CODEX_CLI;
  return resolveCodexCliExecutable({ environment, platform: "darwin" });
}

export class CodexRuntimeManager {
  constructor({
    platform = process.platform,
    arch = process.arch,
    dataDir = defaultAccountDataDir(),
    resolveBundled = resolveBundledCodexRuntime,
    readVersion = readCodexRuntimeVersion,
    readFingerprint = readCodexRuntimeFingerprint,
    verifyRuntime = verifyCodexRuntime,
    verifyManagedRuntime = verifyManagedCodexRuntime,
    fetchReleases = fetchCodexReleases,
    selectCandidate = codexReleaseCandidate,
    installRuntime = installCodexRuntime,
    onChange = () => {},
    intervalMs = CHECK_INTERVAL_MS,
  } = {}) {
    Object.assign(this, {
      platform,
      arch,
      dataDir,
      resolveBundled,
      readVersion,
      readFingerprint,
      verifyRuntime,
      verifyManagedRuntime,
      fetchReleases,
      selectCandidate,
      installRuntime,
      intervalMs,
    });
    this.settingsPath = join(dataDir, SETTINGS_FILE);
    this.runtimeRoot = join(dataDir, RUNTIME_DIRECTORY);
    this.settings = defaultSettings();
    this.bundled = null;
    this.runtimeState = {
      validated: null,
      active: null,
      fallbackAttempt: null,
    };
    this.installed = [];
    this.candidate = null;
    this.etag = null;
    this.initialized = false;
    this.initializing = null;
    this.closed = false;
    this.checking = null;
    this.installing = null;
    this.abortController = null;
    this.bundledVersionChanged = false;
    this.listeners = new Set([onChange].filter((listener) => typeof listener === "function"));
    this.view = {
      supported: platform === "darwin" && ["arm64", "x64"].includes(arch),
      status: "idle",
      mode: "bundled",
      customPath: null,
      bundled: null,
      selected: null,
      active: null,
      installed: [],
      latest: null,
      available: false,
      pendingRestart: false,
      fallback: null,
      bundledUpdate: null,
      mcpConnectionSharing: {
        compatible: false,
        enabled: false,
        selected: false,
        active: false,
      },
      operation: null,
      message: null,
      error: null,
      settingsPath: this.settingsPath,
    };
  }

  async initialize() {
    if (this.initialized) return this.getViewModel();
    if (this.initializing) return this.initializing;
    this.initializing = this.initializeOnce().finally(() => {
      this.initializing = null;
    });
    return this.initializing;
  }

  async initializeOnce() {
    if (!this.view.supported) {
      this.initialized = true;
      this.publish({ status: "unsupported", error: null });
      return this.getViewModel();
    }
    let settingsError = null;
    try {
      this.settings = normalizeSettings(JSON.parse(await readFile(this.settingsPath, "utf8")));
    } catch (error) {
      if (error?.code !== "ENOENT") settingsError = `Codex 后端设置读取失败，已使用内置版本：${error.message}`;
      this.settings = defaultSettings();
    }
    const previousBundledVersion = this.settings.bundledVersionAtLastLaunch;
    this.bundled = await this.resolveBundledSnapshot();
    const version = this.bundled.version;
    this.bundledVersionChanged = previousBundledVersion != null &&
      previousBundledVersion !== version;
    await this.refreshInstalled();
    const resolution = await this.resolveConfiguredSelection({
      preferBundled: this.bundledVersionChanged,
    });
    this.runtimeState.validated = resolution.selection;
    const selected = this.launchSelection(this.runtimeState.validated, {
      fallback: resolution.fallback != null,
    });
    const bundledUpdate = this.bundledVersionChanged && this.settings.mode !== "bundled"
      ? {
          previousVersion: previousBundledVersion,
          currentVersion: version,
          selectedVersion: selected.version,
          status: resolution.fallback == null ? "revalidated" : "fallback",
        }
      : null;
    this.publish({
      status: "ready",
      mode: this.settings.mode,
      customPath: this.settings.customPath,
      bundled: this.bundled,
      selected,
      installed: this.installed,
      fallback: resolution.fallback,
      bundledUpdate,
      mcpConnectionSharing: this.sharingView(selected),
      error: settingsError ?? resolution.error,
    });
    this.initialized = true;
    return this.getViewModel();
  }

  getViewModel() {
    return structuredClone(this.view);
  }

  onChange(listener) {
    if (typeof listener !== "function") return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(patch) {
    if (this.closed) return;
    this.view = { ...this.view, ...patch };
    for (const listener of this.listeners) {
      try {
        listener(this.getViewModel());
      } catch (error) {
        console.error(`[codex-runtime] 状态监听失败：${error.message}`);
      }
    }
  }

  launchSelection(selection = this.runtimeState.validated, { fallback = false } = {}) {
    if (!selection) return null;
    const requested = fallback
      ? selection.mcpConnectionSharing === true
      : this.settings.mcpConnectionSharingEnabled === true;
    const mcpConnectionSharing = requested && supportsMcpConnectionSharing(selection.version);
    return {
      ...selection,
      mcpConnectionSharing,
      runtimeId: runtimeId(selection, mcpConnectionSharing),
    };
  }

  sharingView(selected = this.view.selected) {
    return {
      compatible: supportsMcpConnectionSharing(selected?.version),
      enabled: this.settings.mcpConnectionSharingEnabled === true,
      selected: selected?.mcpConnectionSharing === true,
      active: this.runtimeState.active?.mcpConnectionSharing === true,
    };
  }

  start() {
    if (this.timer || this.closed || !this.view.supported) return;
    const check = () => void this.check().catch((error) => {
      console.warn(`[codex-runtime] 后台版本检查失败：${error.message}`);
    });
    check();
    this.timer = setInterval(check, this.intervalMs);
    this.timer.unref?.();
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.abortController?.abort(new Error("Codex 后端管理器已关闭"));
    this.listeners.clear();
  }

  async ensureValidatedRuntimeCurrent() {
    const selection = this.runtimeState.validated;
    if (!selection) return null;
    let currentFingerprint;
    try {
      currentFingerprint = await this.readFingerprint(selection.executable);
    } catch (error) {
      if (selection.mode === "bundled") throw error;
      await this.stageFallback(selection, error, { validation: true });
      return this.runtimeState.validated;
    }
    if (fingerprintKey(currentFingerprint) === fingerprintKey(selection.fingerprint)) {
      return selection;
    }

    try {
      const requested = selection.mode === "alpha"
        ? selection
        : { ...selection, version: null };
      const next = await this.verifySelection(requested, { probeBundled: true });
      this.runtimeState.validated = next;
      if (next.mode === "bundled") {
        this.bundled = next;
        this.bundledVersionChanged = this.settings.bundledVersionAtLastLaunch != null &&
          this.settings.bundledVersionAtLastLaunch !== next.version;
      }
      const selected = this.launchSelection(next, {
        fallback: this.view.fallback != null,
      });
      const pendingRestart = this.runtimeState.active != null &&
        selectionKey(this.runtimeState.active) !== selectionKey(selected);
      this.publish({
        status: "ready",
        bundled: this.bundled,
        selected,
        pendingRestart,
        error: null,
        message: `检测到 Codex 后端文件变化，已重新验证 ${next.version}`,
        available: this.isCandidateAvailable(next),
        mcpConnectionSharing: this.sharingView(selected),
      });
      return next;
    } catch (error) {
      if (selection.mode === "bundled") throw error;
      await this.stageFallback(selection, error, { validation: true });
      return this.runtimeState.validated;
    }
  }

  requiresRuntimeRestart(selected) {
    if (selected?.mode !== "bundled") return false;
    const active = this.runtimeState.active ?? this.settings.lastKnownGood;
    if (!active) return true;
    return selectionKey(active) !== selectionKey(selected);
  }

  async getLaunchRuntime() {
    await this.initialize();
    if (!this.view.supported) return null;
    if (!this.runtimeState.fallbackAttempt) await this.ensureValidatedRuntimeCurrent();
    if (this.runtimeState.fallbackAttempt) {
      const attempt = this.runtimeState.fallbackAttempt;
      const selected = this.launchSelection(attempt.selection, { fallback: true });
      this.runtimeState.validated = attempt.selection;
      this.publish({
        mode: selected.mode,
        customPath: selected.mode === "custom"
          ? selected.executable
          : this.settings.customPath,
        selected,
        fallback: attempt.fallback,
        pendingRestart: true,
        mcpConnectionSharing: this.sharingView(selected),
      });
      return {
        ...selected,
        managed: selected.mode !== "bundled",
        requestedMode: attempt.fallback.requestedMode,
        fallback: true,
        forceRestart: this.requiresRuntimeRestart(selected),
      };
    }
    const fallback = this.view.fallback != null;
    const selected = this.launchSelection(this.runtimeState.validated, { fallback });
    return {
      ...selected,
      managed: selected.mode !== "bundled",
      requestedMode: this.settings.mode,
      fallback,
      forceRestart: this.requiresRuntimeRestart(selected),
    };
  }

  async getOfficialFallbackRuntime(requestedRuntime = null) {
    await this.initialize();
    if (!this.view.supported || !this.bundled) return null;
    const selected = this.launchSelection(this.bundled, { fallback: true });
    return {
      ...selected,
      managed: false,
      requestedMode: requestedRuntime?.requestedMode ?? this.settings.mode,
      fallback: false,
      forceRestart: this.requiresRuntimeRestart(selected),
    };
  }

  async confirmLaunch({ runtime, disposition } = {}) {
    await this.initialize();
    if (!runtime) return;
    if (!RUNTIME_DISPOSITIONS.has(disposition)) {
      throw new Error("Codex 后端启动确认类型无效");
    }
    const normalized = normalizeSelection(runtime);
    if (!normalized) throw new Error("实际启动的 Codex 后端身份无效");
    const mcpConnectionSharing = normalized.mcpConnectionSharing === true;
    const active = {
      ...normalized,
      mcpConnectionSharing,
      runtimeId: runtimeId(normalized, mcpConnectionSharing),
    };
    const fallbackAttempt = this.runtimeState.fallbackAttempt;
    const expected = disposition === "runtime-fallback"
      ? fallbackAttempt?.selection
        ? this.launchSelection(fallbackAttempt.selection, { fallback: true })
        : this.view.fallback
          ? this.view.selected
          : null
      : disposition === "degraded-official"
        ? this.launchSelection(this.bundled, { fallback: true })
        : this.view.fallback == null
          ? this.view.selected
          : null;
    if (!expected || selectionKey(active) !== selectionKey(expected)) {
      throw new Error("实际启动的 Codex 后端与待确认运行时不一致");
    }
    const fallbackApplied = disposition === "runtime-fallback";
    let nextSettings = this.settings;
    if (fallbackApplied) {
      nextSettings = {
        ...this.settings,
        mode: active.mode,
        alphaVersion: active.mode === "alpha"
          ? active.version
          : this.settings.alphaVersion,
        customPath: active.mode === "custom"
          ? active.executable
          : this.settings.customPath,
        mcpConnectionSharingEnabled: active.mcpConnectionSharing,
        lastKnownGood: active,
        bundledVersionAtLastLaunch: this.bundled.version,
      };
    } else if (selectionKey(this.settings.lastKnownGood) !== selectionKey(active) ||
      this.settings.bundledVersionAtLastLaunch !== this.bundled.version) {
      nextSettings = {
        ...this.settings,
        lastKnownGood: active,
        bundledVersionAtLastLaunch: this.bundled.version,
      };
    }
    if (nextSettings !== this.settings) await this.persistSettings(nextSettings);
    this.settings = nextSettings;
    if (fallbackApplied) this.runtimeState.fallbackAttempt = null;
    this.runtimeState.active = active;
    if (disposition !== "degraded-official") this.runtimeState.validated = active;
    this.bundledVersionChanged = false;
    const selected = disposition === "degraded-official" ? this.view.selected : active;
    const pendingRestart = disposition === "degraded-official" &&
      selectionKey(active) !== selectionKey(selected);
    this.publish({
      active,
      selected,
      mode: this.settings.mode,
      customPath: this.settings.customPath,
      fallback: fallbackApplied ? null : this.view.fallback,
      pendingRestart,
      error: fallbackApplied ? null : this.view.error,
      message: fallbackApplied
        ? `已回退并使用 ${active.version}`
        : disposition === "degraded-official"
          ? `当前实际使用桌面内置 ${active.version}，已保留所选后端等待下次重启重试`
          : this.view.message,
      mcpConnectionSharing: this.sharingView(selected),
    });
  }

  async launchWithFallback(options, { launch, prepare }) {
    if (typeof launch !== "function" || typeof prepare !== "function") {
      throw new Error("Codex 后端启动回退缺少执行函数");
    }
    try {
      return { options, result: await launch(options) };
    } catch (error) {
      const readiness = error?.codexReadiness;
      const runtimeFailure = options?.codexRuntime?.managed === true &&
        readiness?.relayRequired === true && readiness?.debugReady === true &&
        readiness?.relayStateReady === false;
      if (!runtimeFailure) throw error;
      const fallback = await this.rollbackAfterLaunchFailure(options.codexRuntime, error);
      if (!fallback) throw error;
      console.warn(
        `[codex-runtime] ${options.codexRuntime.version} 启动未就绪，` +
        `正在回退到 ${fallback.version}`,
      );
      try {
        const fallbackOptions = await prepare();
        return { options: fallbackOptions, result: await launch(fallbackOptions) };
      } catch (fallbackError) {
        this.cancelFallbackAttempt(fallbackError);
        throw fallbackError;
      }
    }
  }

  async rollbackAfterLaunchFailure(failedSelection, cause) {
    await this.initialize();
    if (!failedSelection?.managed || this.runtimeState.fallbackAttempt) return null;
    return this.stageFallback(failedSelection, cause);
  }

  async stageFallback(failedSelection, cause, { validation = false } = {}) {
    const fallback = await this.resolveFallbackSelection(failedSelection, {
      preferBundled: this.bundledVersionChanged,
    });
    const fallbackState = {
      requestedMode: this.view.fallback?.requestedMode ??
        failedSelection.requestedMode ?? failedSelection.mode,
      using: fallback,
    };
    this.runtimeState.fallbackAttempt = {
      selection: fallback,
      fallback: fallbackState,
      previousSelection: this.runtimeState.validated,
      previousView: {
        mode: this.view.mode,
        customPath: this.view.customPath,
        selected: this.view.selected,
        fallback: this.view.fallback,
        bundledUpdate: this.view.bundledUpdate,
        pendingRestart: this.view.pendingRestart,
        message: this.view.message,
        mcpConnectionSharing: this.view.mcpConnectionSharing,
      },
    };
    this.runtimeState.validated = fallback;
    const selected = this.launchSelection(fallback, { fallback: true });
    const reason = cause?.message ?? String(cause ?? (validation ? "验证失败" : "启动未就绪"));
    const bundledUpdate = this.view.bundledUpdate
      ? {
          ...this.view.bundledUpdate,
          selectedVersion: fallback.version,
          status: "fallback",
        }
      : null;
    this.publish({
      status: "ready",
      mode: fallback.mode,
      customPath: fallback.mode === "custom"
        ? fallback.executable
        : this.settings.customPath,
      selected,
      fallback: fallbackState,
      bundledUpdate,
      pendingRestart: true,
      operation: null,
      error: validation
        ? `所选 Codex 后端文件变化后验证失败，已自动回退：${reason}`
        : `受管 Codex 后端启动未就绪，已自动回退：${reason}`,
      message: `正在回退到 ${fallback.version}`,
      available: this.isCandidateAvailable(fallback),
      mcpConnectionSharing: this.sharingView(selected),
    });
    return selected;
  }

  cancelFallbackAttempt(cause) {
    const fallbackAttempt = this.runtimeState.fallbackAttempt;
    if (!fallbackAttempt) return false;
    this.runtimeState.fallbackAttempt = null;
    this.runtimeState.validated = fallbackAttempt.previousSelection;
    const reason = cause?.message ?? String(cause ?? "回退启动未就绪");
    this.publish({
      status: "failed",
      ...fallbackAttempt.previousView,
      operation: null,
      error: `Codex 后端自动回退也未能启动，已保留原设置：${reason}`,
    });
    return true;
  }

  check({ force = false } = {}) {
    if (this.checking) return this.checking;
    this.checking = (async () => {
      await this.initialize();
      if (!this.view.supported) return null;
      this.publish({ status: "checking", operation: { type: "check" }, error: null });
      try {
        const result = await this.fetchReleases({ etag: force ? null : this.etag });
        if (!result.unchanged) {
          this.etag = result.etag;
          this.candidate = this.selectCandidate(result.releases, {
            arch: this.arch,
            channel: "alpha",
          });
        }
        const available = this.isCandidateAvailable();
        this.publish({
          status: "ready",
          latest: this.candidate,
          available,
          operation: null,
          error: null,
          message: this.candidate
            ? available
              ? `发现 Codex ${this.candidate.version}`
              : `Codex ${this.candidate.version} 已在本机`
            : "未找到适用于当前架构的官方 Alpha",
        });
        return this.candidate;
      } catch (error) {
        this.publish({ status: "failed", operation: null, error: error.message });
        throw error;
      }
    })().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  installLatest() {
    if (this.installing) return this.installing;
    this.installing = (async () => {
      const candidate = await this.check({ force: true });
      if (!candidate) throw new Error("没有可安装的 Codex Alpha");
      const installed = this.installed.find((item) => item.version === candidate.version);
      if (installed) {
        await this.applySelection({ mode: "alpha", version: installed.version });
        return installed;
      }
      this.abortController = new AbortController();
      this.publish({
        status: "downloading",
        operation: { type: "install", received: 0, total: candidate.size },
        error: null,
        message: `正在下载 Codex ${candidate.version}`,
      });
      try {
        const result = await this.installRuntime(candidate, {
          root: this.runtimeRoot,
          arch: this.arch,
          signal: this.abortController.signal,
          onProgress: (received, total) => this.publish({
            operation: { type: "install", received, total },
          }),
        });
        await this.refreshInstalled();
        await this.applySelection({ mode: "alpha", version: result.version }, {
          verified: result,
          message: `Codex ${result.version} 已安装并选中，重启 Codex 后生效`,
        });
        return result;
      } catch (error) {
        this.publish({ status: "failed", operation: null, error: error.message });
        throw error;
      } finally {
        this.abortController = null;
      }
    })().finally(() => {
      this.installing = null;
    });
    return this.installing;
  }

  async select(input) {
    await this.initialize();
    if (!this.view.supported) throw new Error("受管 Codex 后端当前仅支持 macOS arm64/x64");
    if (this.installing) throw new Error("Codex 后端正在安装，请等待完成");
    this.publish({ status: "verifying", operation: { type: "verify" }, error: null });
    try {
      return await this.applySelection(input);
    } catch (error) {
      this.publish({ status: "failed", operation: null, error: error.message });
      throw error;
    }
  }

  async setMcpConnectionSharing(enabled) {
    await this.initialize();
    const nextEnabled = enabled === true;
    const rejection = nextEnabled && this.view.fallback
      ? "当前 Codex 后端处于回退状态，请先选择一个有效版本"
      : nextEnabled && !supportsMcpConnectionSharing(this.runtimeState.validated?.version)
        ? "所选 Codex 后端不支持 MCP 连接共享，需要 0.166.0-alpha.1 或更高版本"
        : null;
    if (rejection) {
      this.publish({ status: "failed", operation: null, error: rejection });
      throw new Error(rejection);
    }
    if (nextEnabled) {
      this.publish({ status: "verifying", operation: { type: "verify" }, error: null });
      try {
        await this.verifySelection(this.runtimeState.validated, { sharingEnabled: true });
      } catch (error) {
        const message = `MCP 连接共享兼容性验证失败：${error.message}`;
        this.publish({ status: "failed", operation: null, error: message });
        throw new Error(message, { cause: error });
      }
    }
    const nextSettings = {
      ...this.settings,
      mcpConnectionSharingEnabled: nextEnabled,
    };
    try {
      await this.persistSettings(nextSettings);
    } catch (error) {
      this.publish({ status: "failed", operation: null, error: error.message });
      throw error;
    }
    this.settings = nextSettings;
    const selected = this.launchSelection(this.runtimeState.validated, {
      fallback: this.view.fallback != null,
    });
    const pendingRestart = this.runtimeState.active != null &&
      selectionKey(this.runtimeState.active) !== selectionKey(selected);
    this.publish({
      status: "ready",
      selected,
      pendingRestart,
      operation: null,
      error: null,
      message: pendingRestart
        ? `已${nextEnabled ? "启用" : "关闭"}实验性 MCP 连接共享，重启 Codex 后生效`
        : `实验性 MCP 连接共享已${nextEnabled ? "启用" : "关闭"}，当前运行配置无需变化`,
      mcpConnectionSharing: this.sharingView(selected),
    });
    return this.sharingView(selected);
  }

  async applySelection(input, { verified = null, message = null } = {}) {
    const mode = String(input?.mode ?? "");
    if (!MODES.has(mode)) throw new Error("Codex 后端来源无效");
    let requested;
    if (mode === "bundled") {
      requested = this.bundled;
    } else if (mode === "alpha") {
      const version = parseCodexVersion(input?.version)?.raw ?? null;
      requested = this.installed.find((item) => item.version === version);
      if (!requested) throw new Error(`Codex ${version ?? "Alpha"} 尚未安装`);
    } else {
      const path = String(input?.path ?? "").trim();
      if (!isAbsolute(path)) throw new Error("自定义 Codex 后端必须使用绝对路径");
      requested = { mode: "custom", executable: resolve(path), version: null };
    }
    const next = await this.verifySelection(requested, { verified });
    const nextSettings = {
      ...this.settings,
      mode,
      alphaVersion: mode === "alpha" ? next.version : this.settings.alphaVersion,
      customPath: mode === "custom" ? next.executable : this.settings.customPath,
    };
    await this.persistSettings(nextSettings);
    this.settings = nextSettings;
    this.runtimeState.fallbackAttempt = null;
    this.runtimeState.validated = next;
    this.bundledVersionChanged = false;
    const selected = this.launchSelection(next);
    const pendingRestart = this.runtimeState.active != null &&
      selectionKey(this.runtimeState.active) !== selectionKey(selected);
    this.publish({
      status: "ready",
      mode,
      customPath: this.settings.customPath,
      selected,
      installed: this.installed,
      fallback: null,
      bundledUpdate: null,
      pendingRestart,
      operation: null,
      error: null,
      message: message ?? (pendingRestart
        ? `已选择 Codex ${next.version}，重启 Codex 后生效`
        : `当前已选择 Codex ${next.version}`),
      available: this.isCandidateAvailable(next),
      mcpConnectionSharing: this.sharingView(selected),
    });
    return next;
  }

  async resolveConfiguredSelection({ preferBundled = this.bundledVersionChanged } = {}) {
    try {
      return { selection: await this.selectionFromSettings(this.settings), fallback: null, error: null };
    } catch (error) {
      const requestedError = error.message;
      const failedSelection = {
        mode: this.settings.mode,
        version: this.settings.mode === "alpha" ? this.settings.alphaVersion : null,
        executable: this.settings.mode === "custom" ? this.settings.customPath : null,
        mcpConnectionSharing: this.settings.mcpConnectionSharingEnabled === true,
      };
      const fallback = await this.resolveFallbackSelection(failedSelection, { preferBundled });
      const usedBundled = fallback.mode === "bundled";
      return {
        selection: fallback,
        fallback: { requestedMode: this.settings.mode, using: fallback },
        error: usedBundled
          ? `所选 Codex 后端不可用，已回退到桌面内置版本：${requestedError}`
          : `所选 Codex 后端不可用，已回退到上次可用版本：${requestedError}`,
      };
    }
  }

  async resolveFallbackSelection(failedSelection, {
    preferBundled = this.bundledVersionChanged,
  } = {}) {
    if (!preferBundled) {
      const failedKey = selectionKey(failedSelection);
      const lastKnownGood = this.settings.lastKnownGood;
      if (lastKnownGood && selectionKey(lastKnownGood) !== failedKey &&
        selectionKey(lastKnownGood) !== selectionKey(this.bundled)) {
        try {
          return await this.validateStoredSelection(lastKnownGood);
        } catch {
          // Continue to the bundled fallback below.
        }
      }
    }
    return {
      ...await this.resolveBundledSnapshot({ probe: true }),
      mcpConnectionSharing: false,
    };
  }

  async resolveBundledSnapshot({ probe = false } = {}) {
    const executable = resolve(await this.resolveBundled());
    return this.verifySelection({
      mode: "bundled",
      executable,
      version: null,
    }, {
      sharingEnabled: false,
      probeBundled: probe,
    });
  }

  shouldEnableMcpConnectionSharing(
    version,
    enabled = this.settings.mcpConnectionSharingEnabled === true,
  ) {
    return enabled === true &&
      supportsMcpConnectionSharing(version);
  }

  appServerArguments(
    version,
    enabled = this.settings.mcpConnectionSharingEnabled === true,
  ) {
    return this.shouldEnableMcpConnectionSharing(version, enabled)
      ? ["app-server", "-c", "features.mcp_connection_sharing=true"]
      : ["app-server"];
  }

  async verifySelection(selection, {
    verified = null,
    sharingEnabled = this.settings.mcpConnectionSharingEnabled === true,
    verifyBundledVersion = false,
    probeBundled = false,
  } = {}) {
    const executable = resolve(selection.executable);
    const version = selection.version ?? await this.readVersion(executable);
    const sharing = this.shouldEnableMcpConnectionSharing(version, sharingEnabled);
    if (selection.mode === "bundled" && !sharing && !probeBundled) {
      if (verifyBundledVersion && await this.readVersion(executable) !== version) {
        throw new Error("上次可用 Codex 后端版本已变化");
      }
      return {
        mode: "bundled",
        version,
        executable,
        fingerprint: await this.readFingerprint(executable),
      };
    }
    const checked = verified && selection.mode === "alpha" && !sharing
      ? verified
      : selection.mode === "alpha"
        ? await this.verifyManagedRuntime(executable, {
            expectedVersion: version,
            arch: this.arch,
            appServerArguments: this.appServerArguments(version, sharingEnabled),
          })
        : await this.verifyRuntime(executable, {
            expectedVersion: version,
            appServerArguments: this.appServerArguments(version, sharingEnabled),
          });
    return {
      mode: selection.mode,
      version: checked.version,
      executable: checked.executable,
      fingerprint: await this.readFingerprint(checked.executable),
    };
  }

  async selectionFromSettings(settings) {
    let selection;
    if (settings.mode === "bundled") {
      selection = this.bundled;
    } else if (settings.mode === "alpha") {
      selection = this.installed.find((item) => item.version === settings.alphaVersion);
      if (!selection) throw new Error(`Codex ${settings.alphaVersion ?? "Alpha"} 未安装或已损坏`);
    } else {
      if (!settings.customPath) throw new Error("自定义 Codex 后端路径为空");
      selection = { mode: "custom", executable: resolve(settings.customPath), version: null };
    }
    return this.verifySelection(selection);
  }

  async validateStoredSelection(selection) {
    const checked = await this.verifySelection(selection, {
      sharingEnabled: selection.mcpConnectionSharing === true,
      verifyBundledVersion: true,
    });
    return {
      ...checked,
      mcpConnectionSharing: selection.mcpConnectionSharing === true &&
        supportsMcpConnectionSharing(checked.version),
    };
  }

  async refreshInstalled() {
    const installed = [];
    let entries = [];
    try {
      entries = await readdir(this.runtimeRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const version = parseCodexVersion(entry.name)?.raw ?? null;
      if (!version) continue;
      const directory = join(this.runtimeRoot, entry.name);
      const executable = join(directory, "codex");
      const codeModeHost = join(directory, "codex-code-mode-host");
      try {
        const [metadata, info, , codeModeHostInfo] = await Promise.all([
          readRuntimeMetadata(directory),
          stat(executable),
          access(executable, fsConstants.X_OK),
          stat(codeModeHost),
          access(codeModeHost, fsConstants.X_OK),
        ]);
        if (!info.isFile() || !codeModeHostInfo.isFile() || metadata?.version !== version ||
          metadata?.components?.codex?.executableSize !== info.size ||
          metadata?.components?.codeModeHost?.executableSize !== codeModeHostInfo.size) continue;
        installed.push({
          mode: "alpha",
          version,
          executable,
          codeModeHost,
          installedAt: metadata.installedAt ?? null,
        });
      } catch {
        // Incomplete or externally modified directories are ignored and retained.
      }
    }
    installed.sort((left, right) => compareCodexVersions(right.version, left.version));
    const installedByVersion = new Map(installed.map((item) => [item.version, item]));
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const match = /^(.+)\.invalid-\d+$/.exec(entry.name);
      const candidate = match ? installedByVersion.get(match[1]) : null;
      if (!candidate) continue;
      try {
        await this.verifyManagedRuntime(candidate.executable, {
          expectedVersion: candidate.version,
          arch: this.arch,
        });
        await rm(join(this.runtimeRoot, entry.name), { recursive: true, force: true });
      } catch (error) {
        console.warn(`[codex-runtime] 未清理历史损坏目录 ${entry.name}：${error.message}`);
      }
    }
    this.installed = installed;
    this.publish({ installed, available: this.isCandidateAvailable() });
    return installed;
  }

  isCandidateAvailable(selection = this.runtimeState.validated) {
    if (!this.candidate) return false;
    if (selection?.version &&
      compareCodexVersions(this.candidate.version, selection.version) <= 0) return false;
    if (!this.installed.some((item) => item.version === this.candidate.version)) return true;
    if (!selection?.version) return true;
    return selection.mode !== "alpha" || selection.version !== this.candidate.version;
  }

  async persistSettings(settings = this.settings) {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const temporary = `${this.settingsPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.settingsPath);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

export {
  CHECK_INTERVAL_MS,
  SETTINGS_VERSION,
  normalizeSettings,
  selectionKey,
};
