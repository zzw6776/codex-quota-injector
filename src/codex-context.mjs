import { mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";

import { defaultAccountDataDir } from "./platform.mjs";

const STORE_VERSION = 5;
const STORE_FILE = "context-overrides.json";
const MODEL_CACHE_FILE = "models_cache.json";
const GENERATED_CATALOG_FILE = join("model-catalogs", "codex-quota-injector.json");
// Exact compatibility allowlist for static catalogs created by earlier releases.
// Never infer ownership from an arbitrary path under model-catalogs.
const LEGACY_MANAGED_CATALOG_FILES = [
  join("model-catalogs", "gpt-5.6-luna-1m.json"),
  join("model-catalogs", "codex-deepseek-poc.json"),
];

export class CodexContextManager {
  constructor({ codexHome = resolveCodexHome(), dataDir = defaultAccountDataDir() } = {}) {
    this.codexHome = codexHome;
    this.dataDir = dataDir;
    this.storePath = join(dataDir, STORE_FILE);
    this.sourcePath = join(codexHome, MODEL_CACHE_FILE);
    this.catalogPath = join(codexHome, GENERATED_CATALOG_FILE);
    this.legacyManagedCatalogPaths = LEGACY_MANAGED_CATALOG_FILES
      .map((path) => join(codexHome, path));
    this.configPath = join(codexHome, "config.toml");
    this.catalog = null;
    this.catalogSource = null;
    this.transientCatalog = null;
    this.overrides = {};
    this.previousModelCatalog = null;
    this.legacyCatalogMigration = null;
    this.storeNeedsMigration = false;
    this.legacyPointerNeedsMigration = false;
    this.storeWriteBlockedReason = null;
    this.migrationBlockedReason = null;
    this.message = null;
    this.messageState = null;
    this.currentCatalogPath = null;
    this.operationTail = Promise.resolve();
  }

  async initialize() {
    try {
      const stored = await readOptionalJson(this.storePath);
      const state = normalizeStoredState(stored);
      this.overrides = state.overrides;
      this.previousModelCatalog = state.previousModelCatalog;
      this.legacyCatalogMigration = state.legacyCatalogMigration;
      this.storeNeedsMigration = state.needsMigration;
      this.legacyPointerNeedsMigration = state.legacyPointerNeedsMigration;
    } catch (error) {
      // Never overwrite a malformed or newer store. Model injection may still
      // continue with the official catalog and provider settings.
      this.overrides = {};
      this.previousModelCatalog = null;
      this.legacyCatalogMigration = null;
      this.storeNeedsMigration = false;
      this.legacyPointerNeedsMigration = false;
      this.storeWriteBlockedReason = error.message;
    }
    try {
      await this.#refreshOnce({ sync: !this.storeWriteBlockedReason });
    } catch (error) {
      this.migrationBlockedReason = error.message;
      this.setError(`上下文配置初始化失败：${error.message}`);
    }
    if (this.storeWriteBlockedReason) {
      this.setError(`上下文覆盖存储未修改：${this.storeWriteBlockedReason}`);
    }
    return this.getViewModel();
  }

  async refresh({ sync = true } = {}) {
    return this.#withLock(() => this.#refreshOnce({ sync }));
  }

  setError(message) {
    this.message = String(message ?? "上下文配置操作失败");
    this.messageState = "error";
  }

  getViewModel() {
    const models = isUsableCatalog(this.catalog)
      ? this.catalog.models
        .filter((model) => model && typeof model.slug === "string")
        .map((model) => {
          const override = this.overrides[model.slug] ?? null;
          const defaultContextWindow = positiveInteger(model.context_window) ?? positiveInteger(model.max_context_window);
          const defaultMaxContextWindow = positiveInteger(model.max_context_window) ?? defaultContextWindow;
          return {
            slug: model.slug,
            displayName: model.display_name ?? model.slug,
            defaultContextWindow,
            defaultMaxContextWindow,
            effectiveContextWindow: override?.contextWindow ?? defaultContextWindow,
            effectiveMaxContextWindow: override?.maxContextWindow ?? defaultMaxContextWindow,
            overridden: Boolean(override),
          };
        })
      : [];
    const overriddenCount = Object.keys(this.overrides).length;
    const orphanedCount = Object.keys(this.overrides)
      .filter((slug) => !models.some((model) => model.slug === slug)).length;
    const externalCatalog = Boolean(this.currentCatalogPath);
    return {
      status: !isUsableCatalog(this.catalog)
        ? "unavailable"
        : externalCatalog
          ? "external"
          : overriddenCount === 0
            ? "system-default"
            : "applied",
      message: this.message,
      messageState: this.messageState,
      sourcePath: this.sourcePath,
      catalogPath: this.catalogPath,
      currentCatalogPath: this.currentCatalogPath,
      catalogSource: this.catalogSource,
      models,
      overriddenCount,
      orphanedCount,
    };
  }

  getEffectiveCatalog() {
    if (!isUsableCatalog(this.catalog)) return null;
    // model_catalog_json is authoritative and disables Codex's online model refresh.
    // Keep overrides in the relay-only runtime catalog instead of persisting this path.
    return {
      // The static catalog schema only contains models. Exclude cache metadata
      // such as fetched_at so a successful revalidation does not change relay generation.
      models: this.catalog.models.map((model) => {
        const override = this.overrides[model?.slug];
        return override
          ? {
              ...model,
              context_window: override.contextWindow,
              max_context_window: override.maxContextWindow,
            }
          : model;
      }),
    };
  }

  selectModelCatalogAccount(account) {
    if (account?.authMode !== "apiKey") this.transientCatalog = null;
  }

  async useOfficialCatalog(catalog, { source = "official-online", persist = true } = {}) {
    if (!isUsableCatalog(catalog)) {
      throw new Error("官方模型目录为空或包含重复模型");
    }
    const changed = catalogSignature(this.catalog) !== catalogSignature(catalog);
    // Persist the cache produced by the official CLI. Unlike model_catalog_json,
    // models_cache.json does not force Codex into static-catalog mode.
    if (persist) {
      await writeJsonAtomic(this.sourcePath, catalog);
      this.transientCatalog = null;
    } else {
      this.transientCatalog = structuredClone(catalog);
    }
    this.catalog = structuredClone(catalog);
    this.catalogSource = source;
    return { changed };
  }

  markOfficialCatalogCurrent() {
    const blockingMessage = this.#blockingMessage();
    if (blockingMessage) {
      this.setError(blockingMessage);
      return;
    }
    this.message = "官方模型目录已刷新，当前已是最新版本";
    this.messageState = "success";
  }

  markOfficialCatalogAvailable() {
    const blockingMessage = this.#blockingMessage();
    if (blockingMessage) {
      this.setError(blockingMessage);
      return;
    }
    this.message = "已缓存更新的官方模型目录；当前任务不受影响，下次启动自动加载";
    this.messageState = "success";
  }

  markOfficialCatalogRestarted() {
    const blockingMessage = this.#blockingMessage();
    if (blockingMessage) {
      this.setError(blockingMessage);
      return;
    }
    this.message = "检测到官方模型目录更新，Codex 已重新加载最新模型";
    this.messageState = "success";
  }

  markBundledCatalogCurrent({ restarted = false } = {}) {
    const blockingMessage = this.#blockingMessage();
    if (blockingMessage) {
      this.setError(blockingMessage);
      return;
    }
    this.message = restarted
      ? "Codex 已重启并加载当前官方 CLI 内置模型目录；API Key 模式不提供账号在线目录"
      : "已加载当前官方 CLI 内置模型目录；API Key 模式不提供账号在线目录";
    this.messageState = "success";
  }

  async setOverride(slug, contextWindow, maxContextWindow = contextWindow) {
    return this.#withLock(async () => {
      await this.#refreshOnce({ sync: false });
      this.#assertUsableCatalog();
      this.#assertStoreWritable();
      const model = this.catalog.models.find((item) => item?.slug === slug);
      if (!model) throw new Error(`模型不存在: ${slug}`);
      const nextContextWindow = requirePositiveInteger(contextWindow, "上下文窗口");
      const nextMaxContextWindow = requirePositiveInteger(maxContextWindow, "最大上下文窗口");
      if (nextMaxContextWindow < nextContextWindow) {
        throw new Error("最大上下文窗口不能小于上下文窗口");
      }
      const previousOverrides = this.overrides;
      this.overrides = {
        ...this.overrides,
        [slug]: {
          contextWindow: nextContextWindow,
          maxContextWindow: nextMaxContextWindow,
        },
      };
      try {
        await this.#persistStore();
      } catch (error) {
        this.overrides = previousOverrides;
        throw error;
      }
      this.message = `${model.display_name ?? slug} 已保存覆盖值，正在重启 Codex`;
      this.messageState = "success";
      return this.getViewModel();
    });
  }

  async resetOverride(slug) {
    return this.#withLock(async () => {
      await this.#refreshOnce({ sync: false });
      this.#assertStoreWritable();
      if (!this.overrides[slug]) return this.getViewModel();
      const previousOverrides = this.overrides;
      this.overrides = { ...this.overrides };
      delete this.overrides[slug];
      try {
        await this.#persistStore();
      } catch (error) {
        this.overrides = previousOverrides;
        throw error;
      }
      this.message = "已恢复该模型的系统默认值，正在重启 Codex";
      this.messageState = "success";
      return this.getViewModel();
    });
  }

  async resetAll() {
    return this.#withLock(async () => {
      await this.#refreshOnce({ sync: false });
      this.#assertStoreWritable();
      const hasOverrides = Object.keys(this.overrides).length > 0;
      if (!hasOverrides) return this.getViewModel();
      const previousOverrides = this.overrides;
      this.overrides = {};
      try {
        await this.#persistStore();
      } catch (error) {
        this.overrides = previousOverrides;
        throw error;
      }
      this.message = "已恢复全部系统默认值，正在重启 Codex";
      this.messageState = "success";
      return this.getViewModel();
    });
  }

  markRestarted() {
    const blockingMessage = this.#blockingMessage();
    if (blockingMessage) {
      this.setError(blockingMessage);
      return;
    }
    this.message = Object.keys(this.overrides).length > 0
      ? "Codex 已重启；上下文覆盖已通过本次注入加载"
      : "Codex 已重启；上下文已恢复系统默认值";
    this.messageState = "success";
  }

  async #refreshOnce({ sync }) {
    this.currentCatalogPath = readModelCatalogPath(
      await readText(this.configPath),
      this.configPath,
    );
    if (sync && !this.storeWriteBlockedReason && !this.migrationBlockedReason) {
      await this.#migrateLegacyManagedCatalog();
    }
    const cachedCatalog = await readJson(this.sourcePath);
    const activeCatalog = isUsableCatalog(this.transientCatalog)
      ? structuredClone(this.transientCatalog)
      : cachedCatalog;
    const preservedCatalog = !isUsableCatalog(activeCatalog) && this.currentCatalogPath
      ? await readJson(this.currentCatalogPath)
      : null;
    this.catalog = isUsableCatalog(activeCatalog) ? activeCatalog : preservedCatalog;
    this.catalogSource = isUsableCatalog(this.transientCatalog)
      ? "official-bundled"
      : isUsableCatalog(cachedCatalog)
        ? "official-cache"
      : isUsableCatalog(preservedCatalog)
        ? "preserved-catalog"
        : null;
    if (!isUsableCatalog(this.catalog)) {
      this.message = "未找到完整 Codex 模型目录，暂不更新上下文覆盖";
      this.messageState = "error";
      return this.getViewModel();
    }
    if (this.messageState === "error" && !this.#blockingMessage()) {
      this.message = null;
      this.messageState = null;
    }
    return this.getViewModel();
  }

  #assertUsableCatalog() {
    if (!isUsableCatalog(this.catalog)) {
      throw new Error("未找到完整 Codex 模型目录，请稍后重试");
    }
  }

  #assertStoreWritable() {
    const blockingMessage = this.#blockingMessage();
    if (blockingMessage) throw new Error(blockingMessage);
  }

  #blockingMessage() {
    if (this.storeWriteBlockedReason) {
      return `上下文覆盖存储未修改：${this.storeWriteBlockedReason}`;
    }
    if (this.migrationBlockedReason) {
      return `历史上下文配置未修改：${this.migrationBlockedReason}`;
    }
    return null;
  }

  async #migrateLegacyManagedCatalog() {
    if (this.storeWriteBlockedReason || this.migrationBlockedReason) return;
    // Older releases wrote the injector catalog into config.toml. Restore the exact
    // setting that preceded our takeover, then keep only the override values we own.
    const snapshot = await this.#captureFiles();
    const snapshotCatalogPath = readModelCatalogPath(snapshot.config.content, this.configPath);
    const managedCatalogPaths = [this.catalogPath, ...this.legacyManagedCatalogPaths];
    const configWithoutNestedResidue = await removeManagedNestedModelCatalogReferences(
      snapshot.config.content,
      this.configPath,
      managedCatalogPaths,
    );
    const hasManagedNestedResidue = configWithoutNestedResidue !== snapshot.config.content;
    const managed = (await Promise.all(managedCatalogPaths
      .map((path) => pathsReferToSameLocation(snapshotCatalogPath, path))))
      .some(Boolean);
    if (!managed && !hasManagedNestedResidue && !this.storeNeedsMigration) return;
    // A legacy store version alone is not ownership evidence. Only references to
    // exact allowlisted paths authorize config cleanup; unrelated root or nested
    // model catalogs remain untouched.
    const migrateLegacyPointer = managed;
    const safePrevious = await safePreviousModelCatalog(
      this.previousModelCatalog,
      this.configPath,
      managedCatalogPaths,
    );
    if (migrateLegacyPointer && safePrevious.present) {
      const previousPath = expandPath(safePrevious.value, dirname(this.configPath));
      let previousCatalog;
      try {
        previousCatalog = await readOptionalJson(previousPath);
      } catch (error) {
        throw new Error(`待恢复的历史模型目录当前不可用，已停止迁移：${error.message}`);
      }
      if (!isUsableCatalog(previousCatalog)) {
        throw new Error(
          "待恢复的历史模型目录为空或包含重复模型，已停止迁移；请恢复该文件或手动修正 model_catalog_json",
        );
      }
    }
    const previousModelCatalog = this.previousModelCatalog;
    const previousMigration = this.legacyCatalogMigration;
    const previousStoreNeedsMigration = this.storeNeedsMigration;
    const previousLegacyPointerNeedsMigration = this.legacyPointerNeedsMigration;
    const persistMigratedStore = migrateLegacyPointer || this.storeNeedsMigration;
    const mutations = [];
    try {
      const restoredConfig = migrateLegacyPointer
        ? restoreModelCatalogPath(configWithoutNestedResidue, safePrevious)
        : configWithoutNestedResidue;
      if (restoredConfig !== snapshot.config.content) {
        const currentConfig = await readOptionalText(this.configPath);
        if (!sameOptionalText(currentConfig, snapshot.config)) {
          throw new Error("Codex 配置在历史目录迁移期间发生变化，已保留当前文件，请重启后重试");
        }
        await writeTextAtomic(this.configPath, restoredConfig);
        mutations.push({
          path: this.configPath,
          snapshot: snapshot.config,
          expected: { exists: true, content: restoredConfig },
        });
      }
      this.currentCatalogPath = readModelCatalogPath(
        await readText(this.configPath),
        this.configPath,
      );
      this.previousModelCatalog = null;
      if (migrateLegacyPointer) {
        this.legacyCatalogMigration = {
          action: "restored",
          previousModelCatalog: safePrevious,
          migratedAt: new Date().toISOString(),
        };
      } else if (this.legacyPointerNeedsMigration) {
        this.legacyCatalogMigration = {
          action: "preserved-current",
          previousModelCatalog: safePrevious,
          migratedAt: new Date().toISOString(),
        };
      }
      this.storeNeedsMigration = false;
      this.legacyPointerNeedsMigration = false;
      if (persistMigratedStore) {
        const currentStore = await readOptionalText(this.storePath);
        if (!sameOptionalText(currentStore, snapshot.store)) {
          throw new Error("上下文覆盖存储在版本迁移期间发生变化，已保留当前文件，请重启后重试");
        }
        await this.#persistStore();
      }
    } catch (error) {
      this.previousModelCatalog = previousModelCatalog;
      this.legacyCatalogMigration = previousMigration;
      this.storeNeedsMigration = previousStoreNeedsMigration;
      this.legacyPointerNeedsMigration = previousLegacyPointerNeedsMigration;
      try {
        await this.#restoreMutations(mutations);
      } catch (rollbackError) {
        error.message = `${error.message}（回滚失败：${rollbackError.message}）`;
      }
      this.currentCatalogPath = readModelCatalogPath(
        await readText(this.configPath),
        this.configPath,
      );
      throw error;
    }
  }

  async #captureFiles() {
    return {
      config: await readOptionalText(this.configPath),
      store: await readOptionalText(this.storePath),
    };
  }

  async #restoreMutations(mutations) {
    let firstError = null;
    const divergentPaths = [];
    for (const mutation of [...mutations].reverse()) {
      try {
        const current = await readOptionalText(mutation.path);
        if (sameOptionalText(current, mutation.snapshot)) continue;
        if (!sameOptionalText(current, mutation.expected)) {
          divergentPaths.push(mutation.path);
          continue;
        }
        await restoreOptionalText(mutation.path, mutation.snapshot);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (divergentPaths.length > 0) {
      const divergenceError = new Error(
        `文件已被其他进程修改，未覆盖其新内容：${divergentPaths.join("；")}`,
      );
      firstError ??= divergenceError;
    }
    if (firstError) throw firstError;
  }

  async #persistStore() {
    await writeJsonAtomic(this.storePath, {
      version: STORE_VERSION,
      overrides: this.overrides,
      legacyCatalogMigration: this.legacyCatalogMigration,
    });
  }

  async #withLock(callback) {
    const previous = this.operationTail;
    let release;
    this.operationTail = new Promise((resolveRelease) => {
      release = resolveRelease;
    });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }
}

