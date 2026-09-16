import assert from "node:assert/strict";
import test from "node:test";
import { acquireSingleInstance, closeSingleInstance, readSingleInstanceStatus } from "../src/single-instance.mjs";

test("[LCH-03] 单实例状态只读查询不触发接管，区分端口已监听与启动完成", async t => {
  const status = { phase: "starting", revision: 0 };
  let reuse = 0;
  const owner = await acquireSingleInstance({ port: 0, mode: "formal", version: "1.2.3",
    explicitStart: true, getStatus: () => status,
    onTakeover: () => assert.fail("状态查询不得接管"),
    onReuse: () => { reuse++; status.revision++; status.phase = "starting"; },
  });
  t.after(() => closeSingleInstance(owner));
  const port = owner.address().port;
  assert.deepEqual(await readSingleInstanceStatus({port}), {pid:process.pid,mode:"formal",version:"1.2.3",phase:"starting",revision:0});
  status.phase = "ready";
  assert.equal((await readSingleInstanceStatus({port})).phase, "ready");
  assert.equal(reuse, 0);
  assert.equal(await acquireSingleInstance({port, mode:"formal",version:"1.2.3",explicitStart:true}), null);
  for (let i=0; i<20 && !reuse; i++) await new Promise(resolve=>setTimeout(resolve,5));
  const pending = await readSingleInstanceStatus({port});
  assert.equal(pending.revision,1);
  assert.equal(pending.phase,"starting");
  status.phase = "ready";
  assert.equal((await readSingleInstanceStatus({port})).revision,1);
});

test("[LCH-03] 状态客户端连接重置后单实例监听仍可查询且不触发接管", async t => {
  const { createConnection } = await import("node:net");
  let actions = 0;
  const owner = await acquireSingleInstance({ port: 0, getStatus: () => ({phase: "ready"}),
    onTakeover: () => actions++, onReuse: () => actions++ });
  t.after(() => closeSingleInstance(owner));
  const disconnected = new Promise(resolve => owner.once("connection", socket =>
    socket.once("close", resolve)));
  const client = createConnection({ host: "127.0.0.1", port: owner.address().port });
  client.once("connect", () => client.resetAndDestroy());
  await disconnected;
  assert.equal((await readSingleInstanceStatus({port: owner.address().port})).phase, "ready");
  assert.equal(actions, 0);
});
