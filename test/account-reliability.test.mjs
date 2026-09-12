import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { AccountStore } from "../src/account-store.mjs";
import { useTempDir } from "./helpers.mjs";

async function setup(t) {
  const directory = await useTempDir(t);
  const options = { dataDir: directory, cockpitDir: join(directory, "empty-legacy") };
  const store = new AccountStore(options);
  await store.initialize();
  await store.upsert({ id: "existing", email: "existing@example.invalid", tokens: { accessToken: "fixture-old" }, tokenGeneration: 1 });
  return { directory, options, store };
}

test("[A ACC-03 ACC-06] 并发账号更新从最新持久状态累加，重载后不丢更新", async t => {
  const { options, store } = await setup(t);
  await Promise.all(Array.from({ length: 20 }, () => store.update("existing", previous => ({ tokenGeneration: previous.tokenGeneration + 1 }))));
  assert.equal(store.get("existing").tokenGeneration, 21);
  const restored = new AccountStore(options);
  await restored.initialize();
  assert.equal(restored.get("existing").tokenGeneration, 21);
});

test("[A ACC-06] 账号密文或索引写失败时不留下内存假账号、半保存凭据或临时文件", async t => {
  for (const target of ["account", "index"]) await t.test(target, async t => {
    const { directory, options, store } = await setup(t);
    const path = target === "index" ? store.indexPath : join(store.accountsDir, "new.json");
    if (target === "index") await rename(path, `${path}.backup`);
    await mkdir(path);
    await assert.rejects(store.upsert({ id: "new", tokens: { accessToken: "must-not-survive" } }));
    assert.equal(store.get("new"), null);
    assert.deepEqual(store.index.accounts.map(i => i.id), ["existing"]);
    assert.ok(!(await readdir(directory)).some(name => name.includes(".tmp.")));
    assert.ok(!(await readdir(store.accountsDir)).some(name => name.includes(".tmp.")));
    await rm(path, { recursive: true });
    if (target === "index") await rename(`${path}.backup`, path);
    const restored = new AccountStore(options);
    await restored.initialize();
    assert.equal(restored.get("new"), null);
    assert.equal(restored.get("existing").tokens.accessToken, "fixture-old");
    await store.update("existing", { tokens: { accessToken: "fixture-recovered" } });
    assert.equal(store.get("existing").tokens.accessToken, "fixture-recovered");
  });
});

test("[A ACC-06] 损坏、未来版本与不可解密的已有账号数据明确报错且原文不被覆盖", async t => {
  for (const kind of ["broken-index", "future-index", "broken-account", "future-account"]) await t.test(kind, async t => {
    const { options, store } = await setup(t);
    const path = kind.endsWith("index") ? store.indexPath : join(store.accountsDir, "existing.json");
    const original = await readFile(path, "utf8");
    const damaged = kind.startsWith("future") ? JSON.stringify({ ...JSON.parse(original), version: 999 }) : "{broken data";
    await writeFile(path, damaged);
    await assert.rejects(new AccountStore(options).initialize(), /保护|版本|损坏|读取/);
    assert.equal(await readFile(path, "utf8"), damaged);
    await writeFile(path, original);
    const restored = new AccountStore(options);
    await restored.initialize();
    assert.equal(restored.get("existing").tokens.accessToken, "fixture-old");
  });
});
