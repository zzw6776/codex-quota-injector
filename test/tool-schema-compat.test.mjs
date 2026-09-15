import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeResponsesRequestToolSchemas,
  normalizeToolParametersSchema,
} from "../src/tool-schema-compat.mjs";

const codexSchema = {
  type: "object",
  $defs: {
    payload: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
    __schema20: {
      $ref: "#/$defs/payload",
      type: "object",
      description: "Codex generated wrapper",
    },
  },
  properties: { input: { $ref: "#/$defs/__schema20" } },
  required: ["input"],
};

test("工具 schema 内联本地引用、保留同级约束且不修改输入", () => {
  const original = structuredClone(codexSchema);
  const normalized = normalizeToolParametersSchema(codexSchema);

  assert.deepEqual(codexSchema, original);
  assert.equal(Object.hasOwn(normalized, "$defs"), false);
  assert.deepEqual(normalized.properties.input, {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    description: "Codex generated wrapper",
  });
  assert.equal(hasReferenceSibling(normalized), false);
});

test("Responses 请求同时规范化普通、namespace 与 additional_tools 中的函数 schema", () => {
  const request = {
    tools: [{ type: "function", name: "direct", parameters: codexSchema }],
    input: [{
      type: "additional_tools",
      tools: [{
        type: "namespace",
        name: "codex_app",
        tools: [{ type: "function", name: "nested", parameters: codexSchema }],
      }],
    }],
  };
  const normalized = normalizeResponsesRequestToolSchemas(request);

  assert.equal(hasReferenceSibling(normalized.tools[0].parameters), false);
  assert.equal(hasReference(normalized.tools[0].parameters), false);
  assert.equal(
    hasReferenceSibling(normalized.input[0].tools[0].tools[0].parameters),
    false,
  );
  assert.equal(hasReferenceSibling(request.tools[0].parameters), true);
});

test("递归引用只展开一层并以已知类型终止", () => {
  const normalized = normalizeToolParametersSchema({
    $defs: {
      node: {
        type: "object",
        properties: {
          name: { type: "string" },
          child: { $ref: "#/$defs/node" },
        },
      },
    },
    $ref: "#/$defs/node",
  });

  assert.equal(hasReference(normalized), false);
  assert.deepEqual(normalized, {
    type: "object",
    properties: {
      name: { type: "string" },
      child: { type: "object" },
    },
  });
});

function hasReferenceSibling(value) {
  if (Array.isArray(value)) return value.some(hasReferenceSibling);
  if (!value || typeof value !== "object") return false;
  const keys = Object.keys(value);
  if ((Object.hasOwn(value, "$ref") || Object.hasOwn(value, "$dynamicRef")) &&
    keys.length > 1) return true;
  return Object.values(value).some(hasReferenceSibling);
}

function hasReference(value) {
  if (Array.isArray(value)) return value.some(hasReference);
  if (!value || typeof value !== "object") return false;
  if (Object.hasOwn(value, "$ref") || Object.hasOwn(value, "$dynamicRef")) return true;
  return Object.values(value).some(hasReference);
}
