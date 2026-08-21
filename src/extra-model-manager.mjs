import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import modelTemplate from "./deepseek-model.json" with { type: "json" };
import { defaultAccountDataDir } from "./platform.mjs";

const STORE_VERSION = 5;
const SETTINGS_FILE = "extra-model-settings.json";
const RUNTIME_CATALOG_FILE = "runtime-model-catalog-extra.json";
const RUNTIME_SETTINGS_FILE = "runtime-extra-model-settings.json";
const DEFAULT_CONTEXT_WINDOW = 128_000;
const REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"];
const REASONING_DESCRIPTIONS = {
  none: "No additional reasoning",
  low: "Fast responses with lighter reasoning",
  medium: "Balanced reasoning for everyday tasks",
  high: "Deeper reasoning for complex problems",
  xhigh: "Extra-high reasoning depth for harder problems",
  max: "Maximum reasoning depth for the hardest problems",
};

export class ExtraModelManager {
  constructor({ dataDir = defaultAccountDataDir() } = {}) {
    this.dataDir = dataDir;
    this.settingsPath = join(dataDir, SETTINGS_FILE);
    this.runtimeCatalogPath = join(dataDir, RUNTIME_CATALOG_FILE);
    this.runtimeSettingsPath = join(dataDir, RUNTIME_SETTINGS_FILE);
    this.settings = { generation: 0, platforms: [] };
    this.message = null;
    this.messageState = null;
    this.pendingRestart = false;
  }

  async initialize() {
    try {
      this.settings = normalizeSettings(await readJson(this.settingsPath));
    } catch (error) {
      this.settings = normalizeSettings(null);
      this.setError(`额外模型本地配置读取失败，已按未配置处理：${error.message}`);
    }
    return this.getViewModel();
  }

  getViewModel() {
    return {
      supported: process.platform === "darwin" || process.platform === "win32",
      settingsPath: this.settingsPath,
      platforms: this.settings.platforms.map((platform) => ({
        ...platform,
        models: platform.models.map(cloneModel),
      })),
      message: this.message,
      messageState: this.messageState,
      pendingRestart: this.pendingRestart,
    };
  }

  async savePlatform(input, { reservedModelIds = [] } = {}) {
    const platform = normalizePlatformInput(input);
    const currentIndex = platform.id
      ? this.settings.platforms.findIndex((item) => item.id === platform.id)
      : -1;
    if (platform.id && currentIndex < 0) throw new Error("要修改的平台已不存在，请刷新后重试");
    const normalized = {
      ...platform,
      id: platform.id || randomUUID(),
    };
    const reserved = new Set(reservedModelIds);
    for (const model of normalized.models) {
      if (reserved.has(model.id)) throw new Error(`模型 ID 与现有模型冲突：${model.id}`);
    }
    const nextPlatforms = this.settings.platforms.map((item) => clonePlatform(item));
    if (currentIndex >= 0) nextPlatforms[currentIndex] = normalized;
    else nextPlatforms.push(normalized);
    assertUniqueModelIds(nextPlatforms);
    await this.#replaceSettings(nextPlatforms);
    this.pendingRestart = true;
    this.message = `${normalized.name} 已保存，正在重启 Codex`;
    this.messageState = "success";
    return this.getViewModel();
  }

  async removePlatform(id) {
    const platformId = String(id ?? "").trim();
    const removed = this.settings.platforms.find((item) => item.id === platformId);
    if (!removed) throw new Error("要删除的平台已不存在，请刷新后重试");
    await this.#replaceSettings(
      this.settings.platforms.filter((item) => item.id !== platformId),
    );
    this.pendingRestart = true;
    this.message = `${removed.name} 及其 API Key 已从本地文件删除，正在重启 Codex`;
    this.messageState = "success";
    return this.getViewModel();
  }

  async writeRuntimeCatalog(baseCatalog) {
    if (!baseCatalog || !Array.isArray(baseCatalog.models)) {
      throw new Error("未找到 Codex 模型目录，无法生成额外模型列表");
    }
    const baseModelIds = new Set(baseCatalog.models.map((model) => model?.slug).filter(Boolean));
    let nextPriority = baseCatalog.models.reduce(
      (maximum, model) => Number.isFinite(Number(model?.priority))
        ? Math.max(maximum, Number(model.priority))
        : maximum,
      0,
    ) + 1;
    const customModels = [];
    for (const platform of this.settings.platforms) {
      if (!platform.enabled || !platform.apiKey) continue;
      for (const model of platform.models) {
        if (baseModelIds.has(model.id)) {
          throw new Error(`额外模型 ID 与现有模型冲突：${model.id}`);
        }
        customModels.push(createCatalogModel(platform, model, nextPriority));
        nextPriority += 1;
        baseModelIds.add(model.id);
      }
    }
    const catalog = { ...baseCatalog, models: [...baseCatalog.models, ...customModels] };
    await writeJsonAtomic(this.runtimeCatalogPath, catalog);
    await writeJsonAtomic(this.runtimeSettingsPath, {
      version: STORE_VERSION,
      generation: this.settings.generation,
      platforms: this.settings.platforms,
    });
    return {
      path: this.runtimeCatalogPath,
      settingsPath: this.runtimeSettingsPath,
      catalog,
      generation: createHash("sha256")
        .update(JSON.stringify(catalog))
        .update(String(this.settings.generation))
        .digest("hex"),
    };
  }

  markRestarted() {
    this.pendingRestart = false;
    this.message = this.settings.platforms.some((platform) => platform.enabled)
      ? "Codex 已重启；额外模型已加入模型列表"
      : "Codex 已重启；额外模型配置当前均未启用";
    this.messageState = "success";
  }

  setError(message) {
    this.pendingRestart = false;
    this.message = String(message ?? "额外模型配置操作失败");
    this.messageState = "error";
  }

  close() {}

  async #replaceSettings(platforms) {
    const previous = this.settings;
    const next = {
      generation: previous.generation + 1,
      platforms,
    };
    try {
      await this.#persist(next);
      this.settings = next;
    } catch (error) {
      this.settings = previous;
      throw error;
    }
  }

  async #persist(settings = this.settings) {
    await writeJsonAtomic(this.settingsPath, {
      version: STORE_VERSION,
      generation: settings.generation,
      platforms: settings.platforms,
    });
  }
}

