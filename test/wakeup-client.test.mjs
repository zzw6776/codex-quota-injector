import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { sendWakeupRequest } from "../src/wakeup-client.mjs";
import { useTempDir } from "./helpers.mjs";

const wakeupFixturePath = fileURLToPath(new URL("./fixtures/wakeup-process.mjs", import.meta.url));

async function fixture(t, scenario) {
  const directory = await useTempDir(t);
  const trace = join(directory, "trace.jsonl");
  const calls = [];
  let spawned;
  let child;
  return {
    calls,
    run(signal = new AbortController().signal) {
      return sendWakeupRequest(async options => {
        calls.push(options);
        return { accessToken: "fixture-secret-token", chatgptAccountId: "fixture-account", chatgptPlanType: "plus" };
      }, signal, {
        timeoutMs: scenario === "hang" ? 200 : 2000,
        resolveExecutable: async () => "fixture-cli",
        spawnProcess(executable, args, options) {
          spawned = { executable, args, options };
          child = spawn(process.execPath, [wakeupFixturePath, scenario, trace], options);
          return child;
        },
      });
    },
    async verifyCleaned() {
      assert.ok(child.exitCode !== null || child.signalCode !== null);
      assert.equal(spawned.options.env.HOME, spawned.options.env.CODEX_HOME);
      assert.equal(spawned.options.cwd, spawned.options.env.CODEX_HOME);
      assert.ok(!spawned.args.includes("fixture-secret-token"));
      assert.ok(Object.entries(spawned.options.env).every(([key]) => !/^(OPENAI_|CHATGPT_)/i.test(key)));
      await assert.rejects(readFile(join(spawned.options.cwd, "auth.json")), { code: "ENOENT" });
      await assert.rejects(readFile(spawned.options.cwd), { code: "ENOENT" });
      return (await readFile(trace, "utf8")).trim().split("\n").map(JSON.parse);
    },
  };
}

test("[A WK-02 ACC-03] 唤醒遍历模型分页选择最低已知价格、最低推理档，并完成一次刷新回调", async t => {
  const f = await fixture(t, "refresh");
  const result = await f.run();
  assert.deepEqual(result, { model: "gpt-5.4-mini", reply: "OK" });
  assert.deepEqual(f.calls, [{ forceRefresh: false }, { forceRefresh: true }]);
  const trace = await f.verifyCleaned();
  const thread = trace.find(r => r.method === "thread/start").params;
  assert.equal(thread.ephemeral, true); assert.equal(thread.sandbox, "read-only");
  const turns = trace.filter(r => r.method === "turn/start");
  assert.equal(turns.length, 1); assert.equal(turns[0].params.effort, "low");
});

test("[A WK-02 HAR-04 OBS-02] 唤醒无已知模型、协议错误、宿主交互、超时和凭据错误均停止并清理", async t => {
  const cases = { "unknown-model": /缺少价格/, malformed: /解析/, exit: /退出|通信中断/, interaction: /额外交互/, hang: /超时.*结果未知/, "secret-error": /\[已隐藏凭据\]/ };
  for (const [scenario, pattern] of Object.entries(cases)) await t.test(scenario, async t => {
    const f = await fixture(t, scenario);
    await assert.rejects(f.run(), error => { assert.match(error.message, pattern); assert.doesNotMatch(error.message, /fixture-secret-token/); return true; });
    const trace = await f.verifyCleaned();
    if (scenario === "unknown-model") assert.ok(!trace.some(r => r.method === "turn/start"));
  });
});
