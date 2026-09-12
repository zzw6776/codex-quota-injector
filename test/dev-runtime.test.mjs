import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { readDevRuntimeIdentity } from "../src/dev-runtime.mjs";
import { acquireSingleInstance, closeSingleInstance } from "../src/single-instance.mjs";
import { useTempDir } from "./helpers.mjs";

async function writeManifest(root, version, ws = "8.21.3") {
  await writeFile(join(root, "package.json"), JSON.stringify({ version, dependencies: { ws } }));
  await writeFile(join(root, "package-lock.json"), JSON.stringify({ version, packages: { "": { version, dependencies: { ws } } } }));
}

test("开发版指纹允许页面与发布版本更新，后端、依赖或来源变化必须重新加载进程", async (t) => {
  const root = await useTempDir(t);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "widget.mjs"), "widget-v1");
  await writeFile(join(root, "src", "model-router.mjs"), "router-v1");
  await writeManifest(root, "1.0.0");
  const original = await readDevRuntimeIdentity(root);
  await writeFile(join(root, "src", "widget.mjs"), "widget-v2");
  await writeManifest(root, "1.0.1");
  assert.equal(await readDevRuntimeIdentity(root), original);
  await writeFile(join(root, "src", "model-router.mjs"), "router-v2");
  assert.notEqual(await readDevRuntimeIdentity(root), original);
  await writeFile(join(root, "src", "model-router.mjs"), "router-v1");
  await writeManifest(root, "1.0.1", "8.22.0");
  assert.notEqual(await readDevRuntimeIdentity(root), original);
  await writeManifest(root, "1.0.1");
  const other = await useTempDir(t);
  await mkdir(join(other, "src"));
  await writeFile(join(other, "src", "model-router.mjs"), "router-v1");
  await writeManifest(other, "1.0.1");
  assert.notEqual(await readDevRuntimeIdentity(other), original);
});

test("开发版仅页面更新保留单实例进程，页面更新失败也不触发接管", async (t) => {
  const runtimeIdentity = "a".repeat(64);
  const reloads = [];
  let takeovers = 0;
  const owner = await acquireSingleInstance({
    port: 0, mode: "dev", version: "1.0.0", explicitStart: true, runtimeIdentity,
    onTakeover: () => { takeovers++; },
    onReload: (request) => {
      reloads.push(request.version);
      if (request.version === "1.0.2") throw new Error("synthetic widget import failure");
    },
  });
  t.after(() => closeSingleInstance(owner));
  const port = owner.address().port;
  for (const version of ["1.0.1", "1.0.2", "1.0.3"]) {
    assert.equal(await acquireSingleInstance({ port, mode: "dev", version, explicitStart: true, runtimeIdentity }), null);
    assert.equal(owner.listening, true);
    assert.equal(takeovers, 0);
  }
  assert.deepEqual(reloads, ["1.0.1", "1.0.2", "1.0.3"]);
  // An older launcher must not reload an older UI over the upgraded owner.
  assert.equal(await acquireSingleInstance({ port, mode: "dev", version: "1.0.0", explicitStart: true, runtimeIdentity }), null);
  assert.equal(reloads.length, 3);
  assert.equal(await acquireSingleInstance({ port, mode: "dev", version: "1.0.4", explicitStart: false, runtimeIdentity }), null);
  assert.equal(reloads.length, 3);
});

test("开发版后端变化不能被发布版本或页面热更新掩盖", async (t) => {
  let reloads = 0;
  const owner = await acquireSingleInstance({
    port: 0, mode: "dev", version: "1.0.0", explicitStart: true, runtimeIdentity: "a".repeat(64),
    onReload: () => { reloads++; },
    onTakeover: () => closeSingleInstance(owner),
  });
  t.after(() => closeSingleInstance(owner));
  const replacement = await acquireSingleInstance({
    port: owner.address().port, mode: "dev", version: "1.0.1", explicitStart: true,
    runtimeIdentity: "b".repeat(64),
  });
  t.after(() => closeSingleInstance(replacement));
  assert.equal(replacement.listening, true);
  assert.equal(reloads, 0);
});
