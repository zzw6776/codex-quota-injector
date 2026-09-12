import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { customCall, execOffline, officialExecutable, startRuntime } from "./support/offline-runtime.mjs";
import { useTempDir } from "../test/helpers.mjs";
const exec = promisify(execFile);
const gitExecutable = process.platform === "win32" ? "git.exe" : "/usr/bin/git";

test("[A RPC-02 RPC-04 INT-03 IO-04 ENV-02 SES-09] 官方协议升级检查要求重新盘点所有能力分支", { timeout: 30_000 }, async t => {
  const directory = await useTempDir(t);
  const cli = await officialExecutable();
  const expected = JSON.parse(await readFile(new URL("../docs/testing-protocol-inventory.json", import.meta.url), "utf8"));
  for (const [mode, entries] of Object.entries(expected.modes)) {
    const output = join(directory, mode);
    await execOffline(cli, ["app-server", "generate-json-schema", "--out", output, ...(mode === "experimental" ? ["--experimental"] : [])], { directory });
    for (const [type, definition] of Object.entries(entries)) {
      if (!definition.sha256) continue;
      const bytes = await readFile(join(output, `${type}.json`));
      assert.equal(createHash("sha256").update(bytes).digest("hex"), definition.sha256,
        `${mode}/${type} 已变化：需要审核新增/修改的字段、补测试并更新协议清单，不自动沿用旧版通过结果`);
    }
  }
});

test("[A INT-03] 官方用户验证状态通过隔离 shim 明确报告当前平台不可用且不触发模型请求", { timeout: 30_000 }, async t => {
  const r = await startRuntime(t, { profile: "shim" });
  await assert.rejects(r.rpc.request("userVerification/status", {}), error => {
    assert.equal(error.code, -32603);
    assert.deepEqual(error.data, { type: "unavailable", reason: "providerUnavailable" });
    return true;
  });
  assert.equal(r.requests.length, 0, "读取本机验证状态不能调用模型");
});

test("[A EXT-02 MOD-06] 隔离的本地插件真实发现、安装、技能加载、停用和卸载", { timeout: 30_000 }, async t => {
  let marketplacePath;
  const r = await startRuntime(t, { profile: "shim", prepare: async ({ cwd }) => {
    await exec(gitExecutable, ["init", "-q", cwd]);
    const plugin = join(cwd, "plugins", "offline-fixture");
    await mkdir(join(plugin, ".codex-plugin"), { recursive: true });
    await mkdir(join(plugin, "skills", "plugin-marker"), { recursive: true });
    await writeFile(join(plugin, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "offline-fixture", version: "1.0.0", description: "Local test fixture" }));
    await writeFile(join(plugin, "skills", "plugin-marker", "SKILL.md"), "---\nname: plugin-marker\ndescription: Offline plugin test\n---\nPLUGIN_LOADED_MARKER\n");
    marketplacePath = join(cwd, ".agents", "plugins", "marketplace.json");
    await mkdir(join(cwd, ".agents", "plugins"), { recursive: true });
    await writeFile(marketplacePath, JSON.stringify({ name: "offline-regression", plugins: [{ name: "offline-fixture", source: { source: "local", path: "./plugins/offline-fixture" }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" }] }));
  } });
  const listing = await r.rpc.request("plugin/list", { cwds: [r.cwd], forceRefetch: false, marketplaceKinds: ["local"] });
  assert.match(JSON.stringify(listing), /offline-fixture/);
  await r.rpc.request("plugin/read", { marketplacePath, pluginName: "offline-fixture" });
  await r.rpc.request("plugin/install", { marketplacePath, pluginName: "offline-fixture" });
  const installed = await r.rpc.request("plugin/installed", { cwds: [r.cwd] });
  assert.match(JSON.stringify(installed), /offline-fixture/);
  const skills = await r.rpc.request("skills/list", { cwds: [r.cwd], forceReload: true });
  assert.match(JSON.stringify(skills), /plugin-marker/);
  const skill = skills.data.flatMap(x => x.skills).find(s => s.name.includes("plugin-marker"));
  assert.match(await readFile(skill.path, "utf8"), /PLUGIN_LOADED_MARKER/);
  await r.rpc.request("config/value/write", { keyPath: 'plugins."offline-fixture@offline-regression".enabled', value: false, mergeStrategy: "replace" });
  const disabled = await r.rpc.request("skills/list", { cwds: [r.cwd], forceReload: true });
  assert.ok(!disabled.data.flatMap(x => x.skills).some(s => s.name.includes("plugin-marker") && s.enabled !== false));
  await r.rpc.request("plugin/uninstall", { pluginId: "offline-fixture@offline-regression" });
  assert.equal(r.requests.length, 0, "插件管理不应向模型发送请求");
});

test("[A ENV-01 IO-02] 官方审查在临时 Git 工作树读取真实差异并返回审查结果", { timeout: 30_000 }, async t => {
  const r = await startRuntime(t, { profile: "custom" });
  await exec(gitExecutable, ["init", "-q", r.cwd]);
  await writeFile(join(r.cwd, "review.txt"), "BEFORE_REVIEW\n");
  await exec(gitExecutable, ["-C", r.cwd, "add", "review.txt"]);
  await exec(gitExecutable, ["-C", r.cwd, "-c", "user.name=Offline Test", "-c", "user.email=offline@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]);
  await writeFile(join(r.cwd, "review.txt"), "AFTER_REVIEW\n");
  const { thread } = await r.thread();
  r.enqueue([customCall("exec", 'text(await tools.exec_command({cmd:"git diff -- review.txt",login:false}));')], body => {
    const results = JSON.stringify(body.input.filter(i => /call_output/.test(i.type)));
    assert.match(results, /BEFORE_REVIEW/); assert.match(results, /AFTER_REVIEW/);
    return JSON.stringify({ findings: [], overall_correctness: "patch is correct", overall_explanation: "Fixture diff inspected.", overall_confidence_score: 1 });
  });
  const after = r.rpc.events.length;
  const review = await r.rpc.request("review/start", { threadId: thread.id, target: { type: "uncommittedChanges" }, delivery: "inline" });
  const finished = await r.rpc.event("turn/completed", p => p.threadId === thread.id, { after });
  assert.equal(finished.turn.status, "completed");
  assert.ok(r.rpc.events.slice(after).some(e => e.params?.item?.type === "exitedReviewMode"));
  assert.equal(await readFile(join(r.cwd, "review.txt"), "utf8"), "AFTER_REVIEW\n");
});
