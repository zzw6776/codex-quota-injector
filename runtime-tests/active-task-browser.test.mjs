import assert from "node:assert/strict";
import test from "node:test";
import { readVisibleHostTask } from "../src/injector/active-task.mjs";
import { startBrowser } from "./support/browser.mjs";

test("当前任务识别忽略隐藏聊天，但不借用多个可见聊天或主页的 ID", { timeout: 30000 }, async t => {
  const b = await startBrowser(t);
  const current = "01a0cc06-6ac8-7951-851e-2b17ef3f79fd";
  const previous = "01a0cc07-6ac8-7951-851e-2b17ef3f79fd";
  await b.client.evaluate(`(() => {
    const fixture = document.createElement('section');
    fixture.id = 'task-fixture';
    fixture.innerHTML = '<div data-app-action-sidebar-thread-active="true" data-app-action-sidebar-thread-host-id="local" data-app-action-sidebar-thread-kind="local" data-app-action-sidebar-thread-id="local:client-new-thread:temporary"></div>' +
      '<div id="previous-chat" style="display:none"><div data-codex-composer-root data-composer-placement="thread"><textarea></textarea><div data-above-composer-conversation-id="${previous}"></div></div></div>' +
      '<div id="current-chat"><div data-codex-composer-root data-composer-placement="thread"><textarea></textarea><div style="display:none" data-above-composer-conversation-id="${current}"></div><div data-above-composer-conversation-id="${current}"></div></div></div>' +
      '<div data-codex-composer-root data-composer-placement="home"><textarea></textarea><div data-above-composer-conversation-id="${previous}"></div></div>';
    document.body.append(fixture);
  })()`);
  const read = () => b.client.evaluate(`(${readVisibleHostTask.toString()})()`);
  assert.deepEqual(await read(), { hostId: "local", threadId: current });
  await b.client.evaluate("document.getElementById('previous-chat').style.cssText='visibility:hidden'");
  assert.deepEqual(await read(), { hostId: "local", threadId: current });
  await b.client.evaluate("document.getElementById('previous-chat').style.cssText=''");
  assert.equal(await read(), null, "两个可见聊天不能任意选择一个");
  await b.client.evaluate("document.getElementById('current-chat').hidden=true");
  assert.deepEqual(await read(), { hostId: "local", threadId: previous });
  await b.client.evaluate("document.getElementById('previous-chat').hidden=true");
  assert.equal(await read(), null, "主页输入框不能提供任务 ID");
  await b.client.evaluate(`document.querySelector('#task-fixture [data-app-action-sidebar-thread-id]').setAttribute('data-app-action-sidebar-thread-id','local:${current}')`);
  assert.deepEqual(await read(), { hostId: "local", threadId: current }, "旧 UI 的真实侧栏 ID 不依赖输入框");
});
