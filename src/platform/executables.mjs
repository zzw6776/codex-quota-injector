import { dirname, join, resolve } from "node:path";
import { MACOS_EXECUTABLES, firstExisting, exists, execFileAsync } from "./contract.mjs";
import { detectRunningWindowsCodexExecutable, detectWindowsStoreCodexExecutable, windowsCommonExecutableCandidates } from "./windows-discovery.mjs";
import { parseProcessList } from "./process-parsing.mjs";
import { materializeWindowsCodexCli } from "./windows-artifacts.mjs";

let cachedCodexExecutable = null;

async function resolveCodexExecutable({ refresh = false } = {}) {
  if (!refresh && cachedCodexExecutable && await exists(cachedCodexExecutable)) {
    return cachedCodexExecutable;
  }

  let resolved = null;
  if (process.platform === "darwin") {
    resolved =
      await detectRunningMacCodexExecutable() ??
      await firstExisting(MACOS_EXECUTABLES);
  } else if (process.platform === "win32") {
    resolved =
      await detectRunningWindowsCodexExecutable() ??
      await detectWindowsStoreCodexExecutable() ??
      await firstExisting(windowsCommonExecutableCandidates());
  }

  if (!resolved) {
    throw new Error(
      process.platform === "win32"
        ? "未检测到 Codex，请先从 Microsoft Store 安装 ChatGPT / Codex"
        : "未检测到 /Applications/ChatGPT.app 或 /Applications/Codex.app",
    );
  }
  cachedCodexExecutable = resolved;
  return resolved;
}

async function resolveCodexCliExecutable({
  environment = process.env,
  platform = process.platform,
  resolveApp = () => resolveCodexExecutable({ refresh: true }),
  existsImpl = exists,
  materializeCli = materializeWindowsCodexCli,
} = {}) {
  if (environment.CODEX_QUOTA_UPSTREAM_CODEX_CLI) {
    const overridden = resolve(environment.CODEX_QUOTA_UPSTREAM_CODEX_CLI);
    if (await existsImpl(overridden)) return overridden;
    throw new Error(`指定的 Codex CLI 不存在: ${overridden}`);
  }
  const appExecutable = await resolveApp();
  const candidates = platform === "win32"
    ? [
      join(dirname(appExecutable), "resources", "codex.exe"),
      join(dirname(appExecutable), "resources", "codex"),
      join(dirname(appExecutable), "Resources", "codex.exe"),
      join(dirname(appExecutable), "Resources", "codex"),
    ]
    : [
      join(dirname(dirname(appExecutable)), "Resources", "codex-cli", "CodexCLI.app", "Contents", "MacOS", "codex"),
      join(dirname(dirname(appExecutable)), "Resources", "codex"),
    ];
  let candidate = null;
  for (const path of candidates) {
    if (await existsImpl(path)) { candidate = path; break; }
  }
  if (!candidate) {
    throw new Error(`Codex App Server 可执行文件不存在: ${candidates.join(" / ")}`);
  }
  return platform === "win32"
    ? materializeCli(candidate)
    : candidate;
}

async function detectRunningMacCodexExecutable() {
  const { stdout } = await execFileAsync("/bin/ps", ["-axww", "-o", "pid=,comm="])
    .catch(() => ({ stdout: "" }));
  return MACOS_EXECUTABLES.find((executable) =>
    parseProcessList(stdout, executable).length > 0
  ) ?? null;
}

export { resolveCodexExecutable, resolveCodexCliExecutable };
