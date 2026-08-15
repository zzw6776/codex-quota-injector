import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import deepSeekModel from "./deepseek-model.json" with { type: "json" };
import { defaultAccountDataDir } from "./platform.mjs";

const STORE_VERSION = 1;
const SETTINGS_FILE = "provider-settings.json";
const RUNTIME_CATALOG_FILE = "runtime-model-catalog.json";
const BALANCE_URL = "https://api.deepseek.com/user/balance";

export class DeepSeekManager {
  constructor({ dataDir = defaultAccountDataDir(), fetchImpl = fetch } = {}) {
    this.dataDir = dataDir;
    this.settingsPath = join(dataDir, SETTINGS_FILE);
    this.runtimeCatalogPath = join(dataDir, RUNTIME_CATALOG_FILE);
    this.fetchImpl = fetchImpl;
    this.settings = { enabled: false, apiKey: "", generation: 0 };
    this.balance = null;
    this.balanceUpdatedAt = null;
    this.balanceError = null;
    this.balanceRefreshing = false;
    this.message = null;
    this.messageState = null;
    this.pendingRestart = false;
    this.balanceRequestGeneration = 0;
    this.balanceController = null;
  }

  async initialize() {
    try {
      this.settings = normalizeSettings(await readJson(this.settingsPath));
    } catch (error) {
      this.settings = normalizeSettings(null);
      this.setError(`DeepSeek 本地配置读取失败，已按停用处理：${error.message}`);
    }
    return this.getViewModel();
  }

  getViewModel() {
    return {
      supported: process.platform === "darwin" || process.platform === "win32",
      enabled: this.settings.enabled,
      apiKey: this.settings.apiKey,
      configured: Boolean(this.settings.apiKey),
      settingsPath: this.settingsPath,
      balance: this.balance,
      balanceUpdatedAt: this.balanceUpdatedAt,
      balanceError: this.balanceError,
      balanceRefreshing: this.balanceRefreshing,
      message: this.message,
      messageState: this.messageState,
      pendingRestart: this.pendingRestart,
      model: {
        slug: deepSeekModel.slug,
        displayName: deepSeekModel.display_name,
        contextWindow: deepSeekModel.context_window,
        reasoningEfforts: deepSeekModel.supported_reasoning_levels
          ?.map((item) => item.effort)
          .filter((effort) => ["low", "high", "max"].includes(effort)) ?? ["low", "high", "max"],
      },
    };
  }

  async save({ apiKey, enabled }) {
    const nextKey = String(apiKey ?? "").trim();
    const nextEnabled = Boolean(enabled);
    if (nextEnabled && !nextKey) throw new Error("启用 DeepSeek 前必须填写 API Key");
    const keyChanged = nextKey !== this.settings.apiKey;
    const previousSettings = this.settings;
    const nextSettings = {
      enabled: nextEnabled,
      apiKey: nextKey,
      generation: this.settings.generation + 1,
    };
    try {
      await this.#persist(nextSettings);
      this.settings = nextSettings;
    } catch (error) {
      this.settings = previousSettings;
      throw error;
    }
    if (keyChanged) this.#clearBalance();
    this.pendingRestart = true;
    this.message = nextEnabled
      ? "DeepSeek 配置已保存，正在查询余额并重启 Codex"
      : "DeepSeek 已停用，正在重启 Codex";
    this.messageState = "success";
    if (nextEnabled) await this.refreshBalance().catch(() => undefined);
    return this.getViewModel();
  }

  async remove() {
    const previousSettings = this.settings;
    const nextSettings = {
      enabled: false,
      apiKey: "",
      generation: this.settings.generation + 1,
    };
    try {
      await this.#persist(nextSettings);
      this.settings = nextSettings;
    } catch (error) {
      this.settings = previousSettings;
      throw error;
    }
    this.#clearBalance();
    this.pendingRestart = true;
    this.message = "DeepSeek Key 已从本地文件删除，正在重启 Codex";
    this.messageState = "success";
    return this.getViewModel();
  }

  async refreshBalance() {
    if (!this.settings.apiKey) throw new Error("请先填写并保存 DeepSeek API Key");
    const generation = ++this.balanceRequestGeneration;
    this.balanceController?.abort();
    const controller = new AbortController();
    this.balanceController = controller;
    this.balanceRefreshing = true;
    this.balanceError = null;
    try {
      const response = await this.fetchImpl(BALANCE_URL, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.settings.apiKey}` },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const detail = payload?.error?.message ?? payload?.message ?? `HTTP ${response.status}`;
        throw new Error(`余额查询失败：${detail}`);
      }
      if (!payload || !Array.isArray(payload.balance_infos)) {
        throw new Error("余额查询失败：返回数据格式不正确");
      }
      if (generation !== this.balanceRequestGeneration) return this.getViewModel();
      this.balance = {
        available: Boolean(payload.is_available),
        items: payload.balance_infos.map((item) => ({
          currency: String(item.currency ?? ""),
          totalBalance: String(item.total_balance ?? ""),
          grantedBalance: String(item.granted_balance ?? ""),
          toppedUpBalance: String(item.topped_up_balance ?? ""),
        })),
      };
      this.balanceUpdatedAt = Date.now();
      this.balanceError = null;
      return this.getViewModel();
    } catch (error) {
      if (generation !== this.balanceRequestGeneration || error?.name === "AbortError") {
        return this.getViewModel();
      }
      this.balanceError = error.message;
      throw error;
    } finally {
      if (generation === this.balanceRequestGeneration) {
        this.balanceRefreshing = false;
        this.balanceController = null;
      }
    }
  }

  async writeRuntimeCatalog(baseCatalog) {
    if (!baseCatalog || !Array.isArray(baseCatalog.models)) {
      throw new Error("未找到 Codex 官方模型目录，无法生成合并模型列表");
    }
    const models = baseCatalog.models.filter((model) => model?.slug !== deepSeekModel.slug);
    if (this.settings.enabled && this.settings.apiKey) models.push(deepSeekModel);
    const catalog = { ...baseCatalog, models };
    await writeJsonAtomic(this.runtimeCatalogPath, catalog);
    return {
      path: this.runtimeCatalogPath,
      generation: createHash("sha256")
        .update(JSON.stringify(catalog))
        .update(String(this.settings.generation))
        .digest("hex"),
    };
  }

  markRestarted() {
    this.pendingRestart = false;
    this.message = this.settings.enabled
      ? "Codex 已重启；请新建任务并选择 DeepSeek V4 Flash"
      : "Codex 已重启；模型列表已恢复为官方模型";
    this.messageState = "success";
  }

  setError(message) {
    this.pendingRestart = false;
    this.message = String(message ?? "DeepSeek 配置操作失败");
    this.messageState = "error";
  }

  close() {
    this.balanceRequestGeneration += 1;
    this.balanceController?.abort();
    this.balanceController = null;
  }

  #clearBalance() {
    this.balanceRequestGeneration += 1;
    this.balanceController?.abort();
    this.balanceController = null;
    this.balance = null;
    this.balanceUpdatedAt = null;
    this.balanceError = null;
    this.balanceRefreshing = false;
  }

  async #persist(settings = this.settings) {
    await writeJsonAtomic(this.settingsPath, {
      version: STORE_VERSION,
      enabled: settings.enabled,
      apiKey: settings.apiKey,
      generation: settings.generation,
    });
  }
}

function normalizeSettings(value) {
  return {
    enabled: Boolean(value?.enabled),
    apiKey: typeof value?.apiKey === "string" ? value.apiKey : "",
    generation: Number.isInteger(value?.generation) && value.generation >= 0
      ? value.generation
      : 0,
  };
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}
