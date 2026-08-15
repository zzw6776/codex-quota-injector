#!/usr/bin/env node

import packageJson from "../package.json" with { type: "json" };
import { isSea } from "node:sea";

if (
  process.env.CODEX_QUOTA_ROLE === "app-server-relay" ||
  (String(process.env.CODEX_QUOTA_RELAY_CONFIG ?? "").trim() &&
    String(process.env.CODEX_QUOTA_UPSTREAM_CODEX_CLI ?? "").trim())
) {
  void import("./app-server-relay.mjs")
    .then(({ runAppServerRelay }) => runAppServerRelay())
    .catch((error) => {
      console.error(error?.stack ?? error);
      process.exit(1);
    });
} else {
  void runLauncher();
}

async function runLauncher() {
  const { prepareCodexLaunch } = await import("./codex-bridge.mjs");
  const { CodexContextManager } = await import("./codex-context.mjs");
  const { DeepSeekManager } = await import("./deepseek-manager.mjs");
  const { installFileLogger } = await import("./file-logger.mjs");
  const { runInjector } = await import("./injector.mjs");
  const {
    activateCodex,
    isCodexLaunchReady,
    isCodexRunning,
    restartCodex,
  } = await import("./platform.mjs");
  const {
    acquireSingleInstance,
    closeSingleInstance,
    SingleInstanceTakeoverError,
  } = await import("./single-instance.mjs");

  const port = Number(process.env.CODEX_QUOTA_CDP_PORT ?? 9229);
  const instanceMode = isSea() ? "formal" : "dev";
  const instanceVersion = String(packageJson.version ?? "0.0.0");
  process.title = "Codex Quota Injector";
  const logPath = installFileLogger();
  let instanceLock = null;
  let takeoverInProgress = false;
  let launchOptions = { env: {}, relay: null };
  const contextManager = new CodexContextManager();
  const deepSeekManager = new DeepSeekManager();

  const restartFromTakeover = async (request) => {
    if (takeoverInProgress) return;
    takeoverInProgress = true;
    console.log(`[launcher] ${request?.mode ?? "unknown"} v${request?.version ?? "unknown"} 请求接管，正在退出当前实例`);
    await closeSingleInstance(instanceLock);
    process.exit(0);
  };

  try {
    try {
      instanceLock = await acquireSingleInstance({
        mode: instanceMode,
        version: instanceVersion,
        onTakeover: restartFromTakeover,
      });
    } catch (error) {
      if (!(error instanceof SingleInstanceTakeoverError)) throw error;
      console.warn(`[launcher] ${error.message}`);
      return;
    }
    if (!instanceLock) return;

    await contextManager.initialize();
    await deepSeekManager.initialize();
    launchOptions = await prepareCodexLaunch({ deepSeekManager, contextManager });
    await ensureCodexDebugMode(port, launchOptions);

    console.log(`[launcher] 已启动，日志=${logPath}`);
    await runInjector({
      port,
      contextManager,
      deepSeekManager,
      managersInitialized: true,
      prepareLaunch: () => prepareCodexLaunch({ deepSeekManager, contextManager }),
    });
  } catch (error) {
    console.error(`[launcher] ${error?.stack ?? error}`);
    process.exitCode = 1;
  } finally {
    await closeSingleInstance(instanceLock);
  }

  async function ensureCodexDebugMode(cdpPort, options) {
    const ready = await isCodexRunning() && await isCodexLaunchReady(cdpPort, options);
    if (ready) {
      await activateCodex();
      console.log(`[launcher] Codex 已处于调试及模型中继模式（端口 ${cdpPort}）`);
      return;
    }
    console.log(`[launcher] 正在以调试及模型中继模式重启 Codex（端口 ${cdpPort}）`);
    await restartCodex(cdpPort, options);
  }

}
