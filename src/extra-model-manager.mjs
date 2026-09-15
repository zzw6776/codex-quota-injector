import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { fetchDeepSeekBalance } from "./deepseek-balance.mjs";
import modelTemplate from "./deepseek-model.json" with { type: "json" };
import {
  canonicalDeepSeekModelIds,
  DEEPSEEK_CANONICAL_MODEL_ID,
  DEEPSEEK_FLASH_MODEL_IDS,
  DEEPSEEK_PRO_MODEL_ID,
  deepSeekModelProfile,
} from "./deepseek-model-profile.mjs";
import {
  MODEL_CAPABILITY_PROBE_VERSION,
  probeModelCompatibility,
} from "./model-capability-probe.mjs";
import { defaultAccountDataDir } from "./platform.mjs";

const STORE_VERSION = 14;
const SETTINGS_FILE = "extra-model-settings.json";
const RUNTIME_CATALOG_FILE = "runtime-model-catalog-extra.json";
const RUNTIME_SETTINGS_FILE = "runtime-extra-model-settings.json";
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEEPSEEK_PRESET_ID = "d33f5ee0-0000-4000-8000-000000000001";
const DEEPSEEK_PRESET_NAME = "DeepSeek";
const DEEPSEEK_PRESET_BASE_URL = "https://api.deepseek.com/";
const DEEPSEEK_PRESET_MODELS = [DEEPSEEK_CANONICAL_MODEL_ID, DEEPSEEK_PRO_MODEL_ID];
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
  constructor({
    dataDir = defaultAccountDataDir(),
    fetchImpl = fetch,
    probeModel = probeModelCompatibility,
    now = Date.now,
  } = {}) {
    this.dataDir = dataDir;
    this.settingsPath = join(dataDir, SETTINGS_FILE);
    this.runtimeCatalogPath = join(dataDir, RUNTIME_CATALOG_FILE);
    this.runtimeSettingsPath = join(dataDir, RUNTIME_SETTINGS_FILE);
    this.settings = { generation: 0, platforms: [] };
    this.message = null;
    this.messageState = null;
    this.pendingRestart = false;
    this.catalogConflicts = [];
    this.modelDiscovery = null;
    this.modelDiscoveryRevision = 0;
    this.operation = null;
    this.deepSeekBalance = null;
    this.deepSeekBalanceUpdatedAt = null;
    this.deepSeekBalanceError = null;
    this.deepSeekBalanceRefreshing = false;
    this.deepSeekBalanceRequestGeneration = 0;
    this.deepSeekBalanceController = null;
    this.changeListeners = new Set();
    this.fetchImpl = fetchImpl;
    this.probeModel = probeModel;
    this.now = now;
  }

  async initialize() {
    try {
      this.settings = normalizeSettings(await readJson(this.settingsPath));
    } catch (error) {
      this.settings = normalizeSettings(null);
      this.setError(`模型管理配置读取失败，已按未配置处理：${error.message}`);
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
      catalogConflicts: this.catalogConflicts.map((item) => ({ ...item })),
      modelDiscovery: this.modelDiscovery
        ? {
            ...this.modelDiscovery,
            models: this.modelDiscovery.models.map(cloneModel),
          }
        : null,
      operation: this.operation ? { ...this.operation } : null,
      deepSeekBalance: {
        balance: this.deepSeekBalance,
        updatedAt: this.deepSeekBalanceUpdatedAt,
        error: this.deepSeekBalanceError,
        refreshing: this.deepSeekBalanceRefreshing,
      },
    };
  }

  onChange(listener) {
    if (typeof listener !== "function") return () => {};
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  async refreshPresetModels(input) {
    const platform = normalizeDeepSeekPreset({ ...input, enabled: false });
    if (!platform.apiKey) throw new Error("读取 DeepSeek 模型前必须填写 API Key");
    const refreshed = await this.#refreshDeepSeekModels(platform);
    this.modelDiscoveryRevision += 1;
    this.modelDiscovery = {
      revision: this.modelDiscoveryRevision,
      platformId: DEEPSEEK_PRESET_ID,
      models: refreshed.models,
      modelsUpdatedAt: refreshed.modelsUpdatedAt,
    };
    this.message = `已从 DeepSeek 读取 ${refreshed.models.length} 个可用模型，尚未保存`;
    this.messageState = "success";
    this.#setOperation(null);
    return this.getViewModel();
  }

  async savePlatform(input, { reservedModelIds = [], forceProbe = false } = {}) {
    let platform = normalizePlatformInput(input);
    const currentIndex = platform.id
      ? this.settings.platforms.findIndex((item) => item.id === platform.id)
      : -1;
    if (platform.id && currentIndex < 0) throw new Error("要修改的平台已不存在，请刷新后重试");
    let normalized = {
      ...platform,
      id: platform.id || randomUUID(),
    };
    if (normalized.preset === "deepseek" && normalized.enabled) {
      normalized = await this.#refreshDeepSeekModels(normalized);
    }
    const reserved = new Set(reservedModelIds);
    for (const model of normalized.models) {
      if (normalized.enabled && model.selected !== false && reserved.has(model.id)) {
        throw new Error(`模型 ID 与现有模型冲突：${model.id}`);
      }
    }
    const candidatePlatforms = this.settings.platforms.map((item) => clonePlatform(item));
    if (currentIndex >= 0) candidatePlatforms[currentIndex] = normalized;
    else candidatePlatforms.push(normalized);
    assertUniqueModelIds(candidatePlatforms);
    normalized = await this.#detectCapabilities(normalized, {
      forceProbe,
      shouldProbe: normalized.enabled,
    });
    const nextPlatforms = this.settings.platforms.map((item) => clonePlatform(item));
    if (currentIndex >= 0) nextPlatforms[currentIndex] = normalized;
    else nextPlatforms.push(normalized);
    await this.#replaceSettings(nextPlatforms);
    this.pendingRestart = true;
    this.message = normalized.enabled
      ? `${normalized.name} 已完成兼容检测并保存，等待重启 Codex 后生效`
      : `${normalized.name} 已保存为停用状态，等待重启 Codex 后生效`;
    this.messageState = "success";
    this.#setOperation(null);
    return this.getViewModel();
  }

  async redetectPlatform(id, { reservedModelIds = [] } = {}) {
    const platformId = String(id ?? "").trim();
    const platform = this.settings.platforms.find((item) => item.id === platformId);
    if (!platform) throw new Error("要重新检测的平台已不存在，请刷新后重试");
    if (!platform.apiKey) throw new Error("重新检测前必须填写 API Key");
    return this.savePlatform(clonePlatform(platform), {
      reservedModelIds,
      forceProbe: true,
    });
  }

  async refreshDeepSeekBalance() {
    const platform = this.settings.platforms.find((item) => item.preset === "deepseek");
    if (!platform?.apiKey) throw new Error("请先填写并保存 DeepSeek API Key");
    const generation = ++this.deepSeekBalanceRequestGeneration;
    this.deepSeekBalanceController?.abort();
    const controller = new AbortController();
    this.deepSeekBalanceController = controller;
    this.deepSeekBalanceRefreshing = true;
    this.deepSeekBalanceError = null;
    this.#notifyChange();
    try {
      const balance = await fetchDeepSeekBalance({
        apiKey: platform.apiKey,
        fetchImpl: this.fetchImpl,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      });
      if (generation !== this.deepSeekBalanceRequestGeneration) return this.getViewModel();
      this.deepSeekBalance = balance;
      this.deepSeekBalanceUpdatedAt = this.now();
      this.deepSeekBalanceError = null;
    } catch (error) {
      if (generation !== this.deepSeekBalanceRequestGeneration || error?.name === "AbortError") {
        return this.getViewModel();
      }
      this.deepSeekBalanceError = error.message;
      throw error;
    } finally {
      if (generation === this.deepSeekBalanceRequestGeneration) {
        this.deepSeekBalanceRefreshing = false;
        this.deepSeekBalanceController = null;
        this.#notifyChange();
      }
    }
    return this.getViewModel();
  }

  async removePlatform(id) {
    const platformId = String(id ?? "").trim();
    const removed = this.settings.platforms.find((item) => item.id === platformId);
    if (!removed) throw new Error("要删除的平台已不存在，请刷新后重试");
    if (removed.preset === "deepseek") throw new Error("DeepSeek 预设不能删除，可以将其停用并清空 Key");
    await this.#replaceSettings(
      this.settings.platforms.filter((item) => item.id !== platformId),
    );
    this.pendingRestart = true;
    this.message = `${removed.name} 及其 API Key 已从本地文件删除，等待重启 Codex 后生效`;
    this.messageState = "success";
    return this.getViewModel();
  }

  async writeRuntimeCatalog(baseCatalog) {
    if (!baseCatalog || !Array.isArray(baseCatalog.models)) {
      throw new Error("未找到 Codex 模型目录，无法生成自定义模型列表");
    }
    const baseModelIds = new Set(baseCatalog.models.map((model) => model?.slug).filter(Boolean));
    let nextPriority = baseCatalog.models.reduce(
      (maximum, model) => Number.isFinite(Number(model?.priority))
        ? Math.max(maximum, Number(model.priority))
        : maximum,
      0,
    ) + 1;
    const customModels = [];
    const catalogConflicts = [];
    const runtimePlatforms = [];
    for (const platform of this.settings.platforms) {
      const runtimeModels = [];
      for (const model of platform.models) {
        if (platform.enabled && model.selected !== false && baseModelIds.has(model.id)) {
          catalogConflicts.push({ modelId: model.id, platformName: platform.name });
          continue;
        }
        runtimeModels.push(cloneModel(model));
        if (platform.enabled && platform.apiKey && model.selected !== false) {
          customModels.push(createCatalogModel(platform, model, nextPriority));
          nextPriority += 1;
          baseModelIds.add(model.id);
        }
      }
      runtimePlatforms.push({ ...clonePlatform(platform), models: runtimeModels });
    }
    this.catalogConflicts = catalogConflicts;
    const catalog = { ...baseCatalog, models: [...baseCatalog.models, ...customModels] };
    await writeJsonAtomic(this.runtimeCatalogPath, catalog);
    await writeJsonAtomic(this.runtimeSettingsPath, {
      version: STORE_VERSION,
      generation: this.settings.generation,
      platforms: runtimePlatforms,
    });
    return {
      path: this.runtimeCatalogPath,
      settingsPath: this.runtimeSettingsPath,
      catalog,
      catalogConflicts,
      generation: createHash("sha256")
        .update(JSON.stringify(catalog))
        .update(String(this.settings.generation))
        .digest("hex"),
    };
  }

  markRestarted() {
    if (!this.pendingRestart) return this.getViewModel();
    this.pendingRestart = false;
    this.message = this.settings.platforms.some((platform) => platform.enabled)
      ? "Codex 已重启；自定义模型已加入模型列表"
      : "Codex 已重启；模型管理中当前没有启用的平台";
    this.messageState = "success";
    this.#notifyChange();
    return this.getViewModel();
  }

  setError(message) {
    this.message = String(message ?? "模型管理操作失败");
    this.messageState = "error";
    this.#setOperation(null);
  }

  close() {
    this.deepSeekBalanceRequestGeneration += 1;
    this.deepSeekBalanceController?.abort();
    this.deepSeekBalanceController = null;
    this.changeListeners.clear();
  }

  async #replaceSettings(platforms) {
    this.#setOperation({
      state: "loading",
      phase: "saving",
      message: "正在保存模型配置",
    });
    const previous = this.settings;
    const next = {
      generation: previous.generation + 1,
      platforms,
    };
    try {
      await this.#persist(next);
      this.settings = next;
      const previousKey = previous.platforms.find((item) => item.preset === "deepseek")?.apiKey ?? "";
      const nextKey = next.platforms.find((item) => item.preset === "deepseek")?.apiKey ?? "";
      if (previousKey !== nextKey) this.#clearDeepSeekBalance();
    } catch (error) {
      this.settings = previous;
      throw error;
    }
  }

  async #detectCapabilities(platform, { forceProbe, shouldProbe }) {
    if (!shouldProbe) return platform;
    const models = [];
    const selectedModels = platform.models.filter((model) => model.selected !== false);
    let selectedIndex = 0;
    for (const model of platform.models) {
      if (model.selected === false) {
        models.push(model);
        continue;
      }
      selectedIndex += 1;
      this.#setOperation({
        state: "loading",
        phase: "detecting",
        platformId: platform.id,
        current: selectedIndex,
        total: selectedModels.length,
        modelId: model.id,
        message: `正在检测 ${model.displayName || model.id}（${selectedIndex}/${selectedModels.length}）`,
      });
      const targetFingerprint = compatibilityTargetFingerprint(platform, model);
      if (!forceProbe && isCurrentDetection(model.compatibility, targetFingerprint)) {
        models.push(model);
        continue;
      }
      let detected;
      try {
        detected = await this.probeModel({
          baseUrl: platform.baseUrl,
          apiKey: platform.apiKey,
          modelId: model.id,
          fetchImpl: this.fetchImpl,
          now: this.now,
          onProgress: (progress) => {
            this.#setOperation({
              state: "loading",
              phase: "detecting",
              platformId: platform.id,
              current: selectedIndex,
              total: selectedModels.length,
              modelId: model.id,
              message: `正在检测 ${model.displayName || model.id}（${selectedIndex}/${selectedModels.length}）`,
              detail: progress?.message ?? "正在检测模型能力",
              step: progress?.current,
              steps: progress?.total,
              probeStage: progress?.stage,
              retry: progress?.retry === true,
            });
          },
        });
      } catch (error) {
        throw new Error(`${model.displayName || model.id} 自动检测失败：${error.message}`);
      }
      models.push({
        ...model,
        reasoningEfforts: normalizeDetectedReasoningEfforts(detected.reasoningEfforts),
        defaultReasoningEffort: selectDetectedDefaultReasoningEffort(
          normalizeDetectedReasoningEfforts(detected.reasoningEfforts),
          model.defaultReasoningEffort,
        ),
        compatibility: normalizeCompatibility({
          ...detected,
          targetFingerprint,
        }),
      });
    }
    return { ...platform, models };
  }

  async #refreshDeepSeekModels(platform) {
    this.#setOperation({
      state: "loading",
      phase: "models",
      platformId: platform.id,
      message: "正在读取 DeepSeek 可用模型",
    });
    const url = new URL("models", DEEPSEEK_PRESET_BASE_URL);
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${platform.apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new Error(`DeepSeek 模型列表读取失败：${redactSecret(error.message, platform.apiKey)}`);
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = payload?.error?.message ?? payload?.message ?? `HTTP ${response.status}`;
      throw new Error(`DeepSeek 模型列表读取失败：${redactSecret(detail, platform.apiKey)}`);
    }
    const ids = canonicalDeepSeekModelIds((Array.isArray(payload?.data) ? payload.data : [])
      .map((item) => String(item?.id ?? "").trim())
      .filter(Boolean));
    if (ids.length === 0) throw new Error("DeepSeek 模型列表为空，未找到当前 Key 可用的模型");
    const previous = new Map(platform.models.map((model) => [model.id, model]));
    const previousCanonical = deepSeekCanonicalPrevious(previous);
    return {
      ...platform,
      models: ids.map((id) => deepSeekPresetModel(
        id,
        previous.get(id) ?? (id === DEEPSEEK_CANONICAL_MODEL_ID ? previousCanonical : null),
      )),
      modelsUpdatedAt: this.now(),
    };
  }

  #setOperation(operation) {
    this.operation = operation ? { ...operation } : null;
    this.#notifyChange();
  }

  #notifyChange() {
    for (const listener of this.changeListeners) {
      try {
        listener(this.getViewModel());
      } catch {
        // 状态观察者不能中断模型检测。
      }
    }
  }

  #clearDeepSeekBalance() {
    this.deepSeekBalanceRequestGeneration += 1;
    this.deepSeekBalanceController?.abort();
    this.deepSeekBalanceController = null;
    this.deepSeekBalance = null;
    this.deepSeekBalanceUpdatedAt = null;
    this.deepSeekBalanceError = null;
    this.deepSeekBalanceRefreshing = false;
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
  const savedPlatforms = Array.isArray(value?.platforms)
    ? value.platforms.map((platform) => normalizePlatformInput(platform, { requireId: true }))
    : [];
  const savedPreset = savedPlatforms.find((platform) => platform.preset === "deepseek" || platform.id === DEEPSEEK_PRESET_ID);
  const platforms = [
    normalizeDeepSeekPreset(savedPreset),
    ...savedPlatforms.filter((platform) => platform !== savedPreset),
  ];
  assertUniqueModelIds(platforms);
  return {
    generation: Number.isInteger(value?.generation) && value.generation >= 0
      ? value.generation
      : 0,
    platforms,
  };
}

