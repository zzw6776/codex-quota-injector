import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateLifecycleReadiness,
  lifecycleFingerprint,
  publicLifecycleHost,
  relayProtocolFromGeneration,
  selectLifecycleAccountPair,
} from "../src/lifecycle-host.mjs";
import {
  checksumForArchive,
  launchdPlist,
  lsofContainsFileIdentity,
  selectInstallRollbackAction,
  waitForTargetHost,
} from "../scripts/lifecycle-macos.mjs";

test("[A LCH-01 LCH-03] 生命周期就绪必须同时满足 Codex、单实例、同代中继和目标协议", () => {
  const base = {
    relayConfig: { generation: "catalog:usage-events-v52:router" },
    relayState: { generation: "catalog:usage-events-v52:router", pid: 44 },
    relayPidAlive: true,
    relayStateCurrent: true,
    codexPids: [12],
    injectorPids: [13],
    debugReady: true,
    expectedProtocol: 52,
  };
  assert.equal(evaluateLifecycleReadiness(base).ready, true);
  assert.equal(evaluateLifecycleReadiness({ ...base, codexPids: [] }).ready, false);
  assert.equal(evaluateLifecycleReadiness({ ...base, injectorPids: [13, 14] }).ready, false);
  assert.equal(evaluateLifecycleReadiness({ ...base, relayPidAlive: false }).ready, false);
  assert.equal(evaluateLifecycleReadiness({ ...base, relayStateCurrent: false }).ready, false);
  assert.equal(evaluateLifecycleReadiness({ ...base, debugReady: false }).ready, false);
  assert.equal(evaluateLifecycleReadiness({
    ...base,
    relayState: { ...base.relayState, generation: "older" },
  }).ready, false);
  assert.equal(evaluateLifecycleReadiness({ ...base, expectedProtocol: 53 }).ready, false);
});

test("[A LCH-05 LCH-06] 中继协议只从独立 generation 段读取，不能被相似文本误判", () => {
  assert.equal(relayProtocolFromGeneration("a:usage-events-v52:b"), 52);
  assert.equal(relayProtocolFromGeneration("a:prefix-usage-events-v52:b"), null);
  assert.equal(relayProtocolFromGeneration("a:usage-events-v52x:b"), null);
  assert.equal(relayProtocolFromGeneration(null), null);
});

test("[A ACC-04] 账号往返只选择当前 OAuth 与另一个 OAuth，公开材料只保留不可逆指纹", () => {
  const pair = selectLifecycleAccountPair({ currentAccountId: "account-a", accounts: [
    { id: "account-a", authMode: "oauth" },
    { id: "api-key", authMode: "apiKey" },
    { id: "account-b", authMode: "oauth" },
  ] });
  assert.deepEqual(pair, {
    currentAccountId: "account-a",
    targetAccountId: "account-b",
    available: true,
  });
  assert.equal(lifecycleFingerprint("account-a").length, 12);
  const published = publicLifecycleHost({
    privateAccountPair: pair,
    paths: { accountIndexPath: "/private/accounts.json" },
    accounts: { current: lifecycleFingerprint(pair.currentAccountId) },
  });
  assert.ok(!JSON.stringify(published).includes("account-a"));
  assert.ok(!JSON.stringify(published).includes("/private/accounts.json"));
  assert.equal(selectLifecycleAccountPair({ currentAccountId: "api-key", accounts: [
    { id: "api-key", authMode: "apiKey" },
    { id: "account-b", authMode: "oauth" },
  ] }).available, false);
});

test("[A HAR-02 LCH-06] launchd 监督器使用参数数组且正确转义路径，不经过页面或 shell", () => {
  const plist = launchdPlist({
    label: "com.example.lifecycle",
    nodeExecutable: "/path with space/node",
    supervisorScript: "/repo/a&b/supervisor.mjs",
    controlPath: "/private/<run>/control.json",
    workingDirectory: "/repo/a&b",
    stdoutPath: "/tmp/out.log",
    stderrPath: "/tmp/err.log",
  });
  assert.match(plist, /<key>ProgramArguments<\/key><array>/);
  assert.match(plist, /<string>\/path with space\/node<\/string>/);
  assert.match(plist, /a&amp;b\/supervisor\.mjs/);
  assert.match(plist, /\/private\/&lt;run&gt;\/control\.json/);
  assert.doesNotMatch(plist, /<key>Program<\/key>/);
  assert.doesNotMatch(plist, /sh -c/);
});

