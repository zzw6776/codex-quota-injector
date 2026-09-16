import { isDeepSeekRoutableModel } from "../deepseek-model-profile.mjs";
import { CUSTOM_REASONING_DESCRIPTIONS, readJson } from "./contract.mjs";
import { normalizedModel } from "./configuration.mjs";

function rewriteModelListResponse(line, message, state, pending) {
  const models = message?.result?.data;
  if (!Array.isArray(models)) {
    reportModelListStatus(state, "invalid", "model/list 返回格式无法识别，未修改响应");
    return line;
  }

  if (pending.cursor != null && String(pending.cursor).trim()) return line;
  const customModelIds = new Set(state.customModels.keys());
  const existingCustomModels = new Map();
  const baseModels = [];
  for (const model of models) {
    const modelId = normalizedModel(model?.id) ?? normalizedModel(model?.model);
    if (customModelIds.has(modelId)) existingCustomModels.set(modelId, model);
    else if (isDeepSeekRoutableModel(modelId)) continue;
    else baseModels.push(model);
  }
  let additions = 0;
  const orderedCustomModels = [];
  for (const platform of state.customPlatforms.values()) {
    if (!platform.enabled) continue;
    for (const model of platform.models) {
      const existing = existingCustomModels.get(model.id);
      const declared = createCustomAppServerModel(platform, model);
      orderedCustomModels.push(existing ? { ...existing, ...declared } : declared);
      if (!existing) additions += 1;
    }
  }
  const orderedModels = [...baseModels, ...orderedCustomModels];
  const orderChanged = orderedModels.length !== models.length ||
    orderedModels.some((model, index) => model !== models[index]);
  if (additions === 0 && !orderChanged) {
    reportModelListStatus(state, "present", "已启用的扩展模型均存在，且位于官方模型之后");
    return line;
  }
  reportModelListStatus(
    state,
    additions > 0 ? "injected" : "sorted",
    additions > 0
      ? `model/list 缺少 ${additions} 个扩展模型，已补齐并置于官方模型之后`
      : "已将自定义模型移动到官方模型之后",
  );
  return JSON.stringify({
    ...message,
    result: {
      ...message.result,
      data: orderedModels,
    },
  });
}

function createCustomAppServerModel(platform, model) {
  return {
    id: model.id,
    model: model.id,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: model.displayName,
    description: `${platform.name} · Responses API`,
    hidden: false,
    supportedReasoningEfforts: model.reasoningEfforts.map((reasoningEffort) => ({
      reasoningEffort,
      description: CUSTOM_REASONING_DESCRIPTIONS[reasoningEffort],
    })),
    defaultReasoningEffort: model.defaultReasoningEffort || "low",
    inputModalities: model.supportsImage ? ["text", "image"] : ["text"],
    supportsPersonality: true,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: false,
  };
}

function reportModelListStatus(state, status, message) {
  if (state.modelListStatus === status) return;
  state.modelListStatus = status;
  console.error(`[codex-quota-relay] ${message}`);
}

async function readOfficialModelSlugs(path) {
  const catalog = await readJson(path);
  return new Set(Array.isArray(catalog?.models)
    ? catalog.models.map((model) => model?.slug).filter(Boolean)
    : []);
}

export { readOfficialModelSlugs, rewriteModelListResponse };
