import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import packageJson from "../package.json" with { type: "json" };
import { codexRunsInWindowsSubsystemForLinux, defaultAccountDataDir } from "../src/platform.mjs";

const execFileAsync = promisify(execFile);

export const COMMON_COMPONENT = "A-common";
export const MACOS_NATIVE = "macos-native";
export const WINDOWS_NATIVE = "windows-native";
export const WSL_NATIVE = "wsl-native";
export const RUNTIME_TARGETS = new Set([MACOS_NATIVE, WINDOWS_NATIVE, WSL_NATIVE]);

export function runtimeTargetsForPlatform(platform = process.platform) {
  if (platform === "darwin") return [MACOS_NATIVE];
  if (platform === "win32") return [WINDOWS_NATIVE, WSL_NATIVE];
  return [];
}

export function runtimeComponentId(runtimeTarget) {
  if (!RUNTIME_TARGETS.has(runtimeTarget)) throw new Error(`未知测试运行环境 ${runtimeTarget}`);
  return `A-${runtimeTarget}-relay`;
}

export function runtimeTargetLabel(runtimeTarget) {
  return new Map([
    [MACOS_NATIVE, "macOS 原生 Relay"],
    [WINDOWS_NATIVE, "Windows 原生 Relay"],
    [WSL_NATIVE, "WSL 原生 Relay"],
  ]).get(runtimeTarget) ?? runtimeTarget;
}

export async function currentRuntimeTarget({
  platform = process.platform,
  windowsWslEnabled,
} = {}) {
  if (platform === "darwin") return MACOS_NATIVE;
  if (platform === "win32") {
    const enabled = windowsWslEnabled ?? await codexRunsInWindowsSubsystemForLinux();
    return enabled ? WSL_NATIVE : WINDOWS_NATIVE;
  }
  throw new Error(`当前平台 ${platform}/${process.arch} 没有完整测试运行环境`);
}

export function resolveRuntimeSelection(requested, {
  platform = process.platform,
  currentTarget,
  allowAll = true,
} = {}) {
  const supported = runtimeTargetsForPlatform(platform);
  if (!supported.length) throw new Error(`当前平台 ${platform}/${process.arch} 没有完整测试运行环境`);
  const value = String(requested ?? (allowAll ? "all" : "current")).trim();
  if (value === "all") {
    if (!allowAll) throw new Error("该批次一次只能选择一个运行环境");
    return supported;
  }
  if (value === "current") {
    if (!currentTarget || !supported.includes(currentTarget)) {
      throw new Error("无法确定当前 Codex 运行环境");
    }
    return [currentTarget];
  }
  if (!RUNTIME_TARGETS.has(value) || !supported.includes(value)) {
    throw new Error(`运行环境 ${value} 不属于当前平台；可用：${supported.join("、")}`);
  }
  return [value];
}

export function summarizeRuntimeComponents(components, {
  currentTarget,
  supportedTargets,
} = {}) {
  const byId = new Map((components ?? []).map((component) => [component.id, component]));
  const common = byId.get(COMMON_COMPONENT)?.status ?? "not-run";
  const current = combineStatuses([
    common,
    byId.get(runtimeComponentId(currentTarget))?.status ?? "not-run",
  ]);
  const allSupported = combineStatuses([
    common,
    ...(supportedTargets ?? []).map((target) =>
      byId.get(runtimeComponentId(target))?.status ?? "not-run"),
  ]);
  return {
    currentRuntime: currentTarget,
    currentRuntimeStatus: current,
    allSupportedStatus: allSupported,
  };
}

export function summarizeSelectedRuntimeComponents(components, selectedTargets) {
  const byId = new Map((components ?? []).map((component) => [component.id, component]));
  return combineStatuses([
    byId.get(COMMON_COMPONENT)?.status ?? "not-run",
    ...(selectedTargets ?? []).map((target) =>
      byId.get(runtimeComponentId(target))?.status ?? "not-run"),
  ]);
}

export function combineStatuses(statuses) {
  const values = [...statuses];
  if (values.includes("failed")) return "failed";
  if (values.includes("blocked")) return "blocked";
  if (values.some((status) => status !== "passed")) return "incomplete";
  return "passed";
}

export function summarizeFinalStageEvents(events) {
  const finalByStage = new Map();
  for (const event of events ?? []) {
    if (event.type !== "test:summary") continue;
    const key = `${event.component ?? "unknown"}\0${event.stage ?? "unknown"}`;
    finalByStage.set(key, event);
  }
  const counts = {};
  let duration_ms = 0;
  for (const summary of finalByStage.values()) {
    for (const [name, value] of Object.entries(summary.counts ?? {})) {
      counts[name] = (counts[name] ?? 0) + value;
    }
    duration_ms += summary.duration_ms ?? 0;
  }
  return { counts, duration_ms };
}

