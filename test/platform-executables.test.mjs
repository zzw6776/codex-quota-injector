import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { resolveCodexCliExecutable } from "../src/platform/executables.mjs";

test("macOS 新旧应用目录均能发现 CLI，新目录存在时优先使用", async t => {
  const root = await mkdtemp(join(tmpdir(), "quota-cli-layout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ["ChatGPT.app", "Codex.app"]) {
    const resources = join(root, name, "Contents", "Resources");
    const oldCli = join(resources, "codex");
    const newCli = join(resources, "codex-cli", "CodexCLI.app", "Contents", "MacOS", "codex");
    await mkdir(dirname(newCli), { recursive: true });
    const options = { platform: "darwin", environment: {},
      resolveApp: async () => join(root, name, "Contents", "MacOS", name.slice(0, -4)) };
    await assert.rejects(resolveCodexCliExecutable(options), /可执行文件不存在/);
    await writeFile(oldCli, "legacy CLI fixture");
    assert.equal(await resolveCodexCliExecutable(options), oldCli);
    await writeFile(newCli, "current CLI fixture");
    assert.equal(await resolveCodexCliExecutable(options), newCli);
  }
});

test("CLI 显式路径优先且缺失时不静默回退", async () => {
  const explicitPath = join(tmpdir(), "explicit", "codex");
  const options = { environment: { CODEX_QUOTA_UPSTREAM_CODEX_CLI: explicitPath },
    existsImpl: async () => true, resolveApp: () => { throw Error("must not resolve app"); } };
  assert.equal(await resolveCodexCliExecutable(options), explicitPath);
  await assert.rejects(resolveCodexCliExecutable({ ...options, existsImpl: async () => false }), /指定的 Codex CLI 不存在/);
});

test("Windows 路径候选及 CLI 物化流程保持不变", async () => {
  const app = join("windows-fixture", "ChatGPT.exe");
  const upstream = join(dirname(app), "resources", "codex.exe");
  const result = await resolveCodexCliExecutable({ platform: "win32", environment: {},
    resolveApp: async () => app, existsImpl: async path => path === upstream,
    materializeCli: async path => { assert.equal(path, upstream); return "materialized-cli"; } });
  assert.equal(result, "materialized-cli");
});
