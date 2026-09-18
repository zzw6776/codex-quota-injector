import assert from "node:assert/strict";
import test from "node:test";
import { createHostHealth } from "../src/widget/host-health.mjs";
import { createPanel } from "../src/widget/panel.mjs";

test("超时为黄色未确认，恢复按钮收进更多，详情不把未检查项冒充通过", () => {
  const health = { required: true, threadId: "task", status: "unconfirmed", canCheck: true,
    canRestart: true, canOpenLogs: true, requiredTools: ["read_thread"], checks: {
      read_thread: { status: "unconfirmed", detail: "检查超时" },
    } };
  const state = { data: { hostHealth: health } };
  const widget = createHostHealth({ state, escapeHtml: String, formatUpdatedAt: String });
  let banner = widget.renderHostHealthBanner(health);
  assert.match(banner, /banner unconfirmed/);
  assert.match(banner, /重新检查/);
  assert.doesNotMatch(banner, /role="alert"|>刷新工具配置<|>重启 Codex 应用</);
  state.hostHealthDetailsThread = "task";
  state.hostHealthMoreThread = "task";
  banner = widget.renderHostHealthBanner(health);
  assert.match(banner, /读取任务内容：未确认/);
  assert.match(banner, /可能影响其他任务/);
  assert.match(banner, /检查完整工具目录/);
});

test("按钮分别发送检查、目录诊断和重载动作并绑定任务，详情操作不调用工具", () => {
  const listeners = new Map(), actions = [];
  const state = { data: { hostHealth: { threadId: "task" } } };
  let renders = 0;
  const panel = createPanel({ state, enqueue: x => actions.push(x), render: () => renders++ });
  panel.bindGeneralEvents({ querySelector(selector) {
    if (selector === ".detail-popover" || selector === ".panel-scroll") return null;
    return { addEventListener(event, fn) { listeners.set(`${selector}:${event}`, fn); } };
  }, querySelectorAll: () => [] });
  for (const name of ["recheck", "reload", "diagnose"]) {
    listeners.get(`.host-health-${name}:click`)({ currentTarget: {} });
  }
  assert.deepEqual(actions, ["recheck", "reload", "diagnose"].map(name => ({ type: `host-health-${name}`, threadId: "task" })));
  listeners.get(".host-health-details:click")();
  assert.equal(state.hostHealthDetailsThread, "task");
  assert.equal(actions.length, 3);
  assert.equal(renders, 1);
});
