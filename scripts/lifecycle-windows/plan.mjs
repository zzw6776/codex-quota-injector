import { join } from "node:path";
import process from "node:process";
import { DEFAULT_WINDOWS_INSTALL_DIR, inspectLifecycleHost, publicLifecycleHost } from "../../src/lifecycle-host.mjs";
import { codexRunsInWindowsSubsystemForLinux } from "../../src/platform.mjs";
import { WINDOWS_NATIVE, WSL_NATIVE } from "../test-runtime-targets.mjs";
import { execFileAsync } from "./io.mjs";

async function createWindowsLifecyclePlan({
  root,
  projectVersion,
  expectedProtocol,
  installedApp = DEFAULT_WINDOWS_INSTALL_DIR,
  installerPath = null,
} = {}) {
  const host = await inspectLifecycleHost({ installedApp, expectedProtocol });
  const wslMode = await codexRunsInWindowsSubsystemForLinux();
  const currentRuntime = wslMode ? WSL_NATIVE : WINDOWS_NATIVE;
  const wslRuntime = await inspectWslLifecyclePrerequisites();
  return {
    batch: "lifecycle-official",
    name: "启停恢复测试 - Codex 官方模型",
    mode: "windows-task-scheduler-supervisor",
    platform: process.platform,
    arch: process.arch,
    projectVersion,
    expectedRelayProtocol: expectedProtocol,
    installerPath,
    currentRuntime,
    runtimeTargets: [WINDOWS_NATIVE, WSL_NATIVE],
    automaticRuntimeSwitch: true,
    manualRuntimeSwitchRequired: false,
    wslRuntime,
    tokenRequests: host.accounts.roundTripAvailable ? 1 : 0,
    actions: [
      "验证 Windows Setup 与版本化原生/WSL 中继",
      "等待所有 Codex 活动回合完成落盘后再执行可能中断桌面的操作",
      "由当前版本 Setup 直接安装并验证候选包",
      "自动切换并验证 Windows 原生 Relay 的接管、单实例、重连和关闭重开",
      "自动切换并验证 WSL 原生 Relay 的接管、单实例、重连和关闭重开",
      "恢复测试前的 Codex 运行方式并核对正式入口",
      "真实账号切换、一次最低价官方模型冒烟、回切原账号",
    ],
    host: publicLifecycleHost(host),
    accountRoundTrip: host.accounts.roundTripAvailable
      ? "ready"
      : "blocked-less-than-two-oauth-accounts",
    controller: "Windows Task Scheduler one-shot task",
    progress: "default browser local progress page",
    reportDirectory: join(root, ".runtime", "test-results", "lifecycle"),
  };
}

async function inspectWslLifecyclePrerequisites({
  platform = process.platform,
  execFileImpl = execFileAsync,
} = {}) {
  if (platform !== "win32") {
    return { status: "not-applicable", reason: "仅 Windows 支持 WSL 生命周期" };
  }
  try {
    const { stdout } = await execFileImpl("wsl.exe", [
      "-e", "sh", "-lc",
      "set -eu; command -v codex >/dev/null; command -v node >/dev/null; " +
        "node -e \"import('node:sqlite')\" >/dev/null 2>&1; " +
        "test -r /proc/sys/kernel/random/boot_id; printf ready",
    ], { windowsHide: true, encoding: "utf8", timeout: 10_000 });
    if (String(stdout).trim() !== "ready") throw new Error("WSL 就绪探针没有返回 ready");
    return { status: "ready" };
  } catch (error) {
    return { status: "blocked", reason: `WSL 原生 Codex 环境不可用：${error.message}` };
  }
}

export { createWindowsLifecyclePlan, inspectWslLifecyclePrerequisites };