function normalizePlatformInput(value, { requireId = false } = {}) {
  if (value?.preset === "deepseek" || value?.id === DEEPSEEK_PRESET_ID) {
    return normalizeDeepSeekPreset(value);
  }
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
  assertUniqueModelIds([{ name, enabled: true, models }]);
  return { id, name, baseUrl, apiKey, enabled, models };
}

function normalizeDeepSeekPreset(value = null) {
  const apiKey = String(value?.apiKey ?? "").trim();
  const enabled = Boolean(value?.enabled);
  if (enabled && !apiKey) throw new Error("启用 DeepSeek 前必须填写 API Key");
  const sourceModels = Array.isArray(value?.models) && value.models.length
    ? value.models
    : DEEPSEEK_PRESET_MODELS.map((id) => ({ id }));
  const previous = new Map(sourceModels.map((model) => [String(model?.id ?? "").trim(), model]));
  const previousCanonical = deepSeekCanonicalPrevious(previous);
  const models = canonicalDeepSeekModelIds(sourceModels.map((model) => model?.id))
    .map((id) => deepSeekPresetModel(
      id,
      previous.get(id) ?? (id === DEEPSEEK_CANONICAL_MODEL_ID ? previousCanonical : null),
    ));
  if (enabled && !models.some((model) => model.selected !== false)) {
    throw new Error("启用 DeepSeek 前至少选择一个模型");
  }
  assertUniqueModelIds([{ name: DEEPSEEK_PRESET_NAME, enabled: true, models }]);
  return {
    id: DEEPSEEK_PRESET_ID,
    preset: "deepseek",
    name: DEEPSEEK_PRESET_NAME,
    baseUrl: DEEPSEEK_PRESET_BASE_URL,
    apiKey,
    enabled,
    models,
    modelsUpdatedAt: Number.isFinite(Number(value?.modelsUpdatedAt))
      ? Number(value.modelsUpdatedAt)
      : null,
  };
}

