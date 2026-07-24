import { spawn } from "node:child_process";

import { installFileLogger } from "./file-logger.mjs";
import { runInjector } from "./injector.mjs";
import { restartCodex, stopOtherInjectorProcesses } from "./platform.mjs";
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
    console.log("[launcher] 收到重复启动，正在完全重启 Codex 和注入器");
    await closeSingleInstance(instanceLock);
    await restartCodex(CDP_PORT).catch((error) => {
      console.error(`[launcher] 重启 Codex 失败: ${error.message}`);
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

    await restartCodex(CDP_PORT);

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

function relaunchSelf() {
  const child = spawn(process.execPath, process.argv.slice(1), {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}
