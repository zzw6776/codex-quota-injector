import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { useTempDir } from "./helpers.mjs";

const exec = promisify(execFile);
const workflow = await readFile(new URL("../.github/workflows/build-packages.yml", import.meta.url), "utf8");

// Execute the workflow's actual inline code against disposable files and a
// fake gh function. Tests never create releases or upload packages.
function workflowRun(name) {
  const step = workflow.split(`      - name: ${name}\n`)[1];
  assert.ok(step, `Missing workflow step ${name}`);
  const lines = [];
  for (const line of step.split("        run: |\n")[1].split("\n")) {
    if (line.trim() && !line.startsWith("          ")) break;
    lines.push(line.slice(10));
  }
  return lines.join("\n");
}

const validation = workflowRun("Validate version release notes").split("<<'NODE'\n")[1].split("\nNODE")[0];
const publication = workflowRun("Create GitHub release");

async function fixture(t, notes = "# 0.1.323\n\n## 修复\n\n- 修复更新确认页展示旧版本说明的问题。\n", version = "0.1.323") {
  const directory = await useTempDir(t, "release-notes-");
  await mkdir(join(directory, "docs", "releases"), { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ version }));
  if (notes != null) await writeFile(join(directory, "docs", "releases", `${version}.md`), notes);
  return directory;
}

test("CI 实际校验接受当前版本中文日志和 Windows 换行，正文保留不变", async t => {
  const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const notes = await readFile(new URL(`../docs/releases/${version}.md`, import.meta.url), "utf8");
  for (const content of [notes, notes.replace(/\n/g, "\r\n")]) {
    const directory = await fixture(t, content, version);
    const result = await exec(process.execPath, ["--input-type=module", "-e", validation], { cwd: directory });
    assert.ok(result.stdout.includes(`Validated docs/releases/${version}.md`));
    assert.equal(await readFile(join(directory, "docs", "releases", `${version}.md`), "utf8"), content);
  }
});

test("CI 实际校验拒绝缺失、空白、错误版本以及没有中文变更的说明", async t => {
  for (const notes of [null, "", " \n", "# 0.1.322\n- 修复问题", "# 0.1.323\n",
    "# 0.1.323\n\n## 修复\n-   \n", "# 0.1.323\n- Full Changelog: https://example.test/compare"]) {
    const directory = await fixture(t, notes);
    await assert.rejects(exec(process.execPath, ["--input-type=module", "-e", validation], { cwd: directory }),
      error => error.code === 1 && /ENOENT|first line|Chinese change entry/.test(error.stderr));
  }
});

async function publishFixture(t, { existing = false, ref = "refs/heads/master" } = {}) {
  const directory = await fixture(t);
  await mkdir(join(directory, "release-assets"));
  await writeFile(join(directory, "release-assets", "package.dmg"), "fixture");
  const callsPath = join(directory, "calls.txt");
  const mock = `
    node() { printf '0.1.323\\n'; }
    gh() {
      printf '%s\\t' "$@" >> "$TEST_RELEASE_CALLS"
      printf '\\n' >> "$TEST_RELEASE_CALLS"
      if [[ "$2" == view ]]; then return "$TEST_RELEASE_VIEW_STATUS"; fi
      while (( $# )); do
        if [[ "$1" == --notes-file ]]; then cp "$2" published-notes.md; break; fi
        shift
      done
    }
  `;
  let error = null;
  try {
    await exec("bash", ["-c", `${mock}\n${publication}`], { cwd: directory,
      env: { ...process.env, TEST_RELEASE_CALLS: callsPath, TEST_RELEASE_VIEW_STATUS: existing ? "0" : "1",
        GITHUB_REF: ref, GITHUB_REF_NAME: ref.split("/").at(-1),
        GITHUB_SHA: "fixture-sha", GITHUB_REPOSITORY: "fixture/repository" } });
  } catch (cause) { error = cause; }
  const calls = (await readFile(callsPath, "utf8").catch(() => ""))
    .split("\n").filter(Boolean).map(line => line.split("\t").slice(0, -1));
  return { directory, calls, error };
}

for (const existing of [false, true]) {
  test(`CI ${existing ? "重跑已有" : "新建"} Release 原样使用版本正文`, { skip: process.platform === "win32" }, async t => {
    const { directory, calls, error } = await publishFixture(t, { existing });
    assert.equal(error, null);
    assert.deepEqual(calls.map(args => args[1]), existing
      ? ["view", "upload", "edit"] : ["view", "create", "upload", "edit"]);
    const write = calls.find(args => args.includes("--notes-file"));
    assert.equal(write[2], "v0.1.323");
    assert.equal(write[write.indexOf("--notes-file") + 1], "docs/releases/0.1.323.md");
    assert.ok(!write.includes("--generate-notes"));
    if (!existing) {
      assert.ok(calls[1].includes("--draft"));
      assert.ok(calls.at(-1).includes("--draft=false"));
      assert.ok(calls.at(-1).includes("--latest"));
    }
    assert.equal(await readFile(join(directory, "published-notes.md"), "utf8"),
      await readFile(join(directory, "docs", "releases", "0.1.323.md"), "utf8"));
  });
}

test("发布标签与版本不一致时，在任何 GitHub 写入之前停止", { skip: process.platform === "win32" }, async t => {
  const { calls, error } = await publishFixture(t, { ref: "refs/tags/v0.1.322" });
  assert.equal(error?.code, 1);
  assert.match(error.stderr, /Release tag must match package.json/);
  assert.deepEqual(calls, []);
});
