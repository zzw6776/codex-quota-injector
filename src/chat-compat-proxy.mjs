import { createServer } from "node:http";
import { applyResponsesCapabilityPolicy, needsResponsesToolBridge, prepareResponsesToolRequest } from "./responses-tool-adapter.mjs";
import { normalizeResponsesRequestToolSchemas } from "./tool-schema-compat.mjs";
import { text } from "./chat-compat-proxy/contract.mjs";
import { needsModelCompatibility, shouldUseChatCompatibility, stripReasoningEnvelope } from "./chat-compat-proxy/policy.mjs";
import { listen, closeServer, resolveTarget, isResponsesRequest, readJsonBody, forwardPassthrough, forwardJson, writeError } from "./chat-compat-proxy/transport.mjs";
import { prepareChatRequest } from "./chat-compat-proxy/request.mjs";
import { forwardResponsesToolRequest } from "./chat-compat-proxy/responses-bridge.mjs";
import { createToolCallHistory, restoreToolCalls } from "./chat-compat-proxy/history.mjs";
import { forwardChatRequest } from "./chat-compat-proxy/chat-transport.mjs";

/**
 * Normalizes third-party Responses history and tool shapes, and bridges a
 * request to Chat Completions when the detected capability route requires it.
 */
export async function startChatCompatibilityProxy(platforms) {
  const targets = new Map(
    [...platforms.values()]
      .filter((platform) =>
        platform.enabled && platform.models.some(needsModelCompatibility),
      )
      .map((platform) => [platform.id, platform]),
  );
  if (targets.size === 0) return null;

  const history = createToolCallHistory();
  const server = createServer((request, response) => {
    void proxyRequest(request, response, targets, history);
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("模型兼容代理未获取到本地监听端口");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    baseUrlFor(platform) {
      return targets.has(platform.id)
        ? `${origin}/${encodeURIComponent(platform.id)}/`
        : platform.baseUrl;
    },
    close: () => closeServer(server),
  };
}

async function proxyRequest(request, response, targets, history) {
  let route;
  try {
    route = resolveTarget(request.url, targets);
    if (!isResponsesRequest(request, route.path)) {
      forwardPassthrough(request, response, route.url);
      return;
    }
    const body = await readJsonBody(request);
    const model = route.target.models.find((item) => item.id === text(body?.model));
    const preparedBody = model?.historyMode === "reasoning-text-only"
      ? stripReasoningEnvelope(body)
      : body;
    if (!model || !needsModelCompatibility(model)) {
      forwardJson(request.headers, response, route.url, preparedBody);
      return;
    }
    const scopedHistory = history.forPlatform(route.target.id);
    if (!shouldUseChatCompatibility(model, preparedBody)) {
      const normalizedBody = normalizeResponsesRequestToolSchemas(preparedBody);
      const unavailableHostedTools = applyResponsesCapabilityPolicy(normalizedBody, model);
      if (!needsResponsesToolBridge(model)) {
        forwardJson(request.headers, response, route.url, normalizedBody);
        return;
      }
      const previousResponseId = text(preparedBody?.previous_response_id);
      const restored = {
        ...normalizedBody,
        input: restoreToolCalls(normalizedBody, scopedHistory),
      };
      const prepared = prepareResponsesToolRequest(restored, {
        inheritedTools: scopedHistory.getTools(previousResponseId),
        nativeCustomTools: model.capabilities?.customTools === "native"
          ? ["*"]
          : model.capabilities?.nativeCustomTools,
        nativeNamespaceTools: model.capabilities?.namespaceTools === "native",
        ignoredToolTypes: unavailableHostedTools,
      });
      forwardResponsesToolRequest(
        request.headers,
        response,
        route.url,
        prepared,
        scopedHistory,
      );
      return;
    }
    const prepared = prepareChatRequest(preparedBody, scopedHistory, model);
    const targetUrl = new URL(`chat/completions${route.search}`, route.target.baseUrl);
    forwardChatRequest(request.headers, response, targetUrl, prepared, scopedHistory);
  } catch (error) {
    writeError(response, 502, `模型兼容代理请求失败：${error.message}`);
  }
}

export const startModelCompatibilityProxy = startChatCompatibilityProxy;
