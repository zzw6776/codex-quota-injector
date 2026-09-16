import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, stat, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";

const execFileAsync = promisify(execFile);

const MACOS_EXECUTABLES = [
  "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  "/Applications/Codex.app/Contents/MacOS/Codex",
];

const MACOS_CODEX_BUNDLE_ID = "com.openai.codex";

const MACOS_HELPER_TERM_TIMEOUT_MS = 2_000;

const MACOS_HELPER_FORCE_TIMEOUT_MS = 3_000;

const WINDOWS_EXECUTABLE_NAMES = ["ChatGPT.exe", "Codex.exe"];

const WINDOWS_CODEX_CACHE_DIR = "codex-upstream";

const WINDOWS_CODEX_CACHE_FILE = "codex-upstream.exe";

const WINDOWS_CODEX_CACHE_MANIFEST = "manifest.json";

const WINDOWS_CODEX_APP_CACHE_DIR = "codex-app";

const WINDOWS_CODEX_APP_CACHE_MANIFEST = "manifest.json";

const RELAY_PROCESS_START_TIME_TOLERANCE_MS = 30_000;

function signalProcesses(processIds, signal) {
  for (const processId of processIds) {
    try {
      process.kill(processId, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isAnyProcessAlive(pids) {
  return pids.some(isProcessAlive);
}

async function waitForProcessIdsExit(processIds, timeoutMs, {
  isProcessAliveImpl,
  delayImpl,
  nowImpl,
}) {
  const deadline = nowImpl() + Math.max(0, timeoutMs);
  while (nowImpl() < deadline) {
    if (!processIds.some(isProcessAliveImpl)) return true;
    await delayImpl(100);
  }
  return !processIds.some(isProcessAliveImpl);
}

async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return null;
  }
}

async function isFileWithSize(path, size) {
  try {
    const info = await stat(path);
    return info.isFile() && info.size === size;
  } catch {
    return false;
  }
}

async function runPowerShell(script) {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
  );
  return stdout;
}

function powershellQuote(value) {
  return String(value).replaceAll("'", "''");
}

function firstNonEmptyLine(value) {
  return String(value)
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^"|"$/g, ""))
    .find(Boolean) ?? null;
}

async function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (candidate && await exists(candidate)) return candidate;
  }
  return null;
}

async function exists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { MACOS_EXECUTABLES, firstExisting, exists, execFileAsync, runPowerShell, powershellQuote, signalProcesses, isProcessAlive, isAnyProcessAlive, delay, MACOS_HELPER_TERM_TIMEOUT_MS, MACOS_HELPER_FORCE_TIMEOUT_MS, waitForProcessIdsExit, MACOS_CODEX_BUNDLE_ID, firstNonEmptyLine, RELAY_PROCESS_START_TIME_TOLERANCE_MS, WINDOWS_CODEX_CACHE_DIR, WINDOWS_CODEX_CACHE_FILE, WINDOWS_CODEX_CACHE_MANIFEST, readJsonFile, isFileWithSize, WINDOWS_CODEX_APP_CACHE_MANIFEST, WINDOWS_CODEX_APP_CACHE_DIR };
