import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { translateResponsesPayload, createResponsesToolStreamTranslator } from "../responses-tool-adapter.mjs";
import { text } from "./contract.mjs";
import { forwardUpstreamError, normalizedHeaders, forwardClientCancellation, writeError, readBodyText, extractErrorMessage, writeSse } from "./transport.mjs";

function forwardResponsesToolRequest(requestHeaders, response, targetUrl, prepared, history) {
  const body = Buffer.from(JSON.stringify(prepared.body));
  const headers = normalizedHeaders(requestHeaders, true);
  headers["content-type"] = "application/json";
  headers["content-length"] = String(body.length);
  headers["accept-encoding"] = "identity";
  const transport = targetUrl.protocol === "https:" ? requestHttps : requestHttp;
  const upstream = transport(targetUrl, { method: "POST", headers }, (upstreamResponse) => {
    if ((upstreamResponse.statusCode ?? 502) < 200 || (upstreamResponse.statusCode ?? 502) >= 300) {
      void forwardUpstreamError(upstreamResponse, response, "Responses");
      return;
    }
    if (prepared.body.stream) {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      pipeResponsesToolStream(upstreamResponse, response, prepared, history);
      return;
    }
    void forwardResponsesToolJson(upstreamResponse, response, prepared, history);
  });
  upstream.once("error", (error) => writeError(response, 502, `Responses 上游请求失败：${error.message}`));
  forwardClientCancellation(response, upstream);
  upstream.end(body);
}

async function forwardResponsesToolJson(upstream, response, prepared, history) {
  try {
    const body = JSON.parse(await readBodyText(upstream));
    if (body?.error) throw new Error(extractErrorMessage(JSON.stringify(body)));
    const converted = translateResponsesPayload(body, prepared.plan);
    history.remember(converted, prepared.source.tools);
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(converted));
  } catch (error) {
    writeError(response, 502, `Responses 工具转换失败：${error.message}`);
  }
}

function pipeResponsesToolStream(upstream, response, prepared, history) {
  const translator = createResponsesToolStreamTranslator(prepared.plan);
  let pending = "";
  let failed = false;
  upstream.setEncoding("utf8");
  const acceptBlock = (block) => {
    if (failed || !block.trim()) return;
    const lines = block.split(/\r?\n/);
    const declaredEventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
    const data = lines.filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) {
      response.write(`${block}\n\n`);
      return;
    }
    if (data === "[DONE]") {
      response.write(`data: [DONE]\n\n`);
      return;
    }
    try {
      const value = JSON.parse(data);
      const eventName = declaredEventName || text(value?.type) || "message";
      for (const output of translator.accept(eventName, value)) {
        writeSse(response, output.event, output.data);
        if (["response.completed", "response.incomplete"].includes(output.data?.type)) {
          history.remember(output.data.response, prepared.source.tools);
        }
      }
    } catch (error) {
      failed = true;
      writeSse(response, "response.failed", {
        type: "response.failed",
        response: {
          status: "failed",
          error: { type: "tool_translation_error", message: error.message },
          output: [],
        },
      });
    }
  };
  upstream.on("data", (chunk) => {
    pending += chunk;
    const blocks = pending.split(/\r?\n\r?\n/);
    pending = blocks.pop() ?? "";
    for (const block of blocks) acceptBlock(block);
  });
  upstream.once("end", () => {
    if (pending.trim()) acceptBlock(pending);
    response.end();
  });
  upstream.once("error", (error) => {
    if (!response.destroyed && !failed) {
      writeSse(response, "response.failed", {
        type: "response.failed",
        response: {
          status: "failed",
          error: { type: "upstream_error", message: `Responses 流中断：${error.message}` },
          output: [],
        },
      });
    }
    response.end();
  });
}

export { forwardResponsesToolRequest };
