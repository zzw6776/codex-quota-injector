import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { release } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function isWslRuntime({
  platform = process.platform,
  environment = process.env,
  releaseValue = release(),
} = {}) {
  return platform === "linux" &&
    (Boolean(environment.WSL_DISTRO_NAME) || /microsoft/i.test(releaseValue));
}

export async function toWindowsPath(path) {
  const { stdout } = await execFileAsync("wslpath", ["-w", resolve(path)], { encoding: "utf8" });
  return stdout.trim();
}

async function toWslPath(path) {
  if (!/^[a-zA-Z]:[\\/]/.test(path)) return resolve(path);
  const { stdout } = await execFileAsync("wslpath", ["-u", path], { encoding: "utf8" });
  return stdout.trim();
}

export async function findWindowsNodeExecutable() {
  const candidates = [];
  if (process.env.CODEX_TEST_DESKTOP_NODE) candidates.push(process.env.CODEX_TEST_DESKTOP_NODE);
  const whereCommands = ["where.exe"];
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    if (/[/\\]Windows[/\\]System32[/\\]?$/i.test(entry)) whereCommands.push(join(entry, "where.exe"));
  }
  for (const command of new Set(whereCommands)) {
    const result = await execFileAsync(command, ["node.exe"], {
      encoding: "utf8", timeout: 5_000, windowsHide: true,
    }).catch(() => null);
    if (result?.stdout) candidates.push(...result.stdout.split(/\r?\n/).filter(Boolean));
  }
  for (const mount of await windowsDriveMounts()) {
    const command = join(mount, "Windows", "System32", "cmd.exe");
    if (!await access(command).then(() => true, () => false)) continue;
    const result = await execFileAsync(command, ["/d", "/s", "/c", "where node.exe"], {
      encoding: "utf8", timeout: 5_000, windowsHide: true,
    }).catch(() => null);
    if (result?.stdout) candidates.push(...result.stdout.split(/\r?\n/).filter(Boolean));
  }
  for (const candidate of candidates) {
    const executable = await toWslPath(candidate.trim()).catch(() => null);
    if (!executable || !await access(executable).then(() => true, () => false)) continue;
    const result = await execFileAsync(executable, ["-p", "process.platform"], {
      encoding: "utf8", timeout: 5_000, windowsHide: true,
    }).catch(() => null);
    if (result?.stdout.trim() === "win32") return executable;
  }
  throw new Error("WSL 中未找到可用的 Windows 原生 node.exe；请安装 Windows Node.js，或用 CODEX_TEST_DESKTOP_NODE 指定其路径");
}

async function windowsDriveMounts() {
  const mounts = await readFile("/proc/mounts", "utf8").catch(() => "");
  return mounts.split("\n")
    .filter((line) => line.includes("aname=drvfs"))
    .map((line) => line.split(" ")[1])
    .filter(Boolean)
    .map((path) => path.replaceAll(/\\([0-7]{3})/g,
      (_match, octal) => String.fromCharCode(Number.parseInt(octal, 8))));
}
