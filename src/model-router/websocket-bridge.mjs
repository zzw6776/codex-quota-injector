import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { customRequestShape, prepareCustomWebSocketRequest } from "./request-policy.mjs";
import { requestHeaders } from "./http-transport.mjs";
import { createResponseObservation } from "./response-observation.mjs";
import { consumeResponsePayloads, responseEvent, readLimitedResponseText, upstreamErrorMessage } from "./response-stream.mjs";
import { sendWebSocketFailure, withWebSocketTransport, sendWebSocketJson, isTerminalResponseEvent } from "./websocket-transport.mjs";
import { observeDiagnosticResponse } from "./transport-diagnostics.mjs";

function startHttpWebSocketBridge({
  client,
  sourceHeaders,
  search,
  body,
  target,
  context,
  streamId,
  onUsage,
  onToolCall,
  onGeneration,
  onResponse,
  onRequestShape,
  onPrepared,
  onAccepted,
  onDone,
  createDiagnostic,
}) {
  const prepared = prepareCustomWebSocketRequest(body, target);
  const requestShape = customRequestShape(prepared);
  onRequestShape?.(requestShape);
  onPrepared?.();
  const payload = Buffer.from(JSON.stringify(prepared));
  const targetUrl = new URL(`responses${search}`, target.baseUrl);
  const headers = requestHeaders(sourceHeaders, target, payload.length);
  const diagnostic = createDiagnostic?.({ context, transport: "websocket-http-bridge",
    method: "POST", endpoint: "/v1/responses", url: targetUrl, headers, body: prepared, wireBody: payload });
  const transport = targetUrl.protocol === "https:" ? requestHttps : requestHttp;
  const observation = createResponseObservation({
    requestStartedAt: context.requestStartedAt,
    requireCompleted: true,
    onUsage,
    onToolCall,
    onGeneration,
  });
  let upstreamResponse = null;
  let finished = false;
  let sequenceNumber = 0;
  const finish = () => {
    if (finished) return;
    finished = true;
    onDone();
  };
  const fail = (message) => {
    observation.abort();
    sendWebSocketFailure(client, body, streamId, message, sequenceNumber++);
  };
  const upstream = transport(targetUrl, { method: "POST", headers }, (response) => {
    if (diagnostic) observeDiagnosticResponse(response, diagnostic);
    upstreamResponse = response;
    observation.markResponseStarted();
    const statusCode = response.statusCode ?? 502;
    if (statusCode < 200 || statusCode >= 300) {
      console.error(
        `[model-router] ${target.displayName} 上游返回 ${statusCode}；` +
        `脱敏请求结构=${JSON.stringify(requestShape)}`,
      );
      void readLimitedResponseText(response).then((text) => {
        fail(upstreamErrorMessage(statusCode, text));
      }).catch((error) => {
        fail(`自定义模型响应读取失败：${error.message}`);
      }).finally(finish);
      return;
    }
    onAccepted?.();
    let terminalSeen = false;
    consumeResponsePayloads(response, {
      onPayload(value) {
        const event = responseEvent(value);
        if (!event) return;
        if (isTerminalResponseEvent(event.type)) terminalSeen = true;
        if (event.type === "response.failed") {
          console.error(
            `[model-router] ${target.displayName} 上游响应失败；` +
            `脱敏请求结构=${JSON.stringify(requestShape)}`,
          );
        }
        if (["response.completed", "response.incomplete"].includes(event.type)) onResponse?.(event.response);
        observation.recordPayload(event);
        sendWebSocketJson(
          client,
          withWebSocketTransport(event, streamId, sequenceNumber++),
        );
      },
      onEnd() {
        if (!terminalSeen) {
          fail("自定义模型响应在完成事件前中断");
        } else {
          observation.finish();
        }
        finish();
      },
      onError(error) {
        fail(`自定义模型响应流中断：${error.message}`);
        finish();
      },
    });
  });
  upstream.once("error", (error) => {
    diagnostic?.error(error);
    diagnostic?.finish("request-error");
    if (finished) return;
    fail(`自定义模型请求失败：${error.message}`);
    finish();
  });
  diagnostic?.requestHeaders(upstream.getHeaders());
  upstream.end(payload);
  return {
    cancel() {
      if (finished) return;
      diagnostic?.finish("cancelled");
      observation.abort();
      upstreamResponse?.destroy();
      upstream.destroy();
      finish();
    },
  };
}

export { startHttpWebSocketBridge };