function normalizeStoredState(value) {
  if (value == null) {
    return {
      overrides: {},
      previousModelCatalog: null,
      legacyCatalogMigration: null,
      needsMigration: false,
      legacyPointerNeedsMigration: false,
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("context-overrides.json 根节点格式无效");
  }
  if (![3, 4, STORE_VERSION].includes(value.version)) {
    throw new Error(`不支持的 context-overrides.json 版本：${String(value.version ?? "缺失")}`);
  }
  const hasLegacyPointer = Object.hasOwn(value, "previousModelCatalog");
  return {
    overrides: normalizeStoredOverrides(value.overrides),
    previousModelCatalog: hasLegacyPointer
      ? normalizePreviousModelCatalog(value.previousModelCatalog)
      : null,
    legacyCatalogMigration: normalizeLegacyCatalogMigration(value.legacyCatalogMigration),
    needsMigration: value.version !== STORE_VERSION || hasLegacyPointer,
    legacyPointerNeedsMigration: value.version === 3 || hasLegacyPointer,
  };
}

function normalizeStoredOverrides(value) {
  if (value == null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("上下文覆盖记录格式无效");
  }
  return Object.fromEntries(Object.entries(value).map(([rawSlug, item]) => {
    const slug = String(rawSlug ?? "").trim();
    const contextWindow = positiveInteger(item?.contextWindow);
    const maxContextWindow = positiveInteger(item?.maxContextWindow);
    if (!slug || !contextWindow || !maxContextWindow) {
      throw new Error(`上下文覆盖记录无效：${slug || "空模型 ID"}`);
    }
    return [slug, { contextWindow, maxContextWindow }];
  }));
}

function normalizePreviousModelCatalog(value) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    typeof value.present !== "boolean") {
    throw new Error("历史模型目录恢复信息格式无效");
  }
  if (!value.present) return { present: false, value: null };
  if (typeof value.value !== "string" || !value.value.trim()) {
    throw new Error("历史模型目录路径为空");
  }
  return { present: true, value: value.value };
}

