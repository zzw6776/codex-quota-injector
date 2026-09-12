import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startBrowser } from "./browser.mjs";

// Controlled adapters exercise the host callback contract. They deliberately do
// not impersonate web.run or the desktop computer-use plugin.
export async function startBrowserHost(t) {
  const browser = await startBrowser(t);
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("Fixture Web Page\nPAGE_MARKER_7329\nSearch and browser host fixture.");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/fixture`;
  const operations = [];
  const tools = [
    { type: "function", name: "fixture_web", description: "Read the controlled fixture web page. Search first, then open, then find PAGE_MARKER.",
      inputSchema: { type: "object", properties: { operation: { type: "string", enum: ["search", "open", "find"] } }, required: ["operation"], additionalProperties: false } },
    { type: "function", name: "fixture_browser", description: "Type the given text into the controlled browser and click its Send button once.",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } },
  ];
  return { browser, requests, operations, tools,
    async handle(params) {
      const args = params.arguments;
      let text;
      if (params.tool === "fixture_web") {
        assert.ok(["search", "open", "find"].includes(args.operation));
        operations.push(args.operation);
        const page = await fetch(`${url}?operation=${args.operation}`).then(r => r.text());
        text = args.operation === "search" ? `Fixture Web Page: ${url}` : args.operation === "find" ? page.split("\n").find(line => line.includes("PAGE_MARKER")) : page;
      } else if (params.tool === "fixture_browser") {
        operations.push("browser");
        assert.equal(typeof args.text, "string");
        await browser.fill("#composer", args.text, { shadow: false });
        await browser.click("#send", { shadow: false });
        text = JSON.stringify(await browser.client.evaluate("window.nativeMessages"));
      } else throw new Error(`非测试工具 ${params.tool}`);
      return { success: true, contentItems: [{ type: "inputText", text }] };
    },
    async verify() {
      assert.deepEqual(operations, ["search", "open", "find", "browser"]);
      assert.equal(requests.length, 3);
      assert.deepEqual(await browser.client.evaluate("window.nativeMessages"), ["PAGE_MARKER_7329"]);
    },
  };
}
