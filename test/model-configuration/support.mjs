import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MODEL_CAPABILITY_PROBE_VERSION } from "../../src/model-capability-probe.mjs";
import { ExtraModelManager } from "../../src/extra-model-manager.mjs";
import assert from "node:assert/strict";

const execFileAsync = promisify(execFile);

const PLATFORM_ID = "123e4567-e89b-42d3-a456-426614174010";

function baseCatalog() {
  return {
    fetched_at: "ignored metadata",
    models: [{
      slug: "official-model",
      display_name: "Official Model",
      context_window: 128_000,
      max_context_window: 256_000,
      priority: 7,
      input_modalities: ["text", "image"],
      supports_parallel_tool_calls: true,
    }],
  };
}

function customPlatform(overrides = {}) {
  return {
    id: overrides.id ?? "",
    name: "Local Provider",
    baseUrl: "https://example.test/v1",
    apiKey: "secret",
    enabled: true,
    models: [{
      id: "custom-model",
      displayName: "Custom Model",
      contextWindow: 64_000,
      compatibility: { status: "pending" },
      reasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "high",
    }],
    ...overrides,
  };
}

function detectedCompatibility(overrides = {}) {
  const { capabilities: capabilityOverrides = {}, ...fields } = overrides;
  const protocol = fields.protocol ?? "responses";
  const historyMode = fields.historyMode ?? (protocol === "chat" ? "chat" : "responses-full");
  const supportsImage = fields.supportsImage ?? true;
  const routes = fields.routes ?? { default: protocol, imageInput: protocol };
  const reasoningEfforts = fields.reasoningEfforts ?? ["low", "high", "max"];
  return {
    status: "verified",
    protocol,
    routes,
    historyMode,
    toolContinuation: true,
    supportsImage,
    imageStatus: fields.imageStatus ?? (supportsImage ? "supported" : "unsupported"),
    imageDetail: null,
    supportsReasoning: reasoningEfforts.length > 0,
    reasoningEfforts,
    capabilities: {
      transport: {
        responses: protocol === "responses" ? "native" : "inconclusive",
        chat: protocol === "chat" ? "native" : "inconclusive",
      },
      streaming: "native",
      functionTools: "native",
      customTools: protocol === "chat" ? "bridged" : "native",
      namespaceTools: protocol === "chat" ? "bridged" : "native",
      nativeCustomTools: protocol === "chat" ? [] : ["*"],
      parallelTools: "native",
      toolChoice: "native",
      reasoning: reasoningEfforts.length > 0 ? "native" : "unsupported",
      reasoningToolChoice: "native",
      reasoningHistory: historyMode === "responses-full" ? "native" : "bridged",
      imageInput: supportsImage ? "native" : "unsupported",
      hostedTools: { web_search: "unsupported" },
      ...capabilityOverrides,
    },
    codexConformance: "passed",
    checkedAt: 1234,
    probeVersion: MODEL_CAPABILITY_PROBE_VERSION,
    ...fields,
  };
}

function extraModelManager(dataDir, overrides = {}) {
  return new ExtraModelManager({
    dataDir,
    now: () => 1234,
    probeModel: async () => detectedCompatibility(),
    ...overrides,
  });
}

async function detectAndSave(manager, input) {
  const platform = structuredClone(input);
  for (let index = 0; index < platform.models.length; index += 1) {
    if (platform.models[index].selected === false) continue;
    const result = await manager.detectModel(platform, platform.models[index].id);
    const detection = result.modelDetections.find(item => item.modelId === platform.models[index].id && item.platformId === (platform.id ?? ""));
    assert.equal(detection.status, "passed");
    platform.models[index] = detection.model;
  }
  return manager.savePlatform(platform);
}

export { extraModelManager, detectAndSave, customPlatform, baseCatalog, detectedCompatibility, PLATFORM_ID, execFileAsync };