function normalizeLegacyCatalogMigration(value) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    !["restored", "preserved-current"].includes(value.action) ||
    typeof value.migratedAt !== "string" || !value.migratedAt.trim()) {
    throw new Error("历史模型目录迁移记录格式无效");
  }
  return {
    action: value.action,
    previousModelCatalog: normalizePreviousModelCatalog(value.previousModelCatalog),
    migratedAt: value.migratedAt,
  };
}

async function safePreviousModelCatalog(previous, configPath, ownedCatalogPaths) {
  if (!previous?.present) return { present: false, value: null };
  const previousPath = expandPath(previous.value, dirname(configPath));
  const managed = (await Promise.all(ownedCatalogPaths
    .map((path) => pathsReferToSameLocation(previousPath, path))))
    .some(Boolean);
  return managed
    ? { present: false, value: null }
    : previous;
}

async function pathsReferToSameLocation(left, right) {
  if (!left || !right) return false;
  if (normalizePath(left) === normalizePath(right)) return true;
  const [realLeft, realRight] = await Promise.all([
    realpath(left).catch(() => null),
    realpath(right).catch(() => null),
  ]);
  return Boolean(realLeft && realRight && normalizePath(realLeft) === normalizePath(realRight));
}

function sameOptionalText(left, right) {
  return left.exists === right.exists && left.content === right.content;
}