test("[A LCH-06] 正式包 Node 运行时只接受清单中与归档名精确对应的 SHA-256", () => {
  const checksum = "a".repeat(64);
  assert.equal(checksumForArchive(
    `${"b".repeat(64)}  node-other.tar.gz\n${checksum}  node-v22.23.1-darwin-arm64.tar.gz\n`,
    "node-v22.23.1-darwin-arm64.tar.gz",
  ), checksum);
  assert.throws(() => checksumForArchive(
    `${checksum}  prefix-node-v22.23.1-darwin-arm64.tar.gz\n`,
    "node-v22.23.1-darwin-arm64.tar.gz",
  ), /校验清单中缺少/);
  assert.throws(() => checksumForArchive(
    `invalid  node-v22.23.1-darwin-arm64.tar.gz\n`,
    "node-v22.23.1-darwin-arm64.tar.gz",
  ), /校验清单中缺少/);
});

test("[A LCH-03 LCH-04] 已就绪的旧监听者不能让正式包接管检查提前成功", async () => {
  const oldSource = readyHost({ injectorPid: 101 });
  const installedPackage = readyHost({ injectorPid: 202 });
  const snapshots = [oldSource, installedPackage];
  let inspections = 0;
  const result = await waitForTargetHost({
    installedApp: "/Applications/Codex Quota Injector.app",
    expectedProtocol: 53,
  }, {
    timeoutMs: 100,
    pollIntervalMs: 0,
    inspectHost: async () => {
      inspections += 1;
      return snapshots.shift() ?? installedPackage;
    },
    previousInjectorPids: [101],
    ownerCheck: async () => true,
    ownerFailure: "installed-package-owner",
  });

  assert.equal(inspections, 2);
  assert.deepEqual(result.injectorPids, [202]);
});

test("[A LCH-03 LCH-04] 接管超时必须明确报告目标进程归属未满足", async () => {
  const oldSource = readyHost({ injectorPid: 101 });
  await assert.rejects(waitForTargetHost({
    installedApp: "/Applications/Codex Quota Injector.app",
    expectedProtocol: 53,
  }, {
    timeoutMs: 20,
    pollIntervalMs: 1,
    inspectHost: async () => oldSource,
    ownerCheck: async () => false,
    ownerFailure: "installed-package-owner",
  }), /installed-package-owner/);
});

test("[A LCH-03 LCH-06] 安装路径被替换后必须按文件实体识别 Worker", () => {
  const reusedPath = [
    "p123",
    "ftxt",
    "D0x1000012",
    "i41",
    "n/Applications/Codex Quota Injector.app/Contents/Resources/Codex Quota Injector Worker",
  ].join("\n");
  assert.equal(lsofContainsFileIdentity(reusedPath, {
    device: 0x1000012n,
    inode: 42n,
  }), false);
  assert.equal(lsofContainsFileIdentity(reusedPath, {
    device: 0x1000012n,
    inode: 41n,
  }), true);
});

test("[A LCH-06 HAR-04] 安装未改写目标包时回滚保留原包，未知状态先报错再停止进程", () => {
  assert.equal(selectInstallRollbackAction({
    backupExists: false,
    initialInstalledVersion: "0.1.203",
    projectVersion: "0.1.203",
    installedCandidate: true,
  }), "leave-installed");
  assert.equal(selectInstallRollbackAction({
    backupExists: true,
    initialInstalledVersion: "0.1.202",
    projectVersion: "0.1.203",
    installedCandidate: false,
  }), "restore-backup");
  assert.throws(() => selectInstallRollbackAction({
    backupExists: false,
    initialInstalledVersion: "0.1.202",
    projectVersion: "0.1.203",
    installedCandidate: true,
  }), /备份不存在/);
});

function readyHost({ injectorPid }) {
  return {
    codexPids: [10],
    injectorPids: [injectorPid],
    relay: { pid: 30 },
    readiness: {
      ready: true,
      codexRunning: true,
      debugReady: true,
      singleInjector: true,
      relayReady: true,
      generationMatches: true,
      protocol: 53,
      expectedProtocol: 53,
    },
  };
}
