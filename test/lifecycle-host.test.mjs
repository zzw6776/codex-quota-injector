import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateLifecycleReadiness,
  lifecycleFingerprint,
  parsePidLines,
  publicLifecycleHost,
  readWindowsInstalledVersion,
  relayProtocolFromGeneration,
  selectLifecycleAccountPair,
} from "../src/lifecycle-host.mjs";
import {
  HOST_HEALTH_STATE_VERSION,
  REQUIRED_CODEX_APP_TOOLS,
} from "../src/host-health.mjs";
import { RELAY_PROTOCOL_VERSION } from "../src/relay-contract.mjs";
import {
  checksumForArchive,
  launchdPlist,
  lsofContainsFileIdentity,
  selectInstallRollbackAction,
  waitForTargetHost,
} from "../scripts/lifecycle-macos.mjs";
import {
  assertStableWindowsHost,
  captureWindowsRuntimeConfiguration,
  inspectWindowsSourceRecovery,
  inspectWslLifecyclePrerequisites,
  prepareWindowsHistoryBeforeLaunch,
  requestWindowsRuntimeHistoryRebuild,
  restoreWindowsRuntimeConfiguration,
  safeguardWindowsDesktopHistory,
  selectWindowsRecoveryEntry,
  selectWindowsInstallRollbackAction,
  selectWindowsRuntimeRestoreEntry,
  setWindowsRuntimeConfiguration,
  verifyWindowsInstallation,
  verifyWindowsInstaller,
  waitForWindowsHistoryDurable,
  waitForWindowsInjectorOwnersExit,
  waitForSettledWindowsHost,
  waitForWindowsTargetHost,
  windowsRuntimeConfigurationMatches,
  windowsScheduledTaskScript,
} from "../scripts/lifecycle-windows.mjs";
import { listCodexDesktopProcessIds } from "../src/platform.mjs";
import { open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { useTempDir } from "./helpers.mjs";

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
  assert.equal(evaluateLifecycleReadiness({ ...base, expectedProtocol: null }).ready, true,
    "回滚到未知旧协议时仍可只验证宿主基础就绪");
});

test("[A LCH-03 LCH-04] 接管 app-server 后 codex_app 健康状态是生命周期硬门禁", () => {
  const now = 1_800_000_000_000;
  const generation = `catalog:usage-events-v${RELAY_PROTOCOL_VERSION}:router`;
  const base = {
    relayConfig: { generation, hostToolsRequired: true },
    relayState: { generation, pid: 44, startedAt: now - 1_000 },
    relayPidAlive: true,
    relayStateCurrent: true,
    codexPids: [12],
    injectorPids: [13],
    debugReady: true,
    expectedProtocol: RELAY_PROTOCOL_VERSION,
    now,
  };
  const ready = {
    version: HOST_HEALTH_STATE_VERSION,
    generation,
    pid: 44,
    status: "ready",
    message: "Codex 任务工具已就绪",
    requiredTools: [...REQUIRED_CODEX_APP_TOOLS],
    missingTools: [],
    toolsVerified: true,
  };
  assert.equal(evaluateLifecycleReadiness({ ...base, healthState: ready }).ready, true);
  const degraded = { ...ready, status: "degraded", code: "codex-app-startup-failed" };
  const failed = evaluateLifecycleReadiness({ ...base, healthState: degraded });
  assert.equal(failed.ready, false);
  assert.equal(failed.hostToolsReady, false);
  assert.equal(failed.hostHealth.code, "codex-app-startup-failed");
  assert.equal(evaluateLifecycleReadiness({ ...base, healthState: null }).ready, false);
});

test("[A LCH-05 LCH-06] 中继协议只从独立 generation 段读取，不能被相似文本误判", () => {
  assert.equal(relayProtocolFromGeneration("a:usage-events-v52:b"), 52);
  assert.equal(relayProtocolFromGeneration("a:prefix-usage-events-v52:b"), null);
  assert.equal(relayProtocolFromGeneration("a:usage-events-v52x:b"), null);
  assert.equal(relayProtocolFromGeneration(null), null);
});

