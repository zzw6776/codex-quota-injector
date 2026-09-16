import { join } from "node:path";
import { homedir } from "node:os";
import { appendFile, mkdir } from "node:fs/promises";
import { execFileAsync } from "./contract.mjs";

async function resolveRelayPath(value) {
  const path = String(value ?? "").trim();
  if (!path || process.env.CODEX_QUOTA_WSL_NATIVE !== "1" || !isWindowsPath(path)) {
    return path;
  }
  try {
    const { stdout } = await execFileAsync("wslpath", ["-u", path]);
    const converted = stdout.trim();
    if (converted) return converted;
  } catch (error) {
    throw new Error(`无法转换 Windows 中继路径 ${path}: ${error.message}`);
  }
  throw new Error(`无法转换 Windows 中继路径: ${path}`);
}

async function resolveNativeWslRelayConfigPath() {
  const appDataRoot = await resolveWindowsDirectoryInWsl("APPDATA");
  return join(appDataRoot, "Codex Quota Injector", "app-server-relay-config.json");
}

function resolveNativeWindowsRelayConfigPath() {
  const appDataRoot = String(process.env.APPDATA ?? "").trim() ||
    join(homedir(), "AppData", "Roaming");
  return join(appDataRoot, "Codex Quota Injector", "app-server-relay-config.json");
}

async function resolveNativeWslCodexCli() {
  try {
    const { stdout } = await execFileAsync("sh", ["-c", "command -v codex"]);
    const executable = stdout.trim();
    if (executable) return executable;
  } catch {
    // Report a stable relay-specific error below.
  }
  throw new Error("WSL PATH 中未找到 Codex Desktop 提供的原生 codex 可执行文件");
}

async function readWindowsEnvironmentVariable(name) {
  try {
    const { stdout } = await execFileAsync("cmd.exe", ["/d", "/c", `echo %${name}%`]);
    const value = stdout.replaceAll("\r", "").trim();
    if (value && value !== `%${name}%`) return value;
  } catch (error) {
    throw new Error(`无法从 WSL 读取 Windows ${name}: ${error.message}`);
  }
  throw new Error(`Windows ${name} 为空，无法定位模型中继配置`);
}

async function resolveWindowsDirectoryInWsl(name) {
  const forwarded = String(process.env[name] ?? "").trim();
  if (forwarded) return resolveRelayPath(forwarded);
  return resolveRelayPath(await readWindowsEnvironmentVariable(name));
}

async function appendNativeWslDiagnostic(message) {
  const localAppDataRoot = await resolveWindowsDirectoryInWsl("LOCALAPPDATA");
  const logRoot = join(localAppDataRoot, "Codex Quota Injector", "Logs");
  await mkdir(logRoot, { recursive: true, mode: 0o700 });
  await appendFile(
    join(logRoot, "wsl-relay-stderr.log"),
    `${new Date().toISOString()} [wsl-relay] ${message}\n`,
    "utf8",
  );
}

function isWindowsPath(path) {
  return /^(?:[a-z]:[\\/]|\\\\\?\\[a-z]:[\\/])/i.test(path);
}

export { resolveRelayPath, resolveNativeWslRelayConfigPath, resolveNativeWindowsRelayConfigPath, resolveNativeWslCodexCli, appendNativeWslDiagnostic };