function normalizeSettings(value) {
  const platforms = Array.isArray(value?.platforms)
    ? value.platforms.map((platform) => normalizePlatformInput(platform, { requireId: true }))
    : [];
  assertUniqueModelIds(platforms);
  return {
    generation: Number.isInteger(value?.generation) && value.generation >= 0
      ? value.generation
      : 0,
    platforms,
  };
}

function normalizePlatformInput(value, { requireId = false } = {}) {
  const id = String(value?.id ?? "").trim();
  if (requireId && !id) throw new Error("平台 ID 为空");
  if (id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error("平台 ID 格式不正确");
  }
  const name = requiredText(value?.name, "平台名称");
  const baseUrl = normalizeBaseUrl(value?.baseUrl);
  const apiKey = String(value?.apiKey ?? "").trim();
  const enabled = Boolean(value?.enabled);
  const models = Array.isArray(value?.models)
    ? value.models.map(normalizeModelInput)
    : [];
  if (enabled && !apiKey) throw new Error("启用平台前必须填写 API Key");
  if (models.length === 0) throw new Error("每个平台至少需要添加一个模型");
  assertUniqueModelIds([{ name, models }]);
  return { id, name, baseUrl, apiKey, enabled, models };
}

function normalizeModelInput(value) {
  const id = requiredText(value?.id, "模型 ID");
  const displayName = String(value?.displayName ?? "").trim() || id;
  const contextWindow = value?.contextWindow == null || value.contextWindow === ""
    ? DEFAULT_CONTEXT_WINDOW
    : positiveInteger(value.contextWindow);
  if (!contextWindow) throw new Error(`${id} 的上下文窗口必须是正整数`);
  const rawReasoningEfforts = Array.isArray(value?.reasoningEfforts)
    ? value.reasoningEfforts.map((effort) => String(effort ?? "").trim()).filter(Boolean)
    : [];
  const unsupportedEffort = rawReasoningEfforts.find(
    (effort) => !REASONING_EFFORTS.includes(effort),
  );
  if (unsupportedEffort) throw new Error(`${id} 的推理强度不受支持：${unsupportedEffort}`);
  const reasoningEfforts = [...new Set(rawReasoningEfforts)];
  let defaultReasoningEffort = String(value?.defaultReasoningEffort ?? "").trim();
  if (reasoningEfforts.length === 0) defaultReasoningEffort = "";
  else if (!defaultReasoningEffort) [defaultReasoningEffort] = reasoningEfforts;
  if (defaultReasoningEffort && !reasoningEfforts.includes(defaultReasoningEffort)) {
    throw new Error(`${id} 的默认推理强度必须包含在已启用档位中`);
  }
  return {
    id,
    displayName,
    contextWindow,
    supportsImage: Boolean(value?.supportsImage),
    chatCompatibility: Boolean(value?.chatCompatibility),
    reasoningEfforts,
    defaultReasoningEffort,
  };
}

function normalizeBaseUrl(value) {
  const raw = requiredText(value, "API Base URL");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("API Base URL 格式不正确");
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error("API Base URL 仅支持 http 或 https");
  }
  if (url.search || url.hash) throw new Error("API Base URL 不能包含查询参数或片段");
  if (/\/(responses|chat\/completions)\/?$/i.test(url.pathname)) {
    throw new Error("API Base URL 请填写接口前缀，例如 https://example.com/v1，不要填写 /responses");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url.toString();
}

function createCatalogModel(platform, model, priority) {
  const contextWindow = model.contextWindow;
  return {
    ...modelTemplate,
    slug: model.id,
    display_name: model.displayName,
    description: `${platform.name} · Responses API`,
    context_window: contextWindow,
    max_context_window: contextWindow,
    auto_compact_token_limit: Math.max(1, Math.floor(contextWindow * 0.9)),
    input_modalities: model.supportsImage ? ["text", "image"] : ["text"],
    supports_image_detail_original: model.supportsImage,
    supported_reasoning_levels: model.reasoningEfforts.map((effort) => ({
      effort,
      description: REASONING_DESCRIPTIONS[effort],
    })),
    // 没有配置档位时保留目录所需的结构值，中继不会向平台发送 effort。
    default_reasoning_level: model.defaultReasoningEffort || "low",
    default_reasoning_summary: "none",
    supports_reasoning_summaries: false,
    supports_search_tool: false,
    visibility: "list",
    supported_in_api: true,
    upgrade: null,
    priority,
  };
}

function assertUniqueModelIds(platforms) {
  const owners = new Map();
  for (const platform of platforms) {
    for (const model of platform.models ?? []) {
      const previousOwner = owners.get(model.id);
      if (previousOwner) {
        throw new Error(`模型 ID ${model.id} 在 ${previousOwner} 与 ${platform.name} 中重复`);
      }
      owners.set(model.id, platform.name);
    }
  }
}

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label}不能为空`);
  return text;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function cloneModel(model) {
  return {
    ...model,
    reasoningEfforts: [...(model.reasoningEfforts ?? [])],
  };
}

function clonePlatform(platform) {
  return { ...platform, models: platform.models.map(cloneModel) };
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
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
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
