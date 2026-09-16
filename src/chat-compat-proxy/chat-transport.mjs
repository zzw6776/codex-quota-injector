import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { forwardUpstreamError, normalizedHeaders, forwardClientCancellation, writeError, readBodyText, extractErrorMessage } from "./transport.mjs";
import { chatJsonToResponse, ChatResponseState } from "./response.mjs";

function forwardChatRequest(requestHeaders, response, targetUrl, prepared, history) {
  const body = Buffer.from(JSON.stringify(prepared.chat));
  const headers = normalizedHeaders(requestHeaders, true);
  headers["content-type"] = "application/json";
  headers["content-length"] = String(body.length);
  const transport = targetUrl.protocol === "https:" ? requestHttps : requestHttp;
  const upstream = transport(targetUrl, { method: "POST", headers }, (upstreamResponse) => {
    if ((upstreamResponse.statusCode ?? 502) < 200 || (upstreamResponse.statusCode ?? 502) >= 300) {
      void forwardUpstreamError(upstreamResponse, response, "Chat");
      return;
    }
    if (prepared.chat.stream) {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      pipeChatStream(upstreamResponse, response, prepared.source, history);
      return;
    }
    void forwardChatJson(upstreamResponse, response, prepared.source, history);
  });
  upstream.once("error", (error) => writeError(response, 502, `Chat 上游请求失败：${error.message}`));
  forwardClientCancellation(response, upstream);
  upstream.end(body);
}

async function forwardChatJson(upstream, response, source, history) {
  try {
    const body = JSON.parse(await readBodyText(upstream));
    const converted = chatJsonToResponse(body, source);
    history.remember(converted, source.tools);
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(converted));
  } catch (error) {
    writeError(response, 502, `Chat 响应转换失败：${error.message}`);
  }
}

function pipeChatStream(upstream, response, source, history) {
  let pending = "";
  const state = new ChatResponseState(source, (completed) => history.remember(completed, source.tools));
  upstream.setEncoding("utf8");
  upstream.on("data", (chunk) => {
    pending += chunk;
    const blocks = pending.split(/\r?\n\r?\n/);
    pending = blocks.pop() ?? "";
    for (const block of blocks) {
      const data = block.split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data) continue;
      if (data === "[DONE]") {
        state.finish(response);
        continue;
      }
      try {
        const value = JSON.parse(data);
        if (value.error) {
          state.fail(response, extractErrorMessage(JSON.stringify(value)));
          continue;
        }
        state.accept(response, value);
      } catch {
        // Keep proxying valid frames even if a gateway sends a malformed keepalive frame.
      }
    }
  });
  upstream.once("end", () => {
    if (!state.finished) {
      if (state.finishReason) state.finish(response);
      else state.fail(response, "Chat 流在完成标记前结束");
    }
    response.end();
  });
  upstream.once("error", (error) => {
    if (response.destroyed) return;
    state.fail(response, `Chat 流中断：${error.message}`);
    response.end();
  });
}

export { forwardChatRequest };