test("[platform:windows-native] [A LCH-03] Windows 监听 PID 输出会去重并过滤无效进程", () => {
  assert.deepEqual(parsePidLines("42\r\ninvalid\r\n42\r\n73\r\n-1\r\n"), [42, 73]);
});

test("[platform:windows-native] [A LCH-03] Windows 桌面 PID 探针排除独立轮换的 app-server", async () => {
  let command;
  const pids = await listCodexDesktopProcessIds({
    platform: "win32",
    executable: String.raw`C:\Program Files\WindowsApps\OpenAI.Codex\Codex.exe`,
    execFileImpl: async (_executable, args) => {
      command = args.at(-1);
      return { stdout: "101\r\n102\r\n" };
    },
  });
  assert.deepEqual(pids, [101, 102]);
  assert.match(command, /ChatGPT\.exe/);
  assert.match(command, /Codex\.exe/);
  assert.doesNotMatch(command, /codex-upstream\.exe/);
});

test("[platform:windows-native] [A LCH-06] Windows 已安装版本使用完整卸载注册表路径读取", async () => {
  let invocation;
  const version = await readWindowsInstalledVersion({
    platform: "win32",
    execFileImpl: async (command, args, options) => {
      invocation = { command, args, options };
      return { stdout: "0.1.155\r\n" };
    },
  });
  assert.equal(version, "0.1.155");
  assert.equal(invocation.command, "powershell.exe");
  assert.ok(invocation.args.at(-1).includes(
    String.raw`HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Codex Quota Injector`,
  ));
  assert.equal(await readWindowsInstalledVersion({
    platform: "linux",
    execFileImpl: async () => assert.fail("非 Windows 不应读取注册表"),
  }), null);
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

test("[platform:macos-native] [A HAR-02 LCH-06] macOS launchd 监督器使用参数数组且正确转义路径，不经过页面或 shell", () => {
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

test("[platform:windows-native] [A HAR-02 LCH-06] Windows 监督器由计划任务托管并保留带空格参数", () => {
  const script = windowsScheduledTaskScript({
    taskName: "CodexQuotaInjector-Lifecycle-1",
    nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
    supervisorScript: "C:\\repo path\\scripts\\lifecycle-supervisor.mjs",
    controlPath: "C:\\private path\\control.json",
    workingDirectory: "C:\\repo path",
  });
  assert.match(script, /New-ScheduledTaskAction/);
  assert.match(script, /New-ScheduledTaskPrincipal/);
  assert.match(script, /-LogonType Interactive -RunLevel Limited/);
  assert.match(script, /New-ScheduledTaskTrigger -AtLogOn/);
  assert.match(script, /New-ScheduledTaskSettingsSet -RestartCount 3/);
  assert.match(script, /Start-ScheduledTask/);
  assert.match(script, /"C:\\repo path\\scripts\\lifecycle-supervisor\.mjs" --control "C:\\private path\\control\.json"/);

  const recoveryScript = windowsScheduledTaskScript({
    taskName: "CodexQuotaInjector-Lifecycle-1",
    nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
    supervisorScript: "C:\\repo path\\scripts\\lifecycle-supervisor.mjs",
    controlPath: "C:\\private path\\control.json",
    workingDirectory: "C:\\repo path",
    recovery: true,
  });
  assert.match(recoveryScript, /"C:\\repo path\\scripts\\lifecycle-supervisor\.mjs" --recover --control "C:\\private path\\control\.json"/);
});

test("[platform:windows-native] [A HAR-04 LCH-06] Windows 回滚必须使用调度前记录的启动入口", () => {
  assert.equal(selectWindowsRecoveryEntry({ recoveryEntry: "current-source" }), "current-source");
  assert.equal(selectWindowsRecoveryEntry({ recoveryEntry: "installed-package" }), "installed-package");
  assert.throws(() => selectWindowsRecoveryEntry({}), /拒绝猜测恢复方式/);
  assert.equal(selectWindowsRuntimeRestoreEntry({
    candidateInstalled: true,
    initialEntry: "current-source",
  }), "candidate-package");
  assert.equal(selectWindowsRuntimeRestoreEntry({
    candidateInstalled: false,
    initialEntry: "current-source",
  }), "current-source");
  assert.equal(selectWindowsRuntimeRestoreEntry({
    candidateInstalled: false,
    initialEntry: "installed-package",
  }), "installed-package");
});

test("[platform:windows-native] [A HAR-03 LCH-02] Windows 运行方式恢复保留 Codex 启动期间写入的其他配置", async (t) => {
  const directory = await useTempDir(t, "codex-runtime-switch-");
  const configPath = join(directory, "config.toml");
  const original = "model = \"gpt-5\"\n[desktop]\nrunCodexInWindowsSubsystemForLinux = false # original\n";
  await writeFile(configPath, original);
  const configuration = await captureWindowsRuntimeConfiguration({
    runDirectory: directory,
    configPath,
  });
  assert.equal(configuration.originalRuntime, "windows-native");
  await setWindowsRuntimeConfiguration(configuration, "wsl-native");
  assert.match(await readFile(configPath, "utf8"), /runCodexInWindowsSubsystemForLinux = true/);
  assert.equal(await windowsRuntimeConfigurationMatches(configuration), false);
  const restored = await restoreWindowsRuntimeConfiguration(configuration);
  assert.equal(restored.runtimeTarget, "windows-native");
  assert.equal(await readFile(configPath, "utf8"), original);
  assert.equal(await windowsRuntimeConfigurationMatches(configuration), true);

  await setWindowsRuntimeConfiguration(configuration, "wsl-native");
  await writeFile(configPath, `${await readFile(configPath, "utf8")}# external change\n`);
  const switchedWithExternalChange = await setWindowsRuntimeConfiguration(
    configuration,
    "windows-native",
  );
  assert.equal(switchedWithExternalChange.runtimeTarget, "windows-native");
  assert.match(await readFile(configPath, "utf8"), /# external change/);
  await setWindowsRuntimeConfiguration(configuration, "wsl-native");
  await writeFile(configPath, `${await readFile(configPath, "utf8")}# second external change\n`);
  const merged = await restoreWindowsRuntimeConfiguration(configuration);
  assert.equal(merged.externalChangesPreserved, true);
  assert.equal(
    await readFile(configPath, "utf8"),
    `${original}# external change\n# second external change\n`,
  );
  assert.equal(await windowsRuntimeConfigurationMatches(configuration), true);

  const secondDirectory = await useTempDir(t, "codex-runtime-external-");
  const secondConfigPath = join(secondDirectory, "config.toml");
  await writeFile(secondConfigPath, original);
  const secondConfiguration = await captureWindowsRuntimeConfiguration({
    runDirectory: secondDirectory,
    configPath: secondConfigPath,
  });
  await writeFile(secondConfigPath, `${original}# changed before switch\n`);
  await assert.rejects(
    setWindowsRuntimeConfiguration(secondConfiguration, "wsl-native"),
    /外部修改/,
  );
});

test("[platform:windows-native] [A LCH-03] Windows 首次初始化切换 PID 后达到稳定状态才建立重复启动基线", async () => {
  const first = readyHost({ injectorPid: 101, codexPids: [201], relayPid: 301 });
  const initialized = readyHost({ injectorPid: 101, codexPids: [202], relayPid: 301 });
  const snapshots = [first, initialized, initialized, initialized, initialized];
  const result = await waitForSettledWindowsHost({
    installedApp: "C:\\Program Files\\Codex Quota Injector",
    expectedProtocol: 53,
  }, first, {
    expectedRuntimeTarget: "windows-native",
    inspectHost: async () => snapshots.shift() ?? initialized,
    ownerCheck: async () => true,
    stableDurationMs: 2,
    timeoutMs: 100,
    pollIntervalMs: 1,
  });
  assert.deepEqual(result.codexPids, [202]);
});

test("[platform:windows-native] [A LCH-03] Windows 重复启动只比较桌面主进程，允许 app-server 独立轮换", async () => {
  const baseline = readyHost({ injectorPid: 101, codexPids: [201], relayPid: 301 });
  baseline.appServerPids = [401];
  const rotated = structuredClone(baseline);
  rotated.appServerPids = [402];
  const result = await assertStableWindowsHost({
    installedApp: "C:\\Program Files\\Codex Quota Injector",
    expectedProtocol: 53,
  }, baseline, 2, "windows-native", {
    inspectHost: async () => rotated,
    pollIntervalMs: 1,
  });
  assert.deepEqual(result.appServerPids, [402]);
});

test("[platform:windows-native] [C LCH-05] Windows Codex 关闭后等待旧注入器释放单实例端口再允许重开", async () => {
  const observations = [[101], [101], []];
  const waits = [];
  const result = await waitForWindowsInjectorOwnersExit([101], {
    findPids: async () => observations.shift() ?? [],
    wait: async (ms) => waits.push(ms),
    pollIntervalMs: 78,
    timeoutMs: 5_000,
  });
  assert.deepEqual(result, { status: "exited", previousInjectorPids: [101] });
  assert.deepEqual(waits, [78, 78]);
});

test("[platform:windows-native] [A LCH-02 LCH-03] Windows 生命周期等待目标 Relay 类型，不能继承另一环境结果", async () => {
  const wrong = readyHost({ injectorPid: 101, wslNative: true });
  const expected = readyHost({ injectorPid: 101, wslNative: false });
  const snapshots = [wrong, expected];
  const result = await waitForWindowsTargetHost({
    installedApp: "C:\\Program Files\\Codex Quota Injector",
    expectedProtocol: 53,
  }, {
    expectedRuntimeTarget: "windows-native",
    timeoutMs: 100,
    pollIntervalMs: 0,
    inspectHost: async () => snapshots.shift() ?? expected,
  });
  assert.equal(result.relay.wslNative, false);
});

test("[platform:wsl-native] [A LCH-02] C 批在改配置前确认 WSL 官方 CLI 与进程身份接口可用", async () => {
  let invocation;
  assert.deepEqual(await inspectWslLifecyclePrerequisites({
    platform: "win32",
    execFileImpl: async (command, args, options) => {
      invocation = { command, args, options };
      return { stdout: "ready" };
    },
  }), { status: "ready" });
  assert.equal(invocation.command, "wsl.exe");
  assert.deepEqual(invocation.args.slice(0, 3), ["-e", "sh", "-lc"]);
  assert.match(invocation.args.at(-1), /command -v codex/);
  assert.match(invocation.args.at(-1), /command -v node/);
  assert.match(invocation.args.at(-1), /node:sqlite/);
  assert.match(invocation.args.at(-1), /boot_id/);
  assert.equal((await inspectWslLifecyclePrerequisites({
    platform: "win32",
    execFileImpl: async () => { throw new Error("no distro"); },
  })).status, "blocked");
});

test("[platform:windows-native] [C HAR-04 LCH-04] Windows C 自动备份并重建停滞任务的两套派生投影", async () => {
  const events = [];
  let saved;
  const evidence = await safeguardWindowsDesktopHistory({
    reportPath: "C:\\report\\report.json",
    installedApp: "C:\\Program Files\\Codex Quota Injector",
    expectedProtocol: 55,
    sourceRecoveryMode: "windows-native",
    runtimeConfiguration: { originalRuntime: "windows-native" },
    sessionCheckpoint: { turns: [{
      path: "C:\\Users\\ZZW\\.codex\\sessions\\rollout-01a0966e-380a-7692-a939-0a3beeb054a5.jsonl",
      turnId: "01a09a62-8415-7290-a294-aff2102807d2",
    }] },
  }, {
    waitForDesktopIdle: async () => { events.push("idle"); },
    inspectHistory: async () => {
      events.push("inspect-rollout");
      return {
        activeTurn: null,
        repairRequired: false,
        repairable: false,
        sha256: "source",
        size: 100,
        lastOrdinal: 9,
        sequenceIssues: [],
        conversationRecordCount: 2,
      };
    },
    runStoreRequest: async (runtimeTarget, request) => {
      events.push(`${request.operation}-${runtimeTarget}`);
      if (request.operation === "inspect") {
        return { healthy: false, reason: "projection-behind" };
      }
      return { reset: true, sqliteHome: runtimeTarget, backups: { state: "s", history: "h" } };
    },
    stopInjectorOwners: async () => { events.push("stop-injector"); },
    stopDesktop: async () => { events.push("stop-desktop"); },
    inspectHost: async () => { events.push("inspect-host"); return { codexPids: [] }; },
    updateControl: async (value) => { saved = value; events.push("save"); },
  });
  assert.equal(evidence.status, "repaired-awaiting-rebuild");
  assert.equal(evidence.repairs[0].reason, "projection-behind");
  assert.deepEqual(events, [
    "idle",
    "inspect-rollout",
    "inspect-windows-native",
    "stop-injector",
    "stop-desktop",
    "reset-windows-native",
    "reset-wsl-native",
    "inspect-host",
    "save",
  ]);
  assert.deepEqual(saved.desktopHistory, evidence);
});

test("[platform:windows-native] [C HAR-04 LCH-04] Windows 未知分页异常在停止桌面前保持阻塞", async () => {
  let stopped = false;
  await assert.rejects(safeguardWindowsDesktopHistory({
    reportPath: "C:\\report\\report.json",
    sourceRecoveryMode: "windows-native",
    sessionCheckpoint: { turns: [{
      path: "C:\\sessions\\rollout-01a0966e-380a-7692-a939-0a3beeb054a5.jsonl",
      turnId: "turn",
    }] },
  }, {
    waitForDesktopIdle: async () => undefined,
    inspectHistory: async () => ({
      activeTurn: null,
      repairRequired: false,
      lastOrdinal: 9,
    }),
    runStoreRequest: async () => ({ healthy: false, reason: "rollout-path-mismatch" }),
    stopDesktop: async () => { stopped = true; },
  }), /无法安全自动修复/);
  assert.equal(stopped, false);
});

test("[platform:windows-native] [C LCH-04] Windows C 只在桌面启动前主动恢复落后的投影", async () => {
  const threadId = "01a0966e-380a-7692-a939-0a3beeb054a5";
  const events = [];
  let rebuilt = false;
  const result = await prepareWindowsHistoryBeforeLaunch({
    sessionCheckpoint: { turns: [{
      path: `C:\\sessions\\rollout-${threadId}.jsonl`,
      turnId: "turn-a",
    }] },
  }, "windows-native", {
    timeoutMs: 100,
    pollIntervalMs: 0,
    inspectHistory: async () => ({
      repairRequired: false,
      activeTurn: null,
      lastOrdinal: 9,
    }),
    runStoreRequest: async () => {
      events.push("inspect");
      return rebuilt
        ? {
            healthy: true,
            reason: null,
            thread: { id: threadId, historyMode: "paginated" },
            projection: { nextRolloutOrdinal: 10 },
            rolloutSize: 100,
            turns: [{ turnId: "turn-a", status: "completed" }],
          }
        : { healthy: false, reason: "projection-behind", thread: { id: threadId } };
    },
    requestRebuild: async (_control, runtimeTarget, threadIds) => {
      events.push("resume");
      assert.equal(runtimeTarget, "windows-native");
      assert.deepEqual(threadIds, [threadId]);
      rebuilt = true;
      return { status: "requested", requestedThreadIds: threadIds };
    },
    inspectHost: async () => ({ codexPids: [] }),
    waitForDurable: async (_control, runtimeTarget, options) => {
      const entry = await options.runStoreRequest(runtimeTarget, {});
      events.push("post-start-read-only-gate");
      return {
        status: "durable",
        runtimeTarget,
        rebuild: null,
        threads: [entry],
      };
    },
  });
  assert.deepEqual(events, ["inspect", "resume", "inspect", "post-start-read-only-gate"]);
  assert.equal(result.status, "durable");
  assert.equal(result.rebuild.status, "requested");
});

test("[platform:windows-native] [C LCH-04] Windows 桌面运行时拒绝启动第二个 app-server 重建历史", async () => {
  const threadId = "01a0966e-380a-7692-a939-0a3beeb054a5";
  let attempts = 0;
  await assert.rejects(prepareWindowsHistoryBeforeLaunch({
    sessionCheckpoint: { turns: [{
      path: `C:\\sessions\\rollout-${threadId}.jsonl`,
      turnId: "turn-a",
    }] },
  }, "wsl-native", {
    inspectHistory: async () => ({ repairRequired: false, activeTurn: null, lastOrdinal: 9 }),
    runStoreRequest: async () => ({
      healthy: false,
      reason: "projection-behind",
      thread: { id: threadId },
    }),
    requestRebuild: async () => {
      attempts += 1;
      return { status: "requested" };
    },
    inspectHost: async () => ({ codexPids: [123], appServerPids: [] }),
  }), /拒绝并发启动历史重建 app-server/);
  assert.equal(attempts, 0);
});

test("[platform:windows-native] [C LCH-04] Windows 桌面已退出但旧 app-server 残留时也拒绝历史重建", async () => {
  const threadId = "01a0966e-380a-7692-a939-0a3beeb054a5";
  let attempts = 0;
  await assert.rejects(prepareWindowsHistoryBeforeLaunch({
    sessionCheckpoint: { turns: [{
      path: `C:\\sessions\\rollout-${threadId}.jsonl`,
      turnId: "turn-a",
    }] },
  }, "windows-native", {
    inspectHistory: async () => ({ repairRequired: false, activeTurn: null, lastOrdinal: 9 }),
    runStoreRequest: async () => ({
      healthy: false,
      reason: "projection-behind",
      thread: { id: threadId },
    }),
    requestRebuild: async () => {
      attempts += 1;
      return { status: "requested" };
    },
    inspectHost: async () => ({ codexPids: [], appServerPids: [456] }),
  }), /Codex 桌面或 app-server 仍在运行/);
  assert.equal(attempts, 0);
});

test("[platform:windows-native] [C LCH-04] Windows 桌面启动后的历史门禁只读等待且不主动重建", async () => {
  const threadId = "01a0966e-380a-7692-a939-0a3beeb054a5";
  let inspections = 0;
  const result = await waitForWindowsHistoryDurable({
    sessionCheckpoint: { turns: [{
      path: `C:\\sessions\\rollout-${threadId}.jsonl`,
      turnId: "turn-a",
    }] },
  }, "wsl-native", {
    timeoutMs: 100,
    pollIntervalMs: 0,
    inspectHistory: async () => ({ repairRequired: false, activeTurn: null, lastOrdinal: 9 }),
    runStoreRequest: async () => ++inspections === 1
      ? { healthy: false, reason: "projection-behind", thread: { id: threadId } }
      : {
          healthy: true,
          thread: { id: threadId, historyMode: "paginated" },
          projection: { nextRolloutOrdinal: 10 },
          rolloutSize: 100,
          turns: [{ turnId: "turn-a", status: "completed" }],
        },
  });
  assert.equal(inspections, 2);
  assert.equal(result.status, "durable");
  assert.equal(result.rebuild, null);
});

test("[platform:windows-native] [C LCH-04] Windows 历史恢复使用正式 Relay 和独立状态文件", async (t) => {
  const directory = await useTempDir(t, "codex-windows-history-rebuild-");
  const dataDir = join(directory, "data");
  const reportPath = join(directory, "run", "report.json");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(dataDir));
  await writeFile(join(dataDir, "app-server-relay-config.json"), JSON.stringify({
    upstreamExecutable: "C:\\official\\codex.exe",
    relayStatePath: "C:\\production\\relay-state.json",
    tokenUsageEventsPath: "C:\\production\\usage.jsonl",
    generation: "catalog:usage-events-v55",
  }));
  let invocation;
  const result = await requestWindowsRuntimeHistoryRebuild({
    reportPath,
    dataDir,
    installedApp: "C:\\Program Files\\Codex Quota Injector",
    projectVersion: "0.1.211",
    codexHome: "C:\\Users\\tester\\.codex",
  }, "windows-native", ["thread-a"], {
    requestHistory: async (options) => {
      invocation = options;
      return { status: "requested", requestedThreadIds: options.threadIds };
    },
  });
  assert.equal(
    invocation.command.replaceAll("/", "\\"),
    "C:\\Program Files\\Codex Quota Injector\\relay\\codex-quota-relay-windows-0.1.211.exe",
  );
  assert.deepEqual(invocation.args, ["app-server", "--listen", "stdio://"]);
  assert.equal(invocation.env.CODEX_HOME, "C:\\Users\\tester\\.codex");
  assert.equal(invocation.env.CODEX_SQLITE_HOME, "C:\\Users\\tester\\.codex");
  const isolatedConfig = JSON.parse(await readFile(invocation.env.CODEX_QUOTA_RELAY_CONFIG, "utf8"));
  assert.notEqual(isolatedConfig.relayStatePath, "C:\\production\\relay-state.json");
  assert.notEqual(isolatedConfig.tokenUsageEventsPath, "C:\\production\\usage.jsonl");
  assert.equal(result.method, "thread/resume");
  assert.equal(result.relayRuntime, "windows-native");
});

test("[platform:windows-native][platform:wsl-native] [A LCH-06] Windows/WSL 首次安装的源码恢复入口必须是当前运行环境的有效原生产物", async () => {
  const checked = [];
  const validators = {
    assertWindowsExecutable: async (path) => { checked.push(["windows", path]); },
    assertWslExecutable: async (path) => { checked.push(["wsl", path]); },
  };
  assert.deepEqual(await inspectWindowsSourceRecovery({
    installationState: "empty",
    currentRuntime: "windows-native",
    sourceRecoveryRelay: "C:\\relay.exe",
    ...validators,
  }), { status: "ready", reason: null });
  assert.deepEqual(await inspectWindowsSourceRecovery({
    installationState: "empty",
    currentRuntime: "wsl-native",
    sourceRecoveryRelay: "C:\\relay-wsl",
    ...validators,
  }), { status: "ready", reason: null });
  assert.deepEqual(checked, [
    ["windows", "C:\\relay.exe"],
    ["wsl", "C:\\relay-wsl"],
  ]);
  const blocked = await inspectWindowsSourceRecovery({
    installationState: "empty",
    currentRuntime: "windows-native",
    sourceRecoveryRelay: "missing.exe",
    assertWindowsExecutable: async () => { throw new Error("invalid PE"); },
  });
  assert.equal(blocked.status, "blocked-invalid-or-missing-native-relay");
  assert.match(blocked.reason, /invalid PE/);
  assert.deepEqual(await inspectWindowsSourceRecovery({
    installationState: "versioned",
    currentRuntime: "windows-native",
    sourceRecoveryRelay: "unused.exe",
    assertWindowsExecutable: async () => assert.fail("已有安装时不依赖源码入口"),
  }), { status: "ready", reason: null });
});

test("[platform:windows-native] [A LCH-06] Windows Setup 和安装目录必须与同一个版本化中继集合对应", async (t) => {
  const directory = await useTempDir(t, "codex-windows-lifecycle-");
  const installer = join(directory, "Codex-Quota-Injector-1.2.3-windows-x64-Setup.exe");
  const file = await open(installer, "w");
  await file.truncate(10 * 1024 * 1024);
  await file.write(Buffer.from("MZ"), 0, 2, 0);
  await file.close();
  const candidate = await verifyWindowsInstaller(installer, { projectVersion: "1.2.3" });
  assert.equal(candidate.version, "1.2.3");
  assert.equal(candidate.installerSha256.length, 64);
  await assert.rejects(
    verifyWindowsInstaller(installer, { projectVersion: "1.2.4" }),
    /文件名与项目版本不匹配/,
  );

  const checked = [];
  const hashed = [];
  const installDir = join("C:\\", "Installed App");
  const installation = await verifyWindowsInstallation(installDir, {
    projectVersion: "1.2.3",
    assertWindowsExecutable: async (path) => { checked.push(["windows", path]); },
    assertWslExecutable: async (path) => { checked.push(["wsl", path]); },
    readVersion: async () => "1.2.3",
    hashFile: async (path) => {
      hashed.push(path);
      return `hash:${path}`;
    },
  });
  assert.deepEqual(checked, [
    ["windows", join(installDir, "Codex Quota Injector.exe")],
    ["windows", join(installDir, "relay", "codex-quota-relay-windows-1.2.3.exe")],
    ["wsl", join(installDir, "relay", "codex-quota-relay-wsl-1.2.3")],
  ]);
  assert.equal(hashed.length, 3);
  assert.equal(installation.installedVersion, "1.2.3");
  await assert.rejects(
    verifyWindowsInstallation(installDir, {
      projectVersion: "1.2.3",
      assertWindowsExecutable: async () => undefined,
      assertWslExecutable: async () => undefined,
      readVersion: async () => "1.2.4",
      hashFile: async () => "unused",
    }),
    /期望 1\.2\.3，实际 1\.2\.4/,
  );
});

test("[platform:macos-native] [A LCH-06] macOS 正式包 Node 运行时只接受清单中与归档名精确对应的 SHA-256", () => {
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

test("[platform:macos-native] [A LCH-03 LCH-04] macOS 已就绪的旧监听者不能让正式包接管检查提前成功", async () => {
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

test("[platform:macos-native] [A LCH-03 LCH-04] macOS 接管超时必须明确报告目标进程归属未满足", async () => {
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

test("[platform:macos-native] [A LCH-03 LCH-06] macOS 安装路径被替换后必须按文件实体识别 Worker", () => {
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

test("[platform:macos-native] [A LCH-06 HAR-04] macOS 安装未改写目标包时回滚保留原包，未知状态先报错再停止进程", () => {
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

test("[platform:windows-native] [A LCH-06 HAR-04] Windows 回滚按安装前状态恢复旧包、移除新增包或拒绝未知状态", () => {
  assert.equal(selectWindowsInstallRollbackAction({
    backupExists: true,
    initialInstalledPresent: true,
    initialInstalledVersion: "0.1.202",
    projectVersion: "0.1.203",
    installedCandidate: false,
  }), "restore-backup");
  assert.equal(selectWindowsInstallRollbackAction({
    backupExists: false,
    initialInstalledPresent: false,
    initialInstalledVersion: null,
    projectVersion: "0.1.203",
    installedCandidate: true,
  }), "remove-installed");
  assert.equal(selectWindowsInstallRollbackAction({
    backupExists: false,
    initialInstalledPresent: true,
    initialInstalledVersion: "0.1.203",
    projectVersion: "0.1.203",
    installedCandidate: true,
  }), "leave-installed");
  assert.equal(selectWindowsInstallRollbackAction({
    backupExists: false,
    initialInstalledPresent: true,
    initialInstalledVersion: "0.1.202",
    projectVersion: "0.1.203",
    installedCandidate: false,
    installStarted: false,
  }), "leave-original");
  assert.throws(() => selectWindowsInstallRollbackAction({
    backupExists: false,
    initialInstalledPresent: true,
    initialInstalledVersion: "0.1.202",
    projectVersion: "0.1.203",
    installedCandidate: true,
  }), /备份不存在/);
});

function readyHost({ injectorPid, wslNative = false, codexPids = [10], relayPid = 30 }) {
  return {
    codexPids,
    injectorPids: [injectorPid],
    relay: { pid: relayPid, wslNative },
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
