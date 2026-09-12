import assert from "node:assert/strict";
import test from "node:test";
import { customCall, startRuntime } from "./support/offline-runtime.mjs";
import { startBrowserHost } from "./support/browser-host.mjs";

test("[A TOOL-04 TOOL-05 TOOL-06 UI-03] 真实宿主回调完成受控网页搜索、读取、查找和浏览器输入点击", { timeout: 30_000 }, async t => {
  const host = await startBrowserHost(t);
  const r = await startRuntime(t, { profile: "chat" });
  r.rpc.onRequest = async request => { assert.equal(request.method, "item/tool/call"); return host.handle(request.params); };
  const { thread } = await r.thread({ dynamicTools: host.tools });
  r.enqueue(...["search", "open", "find"].map(operation => [customCall("exec", `text(await tools.fixture_web({operation:${JSON.stringify(operation)}}));`)]),
    [customCall("exec", 'text(await tools.fixture_browser({text:"PAGE_MARKER_7329"}));')],
    async () => { await host.verify(); return "HOST_WORKFLOW_COMPLETE"; });
  await r.turn(thread.id, "按顺序搜索、打开、查找测试页，并将找到的标记填入浏览器发送");
  await host.verify();
});
