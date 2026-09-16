import { normalizeToolParametersSchema } from "../tool-schema-compat.mjs";
import { prepareResponsesToolRequest, translateResponsesPayload } from "../responses-tool-adapter.mjs";
import { TOOL_DEFINITION } from "./contract.mjs";
import { contractFailure, isToolChoiceRejection } from "./failures.mjs";
import { stripReasoningEnvelope } from "./payloads.mjs";

function responseFunctionTool(name) {
  return { ...TOOL_DEFINITION, name };
}

function chatFunctionTool(name, parameters = TOOL_DEFINITION.parameters) {
  const tool = responseFunctionTool(name);
  return { type: "function", function: {
    name: tool.name,
    description: tool.description,
    parameters: normalizeToolParametersSchema(parameters),
  } };
}

function createResponsesBridgeRequest(request, options) {
  return async (path, body) => {
    if (path !== "responses") return request(path, body);
    let prepared;
    try {
      prepared = prepareResponsesToolRequest(body, options);
    } catch (error) {
      return contractFailure(422, `Responses 工具请求转换失败：${error.message}`);
    }
    const response = await request(path, prepared.body);
    if (!response.ok) return response;
    try {
      return {
        ...response,
        payload: translateResponsesPayload(response.payload, prepared.plan),
      };
    } catch (error) {
      return contractFailure(response.status, `Responses 工具响应转换失败：${error.message}`);
    }
  };
}

async function requestWithToolChoiceFallback(request, path, body) {
  let response = await request(path, body);
  if (!isToolChoiceRejection(response)) {
    return { response, toolChoice: "native", toolChoiceRequestFields: {} };
  }
  if (path === "responses") {
    const toolChoiceRequestFields = { reasoning: { effort: "none" } };
    const disabled = await request(path, { ...body, ...toolChoiceRequestFields });
    if (disabled.ok) {
      return { response: disabled, toolChoice: "native", toolChoiceRequestFields };
    }
  }
  const { tool_choice: _unsupported, ...withoutToolChoice } = body;
  response = await request(path, withoutToolChoice);
  return { response, toolChoice: "unsupported", toolChoiceRequestFields: {} };
}

function appendToolOutput(output, item, historyMode) {
  const history = historyMode === "reasoning-text-only"
    ? stripReasoningEnvelope(output)
    : structuredClone(output);
  return [...history, item];
}

export { createResponsesBridgeRequest, requestWithToolChoiceFallback, appendToolOutput, chatFunctionTool, responseFunctionTool };
