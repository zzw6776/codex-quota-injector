import { canonicalDeepSeekModelId, DEEPSEEK_CANONICAL_MODEL_ID } from "../deepseek-model-profile.mjs";
import { MODEL_CAPABILITY_PROBE_VERSION } from "../model-capability-probe.mjs";
import { OPENAI_PROVIDER, CUSTOM_PROVIDER_PREFIX, ALLOWED_CUSTOM_EFFORTS } from "./contract.mjs";

function normalizedModel(value) {
  const model = String(value ?? "").trim();
  return model || null;
}

function providerForModel(model, state) {
  if (typeof model === "string" && state.customModelProviders.has(model)) {
    return state.customModelProviders.get(model);
  }
  if (typeof model === "string" && state.officialModels.has(model)) return OPENAI_PROVIDER;
  return null;
}

function deepSeekRouteModel(model, customPlatform) {
  if (customPlatform?.preset !== "deepseek") return null;
  return canonicalDeepSeekModelId(normalizedModel(model) ?? DEEPSEEK_CANONICAL_MODEL_ID);
}

function customThreadConfig(config, model) {
  const next = { ...(config && typeof config === "object" ? config : {}) };
  next.disable_response_storage = true;
  if (model?.reasoningEfforts.length) {
    if (!model.reasoningEfforts.includes(next.model_reasoning_effort)) {
      next.model_reasoning_effort = model.defaultReasoningEffort;
    }
  } else {
    delete next.model_reasoning_effort;
  }
  delete next.model_reasoning_summary;
  delete next.service_tier;
  return next;
}

function isCustomProvider(provider) {
  return typeof provider === "string" && provider.startsWith(CUSTOM_PROVIDER_PREFIX);
}

function isExtensionProvider(provider) {
  return isCustomProvider(provider);
}

function customPlatformForProvider(provider, state) {
  return isCustomProvider(provider) ? state.customPlatforms.get(provider) ?? null : null;
}

function readCustomPlatforms(settings) {
  const platforms = new Map();
  for (const value of Array.isArray(settings?.platforms) ? settings.platforms : []) {
    const id = String(value?.id ?? "").trim();
    if (!id) continue;
    const providerId = customProviderId(id);
    const models = Array.isArray(value?.models)
      ? value.models.filter((model) => model?.selected !== false).map((model) => {
          const compatibility = model?.compatibility && typeof model.compatibility === "object"
            ? model.compatibility
            : null;
          const currentCompatibility = compatibility?.status === "manual" || compatibility?.status === "verified" &&
            compatibility?.probeVersion === MODEL_CAPABILITY_PROBE_VERSION;
          const protocol = ["responses", "chat"].includes(compatibility?.protocol)
            ? compatibility.protocol
            : model?.chatCompatibility ? "chat" : "responses";
          return {
            id: String(model?.id ?? "").trim(),
            displayName: String(model?.displayName ?? model?.id ?? "").trim(),
            supportsImage: currentCompatibility
              ? compatibility?.supportsImage === true
              : !compatibility && Boolean(model?.supportsImage),
            chatCompatibility: protocol === "chat",
            routes: {
              default: protocol,
              imageInput: currentCompatibility &&
                ["responses", "chat"].includes(compatibility?.routes?.imageInput)
                ? compatibility.routes.imageInput
                : protocol,
            },
            historyMode: protocol === "chat"
              ? "chat"
              : compatibility?.historyMode === "reasoning-text-only"
                ? "reasoning-text-only"
                : "responses-full",
            capabilities: currentCompatibility
              ? normalizeRelayCapabilities(compatibility.capabilities)
              : null,
            reasoningEfforts: Array.isArray(model?.reasoningEfforts)
              ? [...new Set(model.reasoningEfforts
                  .map((effort) => String(effort ?? "").trim())
                  .filter((effort) => ALLOWED_CUSTOM_EFFORTS.has(effort)))]
              : [],
            defaultReasoningEffort: String(model?.defaultReasoningEffort ?? "").trim(),
          };
        }).filter((model) => model.id)
      : [];
    for (const model of models) {
      if (!model.reasoningEfforts.includes(model.defaultReasoningEffort)) {
        model.defaultReasoningEffort = model.reasoningEfforts[0] ?? "";
      }
    }
    platforms.set(providerId, {
      id,
      providerId,
      preset: value?.preset === "deepseek" ? "deepseek" : null,
      name: String(value?.name ?? providerId).trim() || providerId,
      baseUrl: String(value?.baseUrl ?? "").trim(),
      apiKey: String(value?.apiKey ?? "").trim(),
      enabled: Boolean(value?.enabled && value?.apiKey && value?.baseUrl && models.length),
      models,
    });
  }
  return platforms;
}

