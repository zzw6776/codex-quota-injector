import { execFile } from "node:child_process";
import { chmod } from "node:fs/promises";
import { release } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function wslWindowsMount(path) {
  return process.platform === "linux" && /microsoft/i.test(release()) && /^\/mnt\/[a-z]\//i.test(path);
}

async function windowsAclTarget(path) {
  if (process.platform === "win32") {
    return { executable: join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"), path };
  }
  if (!wslWindowsMount(path)) return null;
  const { stdout } = await execFileAsync("wslpath", ["-w", path], { encoding: "utf8", timeout: 5_000 });
  return { executable: "/mnt/c/Windows/System32/icacls.exe", path: stdout.trim() };
}

function sandboxPrincipals(output) {
  const principals = [];
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const match = /(?:^|\s)(\S*CodexSandboxUsers):\(/i.exec(line);
    if (match) principals.push(match[1].trim());
  }
  return [...new Set(principals)];
}

async function secureDiagnosticPath(path, log = message => console.error(message)) {
  if (process.platform !== "win32") await chmod(path, 0o600);
  let target;
  try {
    target = await windowsAclTarget(path);
    if (!target) return false;
    const run = arguments_ => execFileAsync(target.executable, [target.path, ...arguments_], {
      encoding: "utf8", timeout: 10_000, windowsHide: true,
    });
    // Disable inheritance while copying existing entries, then remove only the
    // desktop sandbox readers. The owner, SYSTEM and Administrators stay intact.
    await run(["/inheritance:d"]);
    let acl = await run([]);
    for (const principal of sandboxPrincipals(acl.stdout)) await run(["/remove:g", principal]);
    acl = await run([]);
    if (/CodexSandboxUsers/i.test(acl.stdout)) throw Error("CodexSandboxUsers 仍具有日志访问权限");
    return true;
  } catch (error) {
    log(`[model-router] 无法收紧全量请求日志宿主 ACL：${error.message}`);
    return false;
  }
}

export { sandboxPrincipals, secureDiagnosticPath };
