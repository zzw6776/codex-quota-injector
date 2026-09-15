export const DEEPSEEK_CANONICAL_MODEL_ID = "deepseek-flash";
export const DEEPSEEK_PRO_MODEL_ID = "deepseek-v4-pro";

export const DEEPSEEK_COMPATIBILITY_MODEL_IDS = Object.freeze([
  "deepseek-v4-flash",
  "deepseek-v4-flash-vision-exp",
]);

export const DEEPSEEK_FLASH_MODEL_IDS = Object.freeze([
  DEEPSEEK_CANONICAL_MODEL_ID,
  ...DEEPSEEK_COMPATIBILITY_MODEL_IDS,
]);

export const DEEPSEEK_ROUTABLE_MODEL_IDS = Object.freeze([
  ...DEEPSEEK_FLASH_MODEL_IDS,
  DEEPSEEK_PRO_MODEL_ID,
]);

const MODEL_PROFILES = Object.freeze({
  [DEEPSEEK_CANONICAL_MODEL_ID]: Object.freeze({
    displayName: "DeepSeek Flash",
    contextWindow: 1_048_576,
    supportsImage: true,
    canonical: true,
  }),
  "deepseek-v4-flash": Object.freeze({
    displayName: "DeepSeek Flash（旧 Flash 兼容名）",
    contextWindow: 1_048_576,
    supportsImage: true,
    canonical: false,
  }),
  "deepseek-v4-flash-vision-exp": Object.freeze({
    displayName: "DeepSeek Flash（旧 Vision 兼容名）",
    contextWindow: 1_048_576,
    supportsImage: true,
    canonical: false,
  }),
  [DEEPSEEK_PRO_MODEL_ID]: Object.freeze({
    displayName: "DeepSeek Pro",
    contextWindow: 1_048_576,
    supportsImage: false,
    canonical: true,
  }),
});

export function deepSeekModelProfile(modelId) {
  return MODEL_PROFILES[String(modelId ?? "").trim()] ?? null;
}

export function canonicalDeepSeekModelIds(modelIds) {
  return [...new Set((Array.isArray(modelIds) ? modelIds : [])
    .map((modelId) => String(modelId ?? "").trim())
    .filter(Boolean)
    .map(canonicalDeepSeekModelId))];
}

export function canonicalDeepSeekModelId(modelId) {
  const normalized = String(modelId ?? "").trim();
  return DEEPSEEK_FLASH_MODEL_IDS.includes(normalized)
    ? DEEPSEEK_CANONICAL_MODEL_ID
    : normalized;
}

export function isDeepSeekRoutableModel(modelId) {
  return DEEPSEEK_ROUTABLE_MODEL_IDS.includes(String(modelId ?? "").trim());
}
