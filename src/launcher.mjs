import { spawn } from "node:child_process";

import { installFileLogger } from "./file-logger.mjs";
import { runInjector } from "./injector.mjs";
import { isCodexRunning, restartCodex, stopOtherInjectorProcesses } from "./platform.mjs";
import {
  acquireSingleInstance,
  closeSingleInstance,
  SingleInstanceTakeoverError,
} from "./single-instance.mjs";

const CDP_PORT = Number(process.env.CODEX_QUOTA_CDP_PORT ?? 9229);

process.title = "Codex Quota Injector";
const logPath = installFileLogger();

async function main() {
  let instanceLock = null;
  let takeoverInProgress = false;
  const restartFromTakeover = async () => {
    if (takeoverInProgress) return;
    takeoverInProgress = true;
    console.log("[launcher] 收到重复启动，正在接管注入器");
    await closeSingleInstance(instanceLock);
    await ensureCodexDebugMode(CDP_PORT).catch((error) => {
      console.error(`[launcher] 准备 Codex 调试模式失败: ${error.message}`);
    });
    relaunchSelf();
    process.exit(0);
  };
  try {
    try {
      instanceLock = await acquireSingleInstance({ onTakeover: restartFromTakeover });
    } catch (error) {
      if (!(error instanceof SingleInstanceTakeoverError)) throw error;
      console.warn("[launcher] 旧注入器未响应，强制结束后接管启动");
      await stopOtherInjectorProcesses();
      instanceLock = await acquireSingleInstance({ onTakeover: restartFromTakeover });
    }
    if (!instanceLock) return;

    await ensureCodexDebugMode(CDP_PORT);

    console.log(`[launcher] 已启动，日志=${logPath}`);
    await runInjector({ port: CDP_PORT });
  } catch (error) {
    console.error(`[launcher] ${error?.stack ?? error}`);
    process.exitCode = 1;
  } finally {
    await closeSingleInstance(instanceLock);
  }
}

main();

async function ensureCodexDebugMode(port) {
  if (await hasCodexDebugPort(port)) {
    console.log(`[launcher] Codex 已处于调试模式，保留当前进程（端口 ${port}）`);
    return;
  }
  console.log(`[launcher] Codex 未开放调试端口，正在以调试模式重启（端口 ${port}）`);
  await restartCodex(port);
}

async function hasCodexDebugPort(port) {
  if (!await isCodexRunning()) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function relaunchSelf() {
  const child = spawn(process.execPath, process.argv.slice(1), {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}
