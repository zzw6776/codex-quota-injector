import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rolloutThreadId } from "../src/lifecycle-turn-gate.mjs";
import { codexLaunchEnvironment } from "../src/platform/lifecycle.mjs";

const execFileAsync = promisify(execFile);
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function bindLifecycleTask(control, threadId = control?.initiatingTurn?.threadId) {
  const turns = control?.sessionCheckpoint?.turns ?? [];
  const ids = [...new Set(turns.map(turn => rolloutThreadId(turn.path)).filter(Boolean))];
  const boundId = threadId ?? (ids.length === 1 ? ids[0] : null);
  const turn = turns.find(entry => rolloutThreadId(entry.path) === boundId);
  if (!UUID.test(boundId ?? "") || !turn?.turnId) {
    throw new Error("BLOCKED：无法唯一绑定发起任务及回合，拒绝自动打开其他任务");
  }
  return { threadId: boundId, turnId: turn.turnId, path: turn.path };
}

// Open the existing initiating task through Desktop's official deep link. This
// resumes its task-local MCP configuration without submitting a model turn.
export async function activateLifecycleTaskTools(control, host, {
  platform = process.platform,
  execFileImpl = execFileAsync,
  environment = process.env,
} = {}) {
  const origin = bindLifecycleTask(control);
  const pids = host?.codexPids ?? [];
  if (!host?.readiness?.coreReady || pids.length !== 1 || !Number.isSafeInteger(pids[0]) || pids[0] <= 0) {
    throw new Error("BLOCKED：桌面主进程尚未唯一就绪，未激活任务工具");
  }
  const pid = pids[0];
  const url = `codex://threads/${origin.threadId}`;
  const options = { windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 };
  if (platform === "win32") {
    const { stdout } = await execFileImpl("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
      `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').ExecutablePath`,
    ], options);
    const executable = String(stdout).trim();
    if (!/^[A-Za-z]:\\[^\r\n]+\\(?:Codex|ChatGPT)\.exe$/i.test(executable)) {
      throw new Error("BLOCKED：无法确认当前 Windows Codex 主进程的可执行文件");
    }
    await execFileImpl(executable, [url], { ...options, env: codexLaunchEnvironment(environment) });
  } else if (platform === "darwin") {
    const { stdout } = await execFileImpl("/bin/ps", ["-ww", "-p", String(pid), "-o", "comm="], options);
    const executable = String(stdout).trim();
    const app = executable.match(/^(\/[^\r\n]+\.app)\/Contents\/MacOS\/(?:Codex|ChatGPT)$/)?.[1];
    if (!app) throw new Error("BLOCKED：无法确认当前 macOS Codex 主进程的应用包");
    await execFileImpl("/usr/bin/open", ["-a", app, url], options);
  } else {
    throw new Error("任务工具桌面激活仅支持 Windows 和 macOS 控制器");
  }
  return { method: "official-thread-deep-link", threadId: origin.threadId, turnId: origin.turnId,
    codexPid: pid, requestedAt: new Date().toISOString(), modelRequests: 0 };
}