export async function prepareWindowsNativeRelay({
  root,
  version = packageJson.version,
  nodeExecutable = process.execPath,
} = {}) {
  if (process.platform !== "win32") {
    throw new Error("Windows 原生 Relay 只能在 Windows 中准备");
  }
  const directory = join(root, ".runtime", "test-artifacts");
  const relayPath = join(directory, `codex-quota-relay-windows-${version}.exe`);
  await mkdir(directory, { recursive: true });
  const child = spawn(nodeExecutable, [
    join(root, "scripts", "build-windows-relay.mjs"),
    "--node", nodeExecutable,
    "--output", relayPath,
  ], { cwd: root, stdio: "inherit", windowsHide: true });
  const code = await childExit(child);
  if (code !== 0) throw new Error(`Windows 原生 Relay 构建失败，退出码 ${code}`);
  return {
    path: relayPath,
    sha256: await hashFile(relayPath),
    kind: "windows-pe-sea",
  };
}

export async function runWslTestSuite({
  root,
  resultDirectory,
  stages,
  sourceSha256,
  kind,
  liveProfile = null,
  expectedCliSha256 = null,
  expectedRelaySha256 = null,
  existingRelayPath = null,
} = {}) {
  if (process.platform !== "win32") throw new Error("WSL 测试监督器只能从 Windows 启动");
  await mkdir(resultDirectory, { recursive: true });
  const [guestScript, sourceRoot, guestResultDirectory, guestRelayPath] = await Promise.all([
    toWslPath(join(root, "scripts", "wsl-test-guest.mjs")),
    toWslPath(root),
    toWslPath(resultDirectory),
    existingRelayPath ? toWslPath(existingRelayPath) : Promise.resolve(null),
  ]);
  const guestCodexHome = liveProfile ? await toWslPath(join(homedir(), ".codex")) : null;
  const guestDataDir = liveProfile ? await toWslPath(defaultAccountDataDir()) : null;
  const manifestName = `wsl-${safeName(kind)}-manifest.json`;
  const guestNode = await wslCommandPath("node");
  const encodedStages = Buffer.from(JSON.stringify(stages), "utf8").toString("base64url");
  const guestArgs = [
    "-e", guestNode, guestScript,
    `--source-root=${sourceRoot}`,
    `--result-dir=${guestResultDirectory}`,
    `--manifest=${manifestName}`,
    `--source-sha256=${sourceSha256}`,
    `--kind=${safeName(kind)}`,
    `--stages=${encodedStages}`,
    ...(guestCodexHome ? [`--codex-home=${guestCodexHome}`] : []),
    ...(guestDataDir ? [`--data-dir=${guestDataDir}`] : []),
    ...(liveProfile ? [`--live-profile=${liveProfile}`] : []),
    ...(expectedCliSha256 ? [`--expected-cli-sha256=${expectedCliSha256}`] : []),
    ...(expectedRelaySha256 ? [`--expected-relay-sha256=${expectedRelaySha256}`] : []),
    ...(guestRelayPath ? [`--relay=${guestRelayPath}`] : []),
  ];
  const child = spawn("wsl.exe", guestArgs, {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
  const code = await childExit(child);
  const manifestPath = join(resultDirectory, manifestName);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8").catch(() => {
    throw new Error(`WSL 测试执行器退出 (${code}) 且没有生成清单 ${manifestPath}`);
  }));
  if (manifest.runtimeSnapshot?.relay) {
    const hostRelayPath = existingRelayPath ?? join(
      resultDirectory,
      "artifacts",
      `codex-quota-relay-wsl-${packageJson.version}`,
    );
    manifest.runtimeSnapshot.relay = {
      ...manifest.runtimeSnapshot.relay,
      guestPath: manifest.runtimeSnapshot.relay.path,
      path: hostRelayPath,
    };
  }
  return { ...manifest, exitCode: code, manifestPath };
}

export async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function toWslPath(path) {
  const { stdout } = await execFileAsync("wsl.exe", ["-e", "wslpath", "-u", resolve(path)], {
    windowsHide: true,
    encoding: "utf8",
  }).catch((error) => {
    throw new Error(`WSL 不可用或路径转换失败：${error.message}`);
  });
  const converted = String(stdout).trim();
  if (!converted) throw new Error(`WSL 路径转换结果为空：${path}`);
  return converted;
}

async function wslCommandPath(command) {
  if (!/^[a-zA-Z0-9._-]+$/.test(command)) throw new Error("WSL 命令名称无效");
  const { stdout } = await execFileAsync(
    "wsl.exe",
    ["-e", "sh", "-lc", `command -v ${command}`],
    { windowsHide: true, encoding: "utf8" },
  ).catch((error) => {
    throw new Error(`WSL PATH 中未找到 ${command}：${error.message}`);
  });
  const path = String(stdout).trim();
  if (!path.startsWith("/") || path.includes("\n")) {
    throw new Error(`WSL ${command} 路径无效：${path || "空"}`);
  }
  return path;
}

function safeName(value) {
  const name = String(value ?? "suite").replace(/[^a-zA-Z0-9._-]+/g, "-");
  if (!name || name === "." || name === "..") throw new Error("WSL 测试名称无效");
  return name.slice(0, 80);
}

function childExit(child) {
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`测试子进程被信号 ${signal} 终止`));
      else resolveExit(Number(code));
    });
  });
}
