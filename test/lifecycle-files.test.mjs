import assert from "node:assert/strict";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { writeLifecycleFile } from "../src/lifecycle-files.mjs";
import { createLifecycleReport, writeLifecycleReport } from "../src/lifecycle-runner.mjs";
import { writeLifecycleProgressPage } from "../src/lifecycle-progress.mjs";
import { useTempDir } from "./helpers.mjs";

for (const type of ["report", "page"]) {
  test(`Windows ${type} 替换遇到短暂文件占用时保留完整旧文件并重试`, async t => {
    const directory = await useTempDir(t);
    const path = join(directory, type === "report" ? "report.json" : "progress.html");
    const reportPath = join(directory, "source.json");
    const report = createLifecycleReport({ steps: ["verify"] });
    await writeLifecycleReport(reportPath, report);
    await writeFile(path, "old-complete-content");
    const codes = ["EPERM", "EACCES", "EBUSY"];
    const delays = [];
    let attempts = 0;
    const options = {
      platform: "win32",
      renameFile: async (source, destination) => {
        const code = codes[attempts++];
        if (code) {
          assert.equal(await readFile(path, "utf8"), "old-complete-content");
          throw Object.assign(new Error(code), { code });
        }
        await rename(source, destination);
      },
      sleep: async ms => { delays.push(ms); },
    };
    if (type === "report") await writeLifecycleReport(path, report, options);
    else await writeLifecycleProgressPage(reportPath, path, options);
    assert.equal(attempts, 4);
    assert.deepEqual(delays, [25, 50, 100]);
    const content = await readFile(path, "utf8");
    if (type === "report") assert.equal(JSON.parse(content).runId, report.runId);
    else {
      assert.ok(content.includes(report.runId));
      assert.match(content, /<\/html>$/);
    }
    assert.equal((await readdir(directory)).some(name => name.includes(".tmp.")), false);
  });
}

for (const [platform, code, expectedAttempts] of [
  ["win32", "EPERM", 5], ["win32", "ENOSPC", 1], ["darwin", "EPERM", 1],
]) {
  test(`${platform} ${code} 写入失败保留旧文件、有限结束并清除临时文件`, async t => {
    const directory = await useTempDir(t);
    const path = join(directory, "report.json");
    await writeFile(path, "old-complete-content");
    let attempts = 0;
    const error = Object.assign(new Error(code), { code });
    await assert.rejects(writeLifecycleFile(path, "new", {
      platform,
      renameFile: async () => { attempts++; throw error; },
      sleep: async () => {},
    }), value => value === error);
    assert.equal(attempts, expectedAttempts);
    assert.equal(await readFile(path, "utf8"), "old-complete-content");
    assert.deepEqual(await readdir(directory), ["report.json"]);
  });
}