function isUsableCatalog(value) {
  if (!value || !Array.isArray(value.models) || value.models.length === 0) return false;
  const slugs = new Set();
  return value.models.every((model) => {
    const slug = typeof model?.slug === "string" ? model.slug.trim() : "";
    if (!slug || slugs.has(slug)) return false;
    slugs.add(slug);
    return true;
  });
}

function catalogSignature(value) {
  return isUsableCatalog(value) ? JSON.stringify(value.models) : "";
}

function restoreModelCatalogPath(configText, previous) {
  const lines = String(configText).split(/\r?\n/);
  const firstTableIndex = lines.findIndex((line) => /^\s*\[/.test(line));
  const rootEnd = firstTableIndex === -1 ? lines.length : firstTableIndex;
  for (let index = 0; index < rootEnd; index += 1) {
    if (/^\s*#/.test(lines[index]) || !/^\s*model_catalog_json\s*=/.test(lines[index])) continue;
    if (previous?.present) {
      lines[index] = `model_catalog_json = ${JSON.stringify(previous.value)}`;
    } else {
      lines.splice(index, 1);
    }
    return ensureTrailingNewline(lines.join("\n"));
  }
  return configText;
}

async function removeManagedNestedModelCatalogReferences(
  configText,
  configPath,
  managedCatalogPaths,
) {
  const lines = String(configText).split(/\r?\n/);
  const firstTableIndex = lines.findIndex((line) => /^\s*\[/.test(line));
  if (firstTableIndex === -1) return configText;
  const removedIndexes = new Set();
  for (let index = firstTableIndex + 1; index < lines.length; index += 1) {
    const value = parseModelCatalogSettingLine(lines[index]);
    if (value == null) continue;
    const referencedPath = expandPath(value, dirname(configPath));
    const managed = (await Promise.all(managedCatalogPaths
      .map((path) => pathsReferToSameLocation(referencedPath, path))))
      .some(Boolean);
    if (managed) removedIndexes.add(index);
  }
  if (removedIndexes.size === 0) return configText;
  return ensureTrailingNewline(
    lines.filter((_, index) => !removedIndexes.has(index)).join("\n"),
  );
}

function readModelCatalogPath(configText, configPath) {
  const value = readModelCatalogSetting(configText, configPath);
  return value ? expandPath(value, dirname(configPath)) : null;
}

function readModelCatalogSetting(configText, configPath) {
  const lines = String(configText).split(/\r?\n/);
  const firstTableIndex = lines.findIndex((line) => /^\s*\[/.test(line));
  const rootEnd = firstTableIndex === -1 ? lines.length : firstTableIndex;
  for (let index = 0; index < rootEnd; index += 1) {
    const line = lines[index];
    if (/^\s*#/.test(line) || !/^\s*model_catalog_json\s*=/.test(line)) continue;
    return parseModelCatalogSettingLine(line);
  }
  return null;
}

function parseModelCatalogSettingLine(line) {
  if (/^\s*#/.test(line) || !/^\s*model_catalog_json\s*=/.test(line)) return null;
  const match = line.match(
    /^\s*model_catalog_json\s*=\s*(?:"((?:\\.|[^"])*)"|'([^']*)')\s*(?:#.*)?$/,
  );
  if (!match) return null;
  return match[1] == null ? match[2] : JSON.parse(`"${match[1]}"`);
}

function expandPath(value, baseDir) {
  const text = String(value).trim();
  if (text === "~") return homedir();
  if (text.startsWith("~/")) return join(homedir(), text.slice(2));
  return isAbsolute(text) ? text : resolve(baseDir, text);
}

function normalizePath(value) {
  if (!value) return null;
  const normalized = normalize(String(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function requirePositiveInteger(value, label) {
  const number = positiveInteger(value);
  if (!number) throw new Error(`${label}必须是正整数`);
  return number;
}

function ensureTrailingNewline(value) {
  const text = String(value);
  return text.length === 0 || text.endsWith("\n") ? text : `${text}\n`;
}

async function writeJsonAtomic(path, value) {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomic(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(temporaryPath, content, { mode: 0o600 });
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function readText(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function readOptionalText(path) {
  try {
    return { exists: true, content: await readFile(path, "utf8") };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, content: "" };
    throw error;
  }
}

async function restoreOptionalText(path, file) {
  if (file.exists) {
    await writeTextAtomic(path, file.content);
  } else {
    await removeFile(path);
  }
}

async function removeFile(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function readOptionalJson(path) {
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`无法读取 ${path}：${error.message}`);
  }
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`${path} 不是有效 JSON：${error.message}`);
  }
}

function resolveCodexHome() {
  const configured = String(process.env.CODEX_HOME ?? "").trim().replace(/^['"]|['"]$/g, "");
  return configured || join(homedir(), ".codex");
}
