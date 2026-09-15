const REFERENCE_KEYS = ["$ref", "$dynamicRef"];
const REFERENCE_METADATA_KEYS = new Set([
  "$schema",
  "$id",
  "$anchor",
  "$dynamicAnchor",
  "$defs",
  "definitions",
]);
const SCHEMA_MAP_KEYS = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
]);
const SCHEMA_ARRAY_KEYS = new Set([
  "allOf",
  "anyOf",
  "oneOf",
  "prefixItems",
]);
const SCHEMA_VALUE_KEYS = new Set([
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);
const MAX_REFERENCE_EXPANSION_DEPTH = 64;

/**
 * Compile Codex JSON Schema into a portable, reference-free form. Codex can
 * emit local $defs/$ref graphs and valid sibling constraints, while several
 * OpenAI-compatible validators only accept an inline subset. Local references
 * are resolved against the original document; recursive graphs are expanded
 * once and terminated with their known type instead of becoming unbounded.
 */
export function normalizeToolParametersSchema(schema) {
  if (!isSchema(schema)) return structuredClone(schema);
  const root = structuredClone(schema);
  return compileSchema(root, {
    root,
    references: new Set(),
    depth: 0,
  });
}

export function normalizeToolDefinition(tool) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
    return structuredClone(tool);
  }
  const next = structuredClone(tool);
  if (next.type === "namespace" && Array.isArray(next.tools)) {
    next.tools = next.tools.map(normalizeToolDefinition);
  }
  if (next.type === "function" && isSchema(next.parameters)) {
    next.parameters = normalizeToolParametersSchema(next.parameters);
  }
  if (next.type === "function" && next.function &&
    typeof next.function === "object" && !Array.isArray(next.function) &&
    isSchema(next.function.parameters)) {
    next.function.parameters = normalizeToolParametersSchema(next.function.parameters);
  }
  return next;
}

export function normalizeToolDefinitions(tools) {
  return Array.isArray(tools) ? tools.map(normalizeToolDefinition) : tools;
}

export function normalizeResponsesRequestToolSchemas(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return structuredClone(request);
  }
  const next = structuredClone(request);
  if (Array.isArray(next.tools)) next.tools = normalizeToolDefinitions(next.tools);
  if (Array.isArray(next.input)) {
    next.input = next.input.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item) ||
        item.type !== "additional_tools" || !Array.isArray(item.tools)) return item;
      return { ...item, tools: normalizeToolDefinitions(item.tools) };
    });
  }
  return next;
}

function compileSchema(value, context) {
  if (typeof value === "boolean") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return structuredClone(value);
  }
  if (context.depth >= MAX_REFERENCE_EXPANSION_DEPTH) {
    return schemaTypeFallback(value);
  }

  const referenceKey = REFERENCE_KEYS.find((key) => typeof value[key] === "string");
  if (referenceKey) {
    const reference = value[referenceKey];
    const siblings = compileSchemaObject(value, context, new Set([referenceKey]));
    const target = resolveLocalReference(context.root, reference);
    if (!target) return siblings;
    if (context.references.has(reference)) {
      return intersectSchemas(schemaTypeFallback(target), siblings);
    }
    const references = new Set(context.references);
    references.add(reference);
    return intersectSchemas(
      compileSchema(target, { ...context, references, depth: context.depth + 1 }),
      siblings,
    );
  }
  return compileSchemaObject(value, context);
}

function compileSchemaObject(value, context, skippedKeys = new Set()) {
  let output = {};
  for (const [key, child] of Object.entries(value)) {
    if (skippedKeys.has(key) || REFERENCE_METADATA_KEYS.has(key)) continue;
    if (key === "allOf" && Array.isArray(child)) {
      for (const branch of child) {
        output = intersectSchemas(
          output,
          compileSchema(branch, { ...context, depth: context.depth + 1 }),
        );
      }
      continue;
    }
    if (SCHEMA_MAP_KEYS.has(key) && child && typeof child === "object" &&
      !Array.isArray(child)) {
      output[key] = Object.fromEntries(Object.entries(child).map(([name, schema]) => [
        name,
        compileSchema(schema, { ...context, depth: context.depth + 1 }),
      ]));
      continue;
    }
    if (SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(child)) {
      output[key] = child.map((schema) =>
        compileSchema(schema, { ...context, depth: context.depth + 1 }));
      continue;
    }
    if (SCHEMA_VALUE_KEYS.has(key) && isSchema(child)) {
      output[key] = compileSchema(child, { ...context, depth: context.depth + 1 });
      continue;
    }
    output[key] = structuredClone(child);
  }
  return output;
}

function resolveLocalReference(root, reference) {
  if (reference === "#") return root;
  if (!reference.startsWith("#/")) return null;
  let current = root;
  for (const rawPart of reference.slice(2).split("/")) {
    let part;
    try {
      part = decodeURIComponent(rawPart).replaceAll("~1", "/").replaceAll("~0", "~");
    } catch {
      return null;
    }
    if (!current || typeof current !== "object" || !Object.hasOwn(current, part)) return null;
    current = current[part];
  }
  return isSchema(current) ? current : null;
}

function intersectSchemas(left, right) {
  if (left === false || right === false) return false;
  if (left === true) return structuredClone(right);
  if (right === true) return structuredClone(left);
  if (!left || typeof left !== "object" || Array.isArray(left)) return structuredClone(right);
  if (!right || typeof right !== "object" || Array.isArray(right)) return structuredClone(left);

  const output = structuredClone(left);
  for (const [key, value] of Object.entries(right)) {
    if (!Object.hasOwn(output, key)) {
      output[key] = structuredClone(value);
      continue;
    }
    if (key === "required" && Array.isArray(output.required) && Array.isArray(value)) {
      output.required = [...new Set([...output.required, ...value])];
      continue;
    }
    if (SCHEMA_MAP_KEYS.has(key) && isPlainObject(output[key]) && isPlainObject(value)) {
      for (const [name, schema] of Object.entries(value)) {
        output[key][name] = Object.hasOwn(output[key], name)
          ? intersectSchemas(output[key][name], schema)
          : structuredClone(schema);
      }
      continue;
    }
    if (key === "additionalProperties" && isSchema(output[key]) && isSchema(value)) {
      output[key] = intersectSchemas(output[key], value);
      continue;
    }
    if (key === "enum" && Array.isArray(output.enum) && Array.isArray(value)) {
      output.enum = output.enum.filter((candidate) =>
        value.some((other) => JSON.stringify(other) === JSON.stringify(candidate)));
      continue;
    }
    if (key === "type") {
      output.type = intersectTypes(output.type, value);
      continue;
    }
    if (JSON.stringify(output[key]) === JSON.stringify(value)) continue;
    // Reference siblings normally repeat structural constraints and add
    // annotations. Prefer the nearer sibling for the remaining scalar keys.
    output[key] = structuredClone(value);
  }
  return output;
}

function intersectTypes(left, right) {
  const leftValues = Array.isArray(left) ? left : [left];
  const rightValues = new Set(Array.isArray(right) ? right : [right]);
  const common = leftValues.filter((value) => rightValues.has(value));
  if (common.length === 0) return structuredClone(right);
  return common.length === 1 ? common[0] : common;
}

function schemaTypeFallback(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return {};
  return Object.hasOwn(schema, "type") ? { type: structuredClone(schema.type) } : {};
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isSchema(value) {
  return typeof value === "boolean" || isPlainObject(value);
}
