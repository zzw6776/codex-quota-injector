import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { prepareModelTestRuntime } from "../scripts/test-support.mjs";
import { useTempDir } from "./helpers.mjs";

test("[HAR-04] 缺失或损坏的免费报告不阻断模型测试，Windows 仍准备本次原生 Relay", async t => {
  const root = await useTempDir(t);
  const artifact = { path: join(root, "relay.exe"), sha256: "new-relay", kind: "windows-pe-sea" };
  let builds = 0;
  const options = { runtimeTarget: "windows-native", root,
    snapshotSource: async () => ({ sha256: "current-source" }),
    inspectRuntime: async () => ({ cli: { sha256: "current-cli" } }),
    buildWindowsRelay: async input => { assert.equal(input.root, root); builds++; return artifact; } };
  for (const contents of [null, "not valid JSON", '{"status":"failed","snapshot":{"sha256":"old"}}']) {
    if (contents !== null) {
      await mkdir(join(root, ".runtime", "test-results"), { recursive: true });
      await writeFile(join(root, ".runtime", "test-results", "offline.json"), contents);
    }
    const prepared = await prepareModelTestRuntime(options);
    assert.equal(prepared.snapshot.sha256, "current-source");
    assert.equal(prepared.relay, artifact);
    assert.equal(prepared.freeRegressionGate, "not-required");
  }
  assert.equal(builds, 3);
  await assert.rejects(prepareModelTestRuntime({ ...options, buildWindowsRelay: async () => { throw Error("native build failed"); } }), /native build failed/);
});

test("[HAR-04] WSL 模型测试不会准备或继承 Windows PE Relay", async () => {
  const prepared = await prepareModelTestRuntime({ runtimeTarget: "wsl-native",
    snapshotSource: async () => ({ sha256: "current" }), inspectRuntime: async () => ({}),
    buildWindowsRelay: async () => { throw Error("must not build PE for WSL"); } });
  assert.equal(prepared.relay, null);
  assert.equal(prepared.snapshot.sha256, "current");
});