function deepSeekCanonicalPrevious(previous) {
  const candidates = DEEPSEEK_FLASH_MODEL_IDS
    .map((modelId) => previous.get(modelId))
    .filter(Boolean);
  if (candidates.length === 0) return null;
  const preferred = previous.get(DEEPSEEK_CANONICAL_MODEL_ID) ?? candidates[0];
  return {
    ...preferred,
    id: DEEPSEEK_CANONICAL_MODEL_ID,
    selected: candidates.some((model) => model.selected !== false),
  };
}

function deepSeekPresetModel(idValue, previous = null) {
  const id = requiredText(idValue, "DeepSeek 模型 ID");
  const profile = deepSeekModelProfile(id);
  const hasDetectedReasoning = Array.isArray(previous?.reasoningEfforts);
  const model = normalizeModelInput({
    id,
    displayName: profile?.displayName ?? previous?.displayName ?? id,
    contextWindow: previous?.contextWindow || profile?.contextWindow || DEFAULT_CONTEXT_WINDOW,
    compatibility: previous?.compatibility,
    reasoningEfforts: hasDetectedReasoning
      ? previous.reasoningEfforts
      : ["low", "high", "max"],
    defaultReasoningEffort: hasDetectedReasoning
      ? previous.defaultReasoningEffort
      : "high",
    selected: previous?.selected !== false,
  });
  return profile
    ? {
        ...model,
        releaseName: profile.releaseName,
        documentedSupportsImage: profile.supportsImage,
        canonical: profile.canonical,
      }
    : model;
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
    selected: value?.selected !== false,
    compatibility: normalizeCompatibility(value?.compatibility, value),
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
  const currentProbe = model.compatibility?.probeVersion === MODEL_CAPABILITY_PROBE_VERSION &&
    model.compatibility?.status === "verified";
  const currentImageStatus = currentProbe
    ? model.compatibility.imageStatus
    : null;
  const supportsImage = currentProbe
    ? currentImageStatus === "supported"
    : model.documentedSupportsImage === true || Boolean(model.supportsImage);
  const hostedWebSearch = currentProbe &&
    model.compatibility?.capabilities?.hostedTools?.web_search === "native";
  const catalog = {
    ...modelTemplate,
    slug: model.id,
    display_name: model.displayName,
    description: `${model.releaseName || model.displayName} · ${platform.name} ${model.compatibility?.protocol === "chat" ? "Chat 兼容" : "Responses API"}`,
    context_window: contextWindow,
    max_context_window: contextWindow,
    auto_compact_token_limit: Math.max(1, Math.floor(contextWindow * 0.9)),
    input_modalities: supportsImage ? ["text", "image"] : ["text"],
    supports_image_detail_original: supportsImage,
    supported_reasoning_levels: model.reasoningEfforts.map((effort) => ({
      effort,
      description: REASONING_DESCRIPTIONS[effort],
    })),
    // 没有配置档位时保留目录所需的结构值，中继不会向平台发送 effort。
    default_reasoning_level: model.defaultReasoningEffort || "low",
    default_reasoning_summary: "none",
    supports_reasoning_summaries: false,
    supports_search_tool: hostedWebSearch,
    supports_parallel_tool_calls:
      model.compatibility?.capabilities?.parallelTools === "native",
    visibility: "list",
    supported_in_api: true,
    upgrade: null,
    priority,
  };
  if (!hostedWebSearch) delete catalog.web_search_tool_type;
  return catalog;
}

