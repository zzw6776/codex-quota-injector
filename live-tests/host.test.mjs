import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { startBrowserHost } from "../runtime-tests/support/browser-host.mjs";
import {
  approved,
  liveBudget,
  liveProfiles,
  selectLiveProfiles,
  startLiveRuntime,
} from "./runtime.mjs";
import { findOfficialAppServerUrl } from "./web-search-contract.mjs";

const profiles = approved ? selectLiveProfiles(await liveProfiles()) : [];
let failed = false;

if (!approved) test("真实宿主适配定向测试未获授权，不读取当前账号或发送模型请求", { skip: true }, () => {});
for (const profile of profiles) test(`[B TOOL-04 IO-01 IO-03 INT-02] ${profile.id} 真实宿主适配与用户输入`, { timeout: 240_000 }, async t => {
  if (failed) { t.skip("前一配置失败；停止付费用例，保留尚未执行状态"); return; }
  const budget = liveBudget();
  let r;
  let stage = "启动隔离运行时";
  try {
    r = await startLiveRuntime(t, profile, budget);
    const host = await startBrowserHost(t);
    let questions = 0;
    r.rpc.onRequest = async request => {
      if (request.method === "item/tool/call") return host.handle(request.params);
      if (request.method === "item/tool/requestUserInput") {
        questions++;
        return {
          answers: Object.fromEntries(request.params.questions.map(question =>
            [question.id, { answers: ["继续测试"] }])),
        };
      }
      throw new Error(`未支持的宿主交互 ${request.method}`);
    };

    stage = "动态网页与浏览器宿主";
    const hostThread = (await r.thread({ dynamicTools: host.tools })).thread;
    await r.turn(hostThread.id,
      "按顺序各调用一次 fixture_web 的 search、open、find，读取网页中的 PAGE_MARKER。接着只调用一次 fixture_browser，把完整标记（包含数字）输入并发送，最后确认结果。不要改用 shell 或其他工具。");
    await host.verify();

    if (profile.images) {
      stage = "图片输入";
      await host.browser.client.evaluate('document.body.style.background="#ff0000"');
      const screenshot = await host.browser.client.request("Page.captureScreenshot", {
        clip: { x: 0, y: 0, width: 256, height: 256, scale: 1 },
      });
      await writeFile(join(r.cwd, "vision.png"), Buffer.from(screenshot.data, "base64"));
      const imageThread = (await r.thread()).thread;
      const color = await r.turn(imageThread.id, "看图识色", {
        input: [
          { type: "text", text: "这张图片的大面积主色是什么？只用一个英文单词回答，不调用工具。" },
          { type: "localImage", path: join(r.cwd, "vision.png") },
        ],
      });
      assert.match(color.trim(), /^red[.!。]?$/i, "必须从真实图片识别主色");
    }

    if (profile.id === "official") {
      stage = "官方原生网页搜索";
      const webThread = (await r.thread({ config: { web_search: "live" } })).thread;
      const beforeWeb = r.rpc.events.length;
      const web = await r.turn(webThread.id,
        "请实际使用网页搜索寻找 OpenAI 官方 Codex app-server 文档，只回复该文档标题和链接。不要用 shell 代替搜索。");
      assert.ok(r.rpc.events.slice(beforeWeb).some(event =>
        event.method === "item/completed" && event.params.item.type === "webSearch"),
      "未实际执行原生网页搜索");
      assert.ok(findOfficialAppServerUrl(web),
        `网页搜索未返回 OpenAI 官方 app-server 文档链接：${r.sanitize(web)}`);
    }

    stage = "用户输入回调";
    const inputThread = (await r.thread()).thread;
    await r.turn(inputThread.id,
      "用 request_user_input 工具问我是否继续测试，收到答复后只回复答复原文。", {
        collaborationMode: {
          mode: "plan",
          settings: {
            model: r.model,
            reasoning_effort: r.effort ?? null,
            developer_instructions: "这是用户输入回调测试，请实际提问并等候答复。",
          },
        },
      });
    assert.equal(questions, 1, "模型必须实际发起用户输入请求");
    stage = "完成";
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (r) t.diagnostic(`真实宿主适配证据 ${JSON.stringify(await r.diagnostics(stage))}；在途请求可能超过停止阈值。`);
  }
});
