const MODEL_CAPABILITY_PROBE_VERSION = 15;

const MODEL_CAPABILITY_PROBE_TIMEOUT_MS = 90_000;

const CONTINUATION_OUTPUT_TOKENS = 1_024;

const IMAGE_OUTPUT_TOKENS = 256;

const PROBE_TOOL_NAME = "codex_quota_capability_probe";

const PROBE_CUSTOM_TOOL_NAME = "codex_quota_custom_probe";

const PROBE_APPLY_PATCH_TOOL_NAME = "apply_patch";

const PROBE_NAMESPACE_NAME = "codex_quota_namespace";

const PROBE_NAMESPACE_TOOL_NAME = "codex_quota_namespace_probe";

const PROBE_PARALLEL_TOOL_NAMES = ["codex_quota_parallel_left", "codex_quota_parallel_right"];

const PROBE_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

const TOOL_DEFINITION = {
  type: "function",
  name: PROBE_TOOL_NAME,
  description: "Return the supplied value so the client can verify tool-result continuation.",
  parameters: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
};

const CODEX_CONFORMANCE_TOOL_DEFINITION = {
  ...TOOL_DEFINITION,
  parameters: {
    type: "object",
    $defs: {
      codex_probe_value: { type: "string" },
      __schema20: {
        $ref: "#/$defs/codex_probe_value",
        type: "string",
        description: "Codex-style referenced tool parameter.",
      },
    },
    properties: { value: { $ref: "#/$defs/__schema20" } },
    required: ["value"],
    additionalProperties: false,
  },
};

export { MODEL_CAPABILITY_PROBE_VERSION, MODEL_CAPABILITY_PROBE_TIMEOUT_MS, PROBE_APPLY_PATCH_TOOL_NAME, CONTINUATION_OUTPUT_TOKENS, PROBE_TOOL_NAME, TOOL_DEFINITION, PROBE_CUSTOM_TOOL_NAME, PROBE_NAMESPACE_NAME, PROBE_NAMESPACE_TOOL_NAME, PROBE_REASONING_EFFORTS, PROBE_PARALLEL_TOOL_NAMES, CODEX_CONFORMANCE_TOOL_DEFINITION, IMAGE_OUTPUT_TOKENS };