function assertUniqueModelIds(platforms) {
  const owners = new Map();
  for (const platform of platforms) {
    if (!platform.enabled) continue;
    for (const model of platform.models ?? []) {
      if (model.selected === false) continue;
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

function normalizeDetectedReasoningEfforts(value) {
  if (!Array.isArray(value)) return [];
  return REASONING_EFFORTS.filter((effort) => value.includes(effort) && effort !== "none");
}

function selectDetectedDefaultReasoningEffort(efforts, previous) {
  if (efforts.length === 0) return "";
  if (efforts.includes(previous)) return previous;
  if (efforts.includes("high")) return "high";
  return efforts[0];
}

function redactSecret(value, secret) {
  const text = String(value ?? "未知错误");
  return secret ? text.replaceAll(secret, "[REDACTED]") : text;
}

function cloneModel(model) {
  return {
    ...model,
    compatibility: model.compatibility ? {
      ...model.compatibility,
      routes: model.compatibility.routes ? { ...model.compatibility.routes } : null,
      capabilities: cloneCapabilities(model.compatibility.capabilities),
    } : null,
    reasoningEfforts: [...(model.reasoningEfforts ?? [])],
  };
}

function normalizeCompatibility(value, legacyModel = null) {
  let status = ["pending", "legacy", "verified"].includes(value?.status)
    ? value.status
    : legacyModel && (Object.hasOwn(legacyModel, "supportsImage") || Object.hasOwn(legacyModel, "chatCompatibility"))
      ? "legacy"
      : "pending";
  const legacyProtocol = legacyModel?.chatCompatibility ? "chat" : "responses";
  const protocol = ["responses", "chat"].includes(value?.protocol)
    ? value.protocol
    : status === "legacy" ? legacyProtocol : null;
  const historyMode = ["responses-full", "reasoning-text-only", "chat"].includes(value?.historyMode)
    ? value.historyMode
    : protocol === "chat" ? "chat" : status === "legacy" ? "responses-full" : null;
  let supportsImage = typeof value?.supportsImage === "boolean"
    ? value.supportsImage
    : status === "legacy" ? Boolean(legacyModel?.supportsImage) : null;
  let imageStatus = ["supported", "unsupported", "inconclusive"].includes(value?.imageStatus)
    ? value.imageStatus
    : supportsImage === true ? "supported" : supportsImage === false ? "unsupported" : "inconclusive";
  let imageDetail = typeof value?.imageDetail === "string" ? value.imageDetail : null;
  let probeVersion = Number.isInteger(value?.probeVersion) ? value.probeVersion : 0;
  if (probeVersion === 4) {
    if (imageStatus === "inconclusive" && /图片请求已被接受/.test(imageDetail ?? "")) {
      imageStatus = "unsupported";
      supportsImage = false;
      imageDetail = "图片请求已成功，但模型未识别图片内容";
    }
    if (["supported", "unsupported"].includes(imageStatus)) {
      probeVersion = 5;
    }
  }
  if (imageStatus === "supported") supportsImage = true;
  else if (imageStatus === "unsupported") supportsImage = false;
  else if (imageStatus === "inconclusive") supportsImage = null;
  const toolContinuation = value?.toolContinuation === true
    ? true
    : value?.toolContinuation === false ? false : null;
  const checkedAt = Number.isFinite(Number(value?.checkedAt)) ? Number(value.checkedAt) : null;
  const targetFingerprint = typeof value?.targetFingerprint === "string"
    ? value.targetFingerprint
    : null;
  const routes = protocol ? {
    default: protocol,
    imageInput: ["responses", "chat"].includes(value?.routes?.imageInput)
      ? value.routes.imageInput
      : protocol,
  } : null;
  const capabilities = normalizeCapabilities(value?.capabilities, {
    protocol,
    historyMode,
    imageStatus,
    legacyVerified: probeVersion > 0,
  });
  const codexConformance = ["passed", "failed", "inconclusive"].includes(value?.codexConformance)
    ? value.codexConformance
    : "inconclusive";
  const verifiedShape = ["responses", "chat"].includes(protocol)
    && routes?.default === protocol
    && ["responses", "chat"].includes(routes?.imageInput)
    && toolContinuation === true
    && checkedAt != null
    && probeVersion > 0
    && targetFingerprint
    && codexConformance === "passed"
    && capabilities.streaming === "native"
    && capabilities.functionTools === "native"
    && ["native", "bridged"].includes(capabilities.customTools)
    && ["native", "bridged"].includes(capabilities.namespaceTools)
    && Array.isArray(capabilities.nativeCustomTools);
  if (status === "verified" &&
    (!verifiedShape || probeVersion !== MODEL_CAPABILITY_PROBE_VERSION)) {
    status = "pending";
  }
  return {
    status,
    protocol,
    routes,
    historyMode,
    toolContinuation,
    supportsImage,
    imageStatus,
    imageDetail,
    capabilities,
    codexConformance,
    checkedAt,
    probeVersion,
    targetFingerprint,
  };
}

function normalizeCapabilities(value, {
  protocol,
  historyMode,
  imageStatus,
  legacyVerified = false,
} = {}) {
  const capability = (candidate, fallback = "inconclusive") =>
    ["native", "bridged", "unsupported", "inconclusive"].includes(candidate)
      ? candidate
      : fallback;
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const sourceTransport = source.transport && typeof source.transport === "object"
    ? source.transport
    : {};
  const sourceHosted = source.hostedTools && typeof source.hostedTools === "object"
    ? source.hostedTools
    : {};
  const hostedTools = {};
  for (const [type, state] of Object.entries(sourceHosted)) {
    if (/^[a-z][a-z0-9_.-]{0,63}$/i.test(type)) hostedTools[type] = capability(state);
  }
  if (!Object.hasOwn(hostedTools, "web_search")) hostedTools.web_search = "inconclusive";
  const legacyFunction = legacyVerified ? "native" : "inconclusive";
  const nativeCustomTools = Array.isArray(source.nativeCustomTools)
    ? [...new Set(source.nativeCustomTools.filter((name) =>
        name === "*" || /^[a-zA-Z0-9_.-]{1,64}$/.test(name)))]
    : [];
  return {
    transport: {
      responses: capability(sourceTransport.responses,
        legacyVerified && protocol === "responses" ? "native" : "inconclusive"),
      chat: capability(sourceTransport.chat,
        legacyVerified && protocol === "chat" ? "native" : "inconclusive"),
    },
    streaming: capability(source.streaming),
    functionTools: capability(source.functionTools, legacyFunction),
    customTools: capability(source.customTools),
    namespaceTools: capability(source.namespaceTools),
    nativeCustomTools,
    parallelTools: capability(source.parallelTools),
    toolChoice: capability(source.toolChoice),
    reasoning: capability(source.reasoning),
    reasoningToolChoice: source.reasoningToolChoice === "auto-only"
      ? "auto-only"
      : capability(source.reasoningToolChoice),
    reasoningHistory: capability(source.reasoningHistory,
      historyMode === "responses-full" && legacyVerified ? "native" :
        historyMode && legacyVerified ? "bridged" : "inconclusive"),
    imageInput: capability(source.imageInput,
      imageStatus === "supported" ? "native" :
        imageStatus === "unsupported" ? "unsupported" : "inconclusive"),
    hostedTools,
  };
}

function cloneCapabilities(value) {
  if (!value || typeof value !== "object") return value ?? null;
  return {
    ...value,
    transport: value.transport ? { ...value.transport } : null,
    hostedTools: value.hostedTools ? { ...value.hostedTools } : {},
    nativeCustomTools: Array.isArray(value.nativeCustomTools)
      ? [...value.nativeCustomTools]
      : [],
  };
}

function compatibilityTargetFingerprint(platform, model) {
  return createHash("sha256")
    .update(platform.baseUrl)
    .update("\0")
    .update(platform.apiKey)
    .update("\0")
    .update(model.id)
    .digest("hex");
}

function isCurrentDetection(compatibility, targetFingerprint) {
  return compatibility?.status === "verified"
    && compatibility.probeVersion === MODEL_CAPABILITY_PROBE_VERSION
    && compatibility.targetFingerprint === targetFingerprint;
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
