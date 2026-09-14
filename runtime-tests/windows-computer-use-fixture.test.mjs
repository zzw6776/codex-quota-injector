import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  verifyWindowsComputerUseFixture,
  windowsComputerUseFixtureSource,
} from "../scripts/test-computer-use-windows.mjs";

const execFileAsync = promisify(execFile);

test("[A TOOL-06 HAR-04] Windows 非浏览器 Computer Use 材料拒绝错误值和重复提交", () => {
  const marker = "WINDOWS_CU_contract";
  assert.deepEqual(verifyWindowsComputerUseFixture({
    marker,
    evidence: {
      schemaVersion: 1,
      marker,
      launchCount: 1,
      submissions: [{ value: marker }],
    },
  }), { launchCount: 1, submissionCount: 1 });
  assert.throws(() => verifyWindowsComputerUseFixture({
    marker,
    evidence: {
      schemaVersion: 1,
      marker,
      launchCount: 1,
      submissions: [{ value: "WRONG" }],
    },
  }), /随机标记不一致/);
  assert.throws(() => verifyWindowsComputerUseFixture({
    marker,
    evidence: {
      schemaVersion: 1,
      marker,
      launchCount: 1,
      submissions: [{ value: marker }, { value: marker }],
    },
  }), /恰好一次提交/);
});

test("[A TOOL-06 ENV-03] Windows 原生材料使用每轮路径和随机标记且可独立自检", { timeout: 30_000 }, async t => {
  const source = windowsComputerUseFixtureSource({
    evidencePath: String.raw`D:\temporary\computer-use-evidence.json`,
    marker: "WINDOWS_CU_source_contract",
  });
  assert.match(source, /System\.Windows\.Forms/);
  assert.match(source, /AccessibleName = "Random marker " \+ marker/);
  assert.match(source, /AcceptButton = submit/);
  assert.doesNotMatch(source, /Users\\ZZW|codex-quota-injector/);

  if (process.platform !== "win32") return;
  const directory = await mkdtemp(join(tmpdir(), "codex-cu-native-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runId = "self-test";
  const script = resolve(import.meta.dirname, "../scripts/test-computer-use-windows.mjs");
  await execFileAsync(process.execPath, [
    script,
    "--native-child",
    "--self-test",
    `--result-dir=${directory}`,
    `--run-id=${runId}`,
    "--timeout-ms=10000",
  ], { timeout: 20_000, windowsHide: true });
  const manifest = JSON.parse(await readFile(
    join(directory, runId, "computer-use-fixture.json"),
    "utf8",
  ));
  assert.equal(manifest.kind, "windows-native-computer-use");
  assert.equal(manifest.status, "passed");
  assert.deepEqual(verifyWindowsComputerUseFixture(manifest), {
    launchCount: 1,
    submissionCount: 1,
  });
  await execFileAsync(manifest.executablePath, ["--self-test"], {
    timeout: 20_000,
    windowsHide: true,
  });
  const repeatedEvidence = JSON.parse(await readFile(manifest.evidencePath, "utf8"));
  assert.equal(repeatedEvidence.launchCount, 2);
  assert.equal(repeatedEvidence.submissions.length, 2);
  assert.throws(() => verifyWindowsComputerUseFixture({
    marker: manifest.marker,
    evidence: repeatedEvidence,
  }), /只启动一次/);
});
