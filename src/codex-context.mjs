import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";

import { defaultAccountDataDir } from "./platform.mjs";

const STORE_VERSION = 3;
const STORE_FILE = "context-overrides.json";
const MODEL_CACHE_FILE = "models_cache.json";
const GENERATED_CATALOG_FILE = join("model-catalogs", "codex-quota-injector.json");

export class CodexContextManager {
  constructor({ codexHome = resolveCodexHome(), dataDir = defaultAccountDataDir() } = {}) {
    this.codexHome = codexHome;
    this.dataDir = dataDir;
    this.storePath = join(dataDir, STORE_FILE);
    this.sourcePath = join(codexHome, MODEL_CACHE_FILE);
    this.catalogPath = join(codexHome, GENERATED_CATALOG_FILE);
    this.configPath = join(codexHome, "config.toml");
    this.catalog = null;
    this.overrides = {};
    this.previousModelCatalog = null;
    this.message = null;
    this.messageState = null;
    this.currentCatalogPath = null;
    this.operationTail = Promise.resolve();
  }

  async initialize() {
    const stored = await readJson(this.storePath);
    this.overrides = normalizeOverrides(stored?.overrides);
    this.previousModelCatalog = stored?.previousModelCatalog ?? null;
    try {
      await this.#refreshOnce({ sync: true });
    } catch (error) {
      this.setError(`上下文配置初始化失败：${error.message}`);
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
    const managed = normalizePath(this.currentCatalogPath) === normalizePath(this.catalogPath);
    const externalCatalog = Boolean(this.currentCatalogPath) &&
      normalizePath(this.currentCatalogPath) !== normalizePath(this.sourcePath) &&
      !managed;
    return {
      status: !isUsableCatalog(this.catalog)
        ? "unavailable"
        : externalCatalog
          ? "external"
          : overriddenCount === 0
            ? "system-default"
            : managed
              ? "applied"
              : "pending",
      message: this.message,
      messageState: this.messageState,
      sourcePath: this.sourcePath,
      catalogPath: this.catalogPath,
      currentCatalogPath: this.currentCatalogPath,
      models,
      overriddenCount,
      orphanedCount,
    };
  }

  async setOverride(slug, contextWindow, maxContextWindow = contextWindow) {
    return this.#withLock(async () => {
      await this.#refreshOnce({ sync: false });
      this.#assertUsableCatalog();
      this.#assertCanManageCatalog();
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
        await this.#applyOverrides();
      } catch (error) {
        this.overrides = previousOverrides;
        throw error;
      }
      this.message = `${model.display_name ?? slug} 已保存覆盖值，重启 Codex 后生效`;
      this.messageState = "success";
      return this.getViewModel();
    });
  }

  async resetOverride(slug) {
    return this.#withLock(async () => {
      await this.#refreshOnce({ sync: false });
      if (!this.overrides[slug]) return this.getViewModel();
      const previousOverrides = this.overrides;
      this.overrides = { ...this.overrides };
      delete this.overrides[slug];
      try {
        if (Object.keys(this.overrides).length === 0) {
          await this.#restoreSystemCatalog();
        } else {
          this.#assertUsableCatalog();
          this.#assertCanManageCatalog();
          await this.#applyOverrides();
        }
      } catch (error) {
        this.overrides = previousOverrides;
        throw error;
      }
      this.message = "已恢复该模型的系统默认值，重启 Codex 后生效";
      this.messageState = "success";
      return this.getViewModel();
    });
  }

  async resetAll() {
    return this.#withLock(async () => {
      await this.#refreshOnce({ sync: false });
      const hasOverrides = Object.keys(this.overrides).length > 0;
      const managed = normalizePath(this.currentCatalogPath) === normalizePath(this.catalogPath);
      if (!hasOverrides && !managed) return this.getViewModel();
      const previousOverrides = this.overrides;
      this.overrides = {};
      try {
        await this.#restoreSystemCatalog();
      } catch (error) {
        this.overrides = previousOverrides;
        throw error;
      }
      this.message = "已恢复全部系统默认值，重启 Codex 后生效";
      this.messageState = "success";
      return this.getViewModel();
    });
  }

  async #refreshOnce({ sync }) {
    this.catalog = await readJson(this.sourcePath);
    this.currentCatalogPath = readModelCatalogPath(
      await readText(this.configPath),
      this.configPath,
    );
    if (!isUsableCatalog(this.catalog)) {
      this.message = "未找到完整 Codex 模型目录，暂不更新覆盖配置";
      this.messageState = "error";
      return this.getViewModel();
    }
    this.message = null;
    this.messageState = null;
    if (!sync) return this.getViewModel();
    if (Object.keys(this.overrides).length > 0 && this.#canManageCatalog()) {
      await this.#applyOverrides();
    } else if (Object.keys(this.overrides).length === 0 &&
      normalizePath(this.currentCatalogPath) === normalizePath(this.catalogPath)) {
      await this.#restoreSystemCatalog();
    }
    return this.getViewModel();
  }

  #assertUsableCatalog() {
    if (!isUsableCatalog(this.catalog)) {
      throw new Error("未找到完整 Codex 模型目录，请稍后重试");
    }
  }

  #assertCanManageCatalog() {
    if (!this.#canManageCatalog()) {
      throw new Error("检测到其他模型目录，已停止保存覆盖值；请先恢复 Codex 官方模型目录");
    }
  }

  #canManageCatalog() {
    const currentPath = normalizePath(this.currentCatalogPath);
    return !currentPath ||
      currentPath === normalizePath(this.sourcePath) ||
      currentPath === normalizePath(this.catalogPath);
  }

  async #applyOverrides() {
    this.#assertUsableCatalog();
    this.#assertCanManageCatalog();
    const catalog = {
      ...this.catalog,
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
    const snapshot = await this.#captureFiles();
    const configText = await readText(this.configPath);
    if (configText !== snapshot.config.content) {
      throw new Error("Codex 配置在保存期间发生变化，请重试");
    }
    const previousModelCatalog = this.previousModelCatalog;
    await this.#capturePreviousModelCatalog();
    try {
      await writeJsonAtomic(this.catalogPath, catalog);
      const updatedConfig = upsertModelCatalogPath(configText, this.configPath, this.catalogPath);
      await writeTextAtomic(this.configPath, updatedConfig);
      this.currentCatalogPath = this.catalogPath;
      await this.#persistStore();
    } catch (error) {
      this.previousModelCatalog = previousModelCatalog;
      this.currentCatalogPath = readModelCatalogPath(
        snapshot.config.content,
        this.configPath,
      );
      try {
        await this.#restoreFiles(snapshot);
      } catch (rollbackError) {
        error.message = `${error.message}（回滚失败：${rollbackError.message}）`;
      }
      throw error;
    }
  }

  async #restoreSystemCatalog() {
    const snapshot = await this.#captureFiles();
    const previousModelCatalog = this.previousModelCatalog;
    try {
      const configText = snapshot.config.content;
      const currentPath = readModelCatalogPath(configText, this.configPath);
      if (normalizePath(currentPath) === normalizePath(this.catalogPath)) {
        const restoredConfig = restoreModelCatalogPath(
          configText,
          this.previousModelCatalog,
          this.configPath,
        );
        await writeTextAtomic(this.configPath, restoredConfig);
      }
      await removeFile(this.catalogPath);
      this.currentCatalogPath = readModelCatalogPath(
        await readText(this.configPath),
        this.configPath,
      );
      this.previousModelCatalog = null;
      await this.#persistStore();
    } catch (error) {
      this.previousModelCatalog = previousModelCatalog;
      this.currentCatalogPath = readModelCatalogPath(
        snapshot.config.content,
        this.configPath,
      );
      try {
        await this.#restoreFiles(snapshot);
      } catch (rollbackError) {
        error.message = `${error.message}（回滚失败：${rollbackError.message}）`;
      }
      throw error;
    }
  }

  async #capturePreviousModelCatalog() {
    if (this.previousModelCatalog) return;
    const currentConfig = await readText(this.configPath);
    const currentPath = readModelCatalogSetting(currentConfig, this.configPath);
    this.previousModelCatalog = currentPath
      ? { present: true, value: currentPath }
      : { present: false, value: null };
  }

  async #captureFiles() {
    return {
      config: await readOptionalText(this.configPath),
      catalog: await readOptionalText(this.catalogPath),
      store: await readOptionalText(this.storePath),
    };
  }

  async #restoreFiles(snapshot) {
    let firstError = null;
    for (const [path, file] of [
      [this.configPath, snapshot.config],
      [this.catalogPath, snapshot.catalog],
      [this.storePath, snapshot.store],
    ]) {
      try {
        await restoreOptionalText(path, file);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  }

  async #persistStore() {
    await writeJsonAtomic(this.storePath, {
      version: STORE_VERSION,
      overrides: this.overrides,
      previousModelCatalog: this.previousModelCatalog,
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

function normalizeOverrides(value) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([slug, item]) => [slug, {
        contextWindow: positiveInteger(item?.contextWindow),
        maxContextWindow: positiveInteger(item?.maxContextWindow),
      }])
      .filter(([, item]) => item.contextWindow && item.maxContextWindow),
  );
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

function upsertModelCatalogPath(configText, configPath, catalogPath) {
  const lines = String(configText).split(/\r?\n/);
  const firstTableIndex = lines.findIndex((line) => /^\s*\[/.test(line));
  const rootEnd = firstTableIndex === -1 ? lines.length : firstTableIndex;
  const replacement = `model_catalog_json = ${JSON.stringify(catalogPath)}`;
  for (let index = 0; index < rootEnd; index += 1) {
    if (/^\s*#/.test(lines[index]) || !/^\s*model_catalog_json\s*=/.test(lines[index])) continue;
    lines[index] = replacement;
    return ensureTrailingNewline(lines.join("\n"));
  }
  const prefix = ensureTrailingNewline(configText);
  return `${replacement}\n${prefix}`;
}

function restoreModelCatalogPath(configText, previous, configPath) {
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
    const match = line.match(/^\s*model_catalog_json\s*=\s*(?:"((?:\\.|[^"])*)"|'([^']*)')\s*(?:#.*)?$/);
    if (!match) return null;
    return match[1] == null ? match[2] : JSON.parse(`"${match[1]}"`);
  }
  return null;
}

function expandPath(value, baseDir) {
  const text = String(value).trim();
  if (text === "~") return homedir();
  if (text.startsWith("~/")) return join(homedir(), text.slice(2));
  return isAbsolute(text) ? text : resolve(baseDir, text);
}

function normalizePath(value) {
  return value ? normalize(String(value)) : null;
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

function resolveCodexHome() {
  const configured = String(process.env.CODEX_HOME ?? "").trim().replace(/^['"]|['"]$/g, "");
  return configured || join(homedir(), ".codex");
}
