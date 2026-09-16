import { canonicalDeepSeekModelId, DEEPSEEK_CANONICAL_MODEL_ID, DEEPSEEK_FLASH_MODEL_IDS } from "../deepseek-model-profile.mjs";
import { MODEL_CAPABILITY_PROBE_VERSION } from "../model-capability-probe.mjs";
import { nonEmptyString, OPENAI_API_BASE_URL, CHATGPT_CODEX_BASE_URL, CUSTOM_PROVIDER_PREFIX } from "./contract.mjs";

function normalizeRoutingConfiguration({
  extraModels,
  officialAuthMode,
}) {
  const targets = new Map();
  const legacyProviderIds = new Set();
  const platforms = new Map();
  for (const value of Array.isArray(extraModels?.platforms) ? extraModels.platforms : []) {
    const id = nonEmptyString(value?.id);
    const baseUrl = nonEmptyString(value?.baseUrl);
    const apiKey = nonEmptyString(value?.apiKey);
    const models = Array.isArray(value?.models) ? value.models : [];
    if (!id || !baseUrl || !apiKey || !value.enabled || models.length === 0) continue;
    const providerId = customProviderId(id);
    const platform = {
      id,
      providerId,
      preset: value?.preset === "deepseek" ? "deepseek" : null,
      name: nonEmptyString(value.name) ?? providerId,
      baseUrl,
      apiKey,
      enabled: true,
      models: models.filter((model) => model?.selected !== false).map(normalizeModel).filter((model) => model.id),
    };
    if (platform.models.length === 0) continue;
    platforms.set(id, platform);
    legacyProviderIds.add(providerId);
  }
  for (const platform of platforms.values()) {
    for (const model of platform.models) {
      const target = {
        kind: "custom",
        routeKey: platform.providerId,
        baseUrl: platform.baseUrl,
        apiKey: platform.apiKey,
        displayName: model.displayName,
        canonicalModelId: platform.preset === "deepseek"
          ? canonicalDeepSeekModelId(model.id)
          : null,
        supportsImage: model.supportsImage,
        routes: model.routes,
        historyMode: model.historyMode,
        capabilities: model.capabilities,
        reasoningEfforts: model.reasoningEfforts,
        defaultReasoningEffort: model.defaultReasoningEffort,
        platform,
      };
      targets.set(model.id, target);
      if (platform.preset === "deepseek" && model.id === DEEPSEEK_CANONICAL_MODEL_ID) {
        for (const modelId of DEEPSEEK_FLASH_MODEL_IDS) targets.set(modelId, target);
      }
    }
  }
  return {
    targets,
    legacyProviderIds,
    platforms,
    officialAuthMode: ["oauth", "apiKey"].includes(officialAuthMode)
      ? officialAuthMode
      : null,
    signature: JSON.stringify({ platforms: [...platforms.values()] }),
  };
}

function buildRoutingSnapshot(normalized, compatibilityProxy) {
  const targets = new Map();
  for (const [model, target] of normalized.targets) {
    const baseUrl = target.platform && compatibilityProxy
      ? compatibilityProxy.baseUrlFor(target.platform)
      : target.baseUrl;
    targets.set(model, { ...target, baseUrl });
  }
  return {
    targets,
    officialAuthMode: normalized.officialAuthMode,
  };
}

function normalizeModel(value) {
  const compatibility = value?.compatibility && typeof value.compatibility === "object"
    ? value.compatibility
    : null;
  const currentProbe = compatibility?.status === "manual" || compatibility?.status === "verified" &&
    compatibility?.probeVersion === MODEL_CAPABILITY_PROBE_VERSION;
  const protocol = ["responses", "chat"].includes(compatibility?.protocol)
    ? compatibility.protocol
    : value?.chatCompatibility ? "chat" : "responses";
  const routes = {
    default: protocol,
    imageInput: currentProbe && ["responses", "chat"].includes(compatibility?.routes?.imageInput)
      ? compatibility.routes.imageInput
      : protocol,
  };
  return {
    id: nonEmptyString(value?.id),
    displayName: nonEmptyString(value?.displayName ?? value?.id) ?? "自定义模型",
    supportsImage: currentProbe
      ? compatibility.supportsImage === true
      : value?.documentedSupportsImage === true || Boolean(value?.supportsImage),
    chatCompatibility: protocol === "chat",
    routes,
    historyMode: protocol === "chat"
      ? "chat"
      : compatibility?.historyMode === "reasoning-text-only"
        ? "reasoning-text-only"
        : "responses-full",
    // A stale probe keeps only conservative capability states. This lets an
    // upgraded runtime suppress unverified optional fields until re-detection,
    // while positive image support still requires the current probe version.
    capabilities: normalizeRuntimeCapabilities(compatibility?.capabilities),
    reasoningEfforts: Array.isArray(value?.reasoningEfforts)
      ? [...new Set(value.reasoningEfforts.map(nonEmptyString).filter(Boolean))]
      : [],
    defaultReasoningEffort: nonEmptyString(value?.defaultReasoningEffort),
  };
}

function officialTarget(snapshot, headers, baseUrls = {
  apiKey: OPENAI_API_BASE_URL,
  oauth: CHATGPT_CODEX_BASE_URL,
}) {
  const authMode = snapshot.officialAuthMode ?? inferOfficialAuthMode(headers);
  return {
    kind: "official",
    routeKey: "openai",
    baseUrl: authMode === "apiKey" ? baseUrls.apiKey : baseUrls.oauth,
  };
}

function inferOfficialAuthMode(headers) {
  if (nonEmptyString(headers["chatgpt-account-id"])) return "oauth";
  const authorization = nonEmptyString(headers.authorization) ?? "";
  return /^Bearer\s+sk-/i.test(authorization) ? "apiKey" : "oauth";
}

function normalizeRuntimeCapabilities(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    ...value,
    transport: value.transport && typeof value.transport === "object"
      ? { ...value.transport }
      : null,
    hostedTools: value.hostedTools && typeof value.hostedTools === "object"
      ? { ...value.hostedTools }
      : {},
    nativeCustomTools: Array.isArray(value.nativeCustomTools)
      ? [...value.nativeCustomTools]
      : [],
  };
}

function customProviderId(id) {
  return `${CUSTOM_PROVIDER_PREFIX}${String(id).replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}`;
}

export { normalizeRoutingConfiguration, buildRoutingSnapshot, officialTarget };