function normalizeRelayCapabilities(value) {
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

function customProviderEnvKey(id) {
  return `CODEX_QUOTA_MODEL_${String(id).replace(/[^a-zA-Z0-9]/g, "").toUpperCase()}_API_KEY`;
}

function customProviderConfig(platform, baseUrl = platform.baseUrl) {
  return `model_providers.${platform.providerId}={` +
    `name=${JSON.stringify(platform.name)},` +
    `base_url=${JSON.stringify(baseUrl)},` +
    `env_key=${JSON.stringify(customProviderEnvKey(platform.id))},` +
    `wire_api="responses"}`;
}

function routerProviderConfig(providerId, name, router) {
  return `model_providers.${providerId}={` +
    `name=${JSON.stringify(name)},` +
    `base_url=${JSON.stringify(router.baseUrl)},` +
    `requires_openai_auth=true,` +
    `wire_api="responses",` +
    `supports_websockets=false,` +
    `env_http_headers={` +
      `${JSON.stringify(router.tokenHeader)}=${JSON.stringify(router.tokenEnv)}` +
    `}}`;
}

function normalizeRouterConfiguration(value) {
  if (value == null) return null;
  const providerId = String(value.providerId ?? "").trim();
  const baseUrl = String(value.baseUrl ?? "").trim();
  const tokenEnv = String(value.tokenEnv ?? "").trim();
  const tokenHeader = String(value.tokenHeader ?? "").trim().toLowerCase();
  const legacyProviderIds = [...new Set(
    (Array.isArray(value.legacyProviderIds) ? value.legacyProviderIds : [])
      .map((provider) => String(provider ?? "").trim())
      .filter(Boolean),
  )];
  const providerIds = [providerId, ...legacyProviderIds];
  if (!providerIds.every((provider) => /^[A-Za-z0-9_-]+$/.test(provider))) {
    throw new Error("模型 Router 配置中的供应商 ID 不安全");
  }
  if (!/^[A-Z][A-Z0-9_]*$/.test(tokenEnv)) {
    throw new Error("模型 Router 配置中的 Token 环境变量名不安全");
  }
  if (!/^[a-z0-9-]+$/.test(tokenHeader)) {
    throw new Error("模型 Router 配置中的 Token 请求头名称不安全");
  }
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("模型 Router 配置中的地址无效");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("模型 Router 配置中的地址协议或凭据无效");
  }
  return {
    providerId,
    baseUrl: parsed.toString(),
    tokenEnv,
    tokenHeader,
    legacyProviderIds,
  };
}

function containsImageInput(value) {
  if (Array.isArray(value)) return value.some(containsImageInput);
  if (!value || typeof value !== "object") return false;
  if (["image", "localImage", "input_image", "image_url"].includes(value.type)) return true;
  return Object.values(value).some(containsImageInput);
}

function jsonRpcError(id, message) {
  if (id == null) return "";
  return {
    directOutput: JSON.stringify({
      id,
      error: { code: -32602, message },
    }),
  };
}

export { readCustomPlatforms, customProviderEnvKey, customProviderConfig, routerProviderConfig, normalizeRouterConfiguration, normalizedModel, providerForModel, deepSeekRouteModel, customThreadConfig, isCustomProvider, customPlatformForProvider, containsImageInput, jsonRpcError, isExtensionProvider };
