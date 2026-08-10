#!/usr/bin/env node

if (process.env.CODEX_QUOTA_ROLE === "app-server-relay") {
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
  const { spawn } = await import("node:child_process");
  const { prepareCodexLaunch } = await import("./codex-bridge.mjs");
  const { CodexContextManager } = await import("./codex-context.mjs");
  const { DeepSeekManager } = await import("./deepseek-manager.mjs");
  const { installFileLogger } = await import("./file-logger.mjs");
  const { runInjector } = await import("./injector.mjs");
  const {
    isCodexRunning,
    isRelayStateCurrent,
    restartCodex,
    stopOtherInjectorProcesses,
  } = await import("./platform.mjs");
  const {
    acquireSingleInstance,
    closeSingleInstance,
    SingleInstanceTakeoverError,
  } = await import("./single-instance.mjs");

  const port = Number(process.env.CODEX_QUOTA_CDP_PORT ?? 9229);
  process.title = "Codex Quota Injector";
  const logPath = installFileLogger();
  let instanceLock = null;
  let takeoverInProgress = false;
  let launchOptions = { env: {}, relay: null };
  const contextManager = new CodexContextManager();
  const deepSeekManager = new DeepSeekManager();

  const restartFromTakeover = async () => {
    if (takeoverInProgress) return;
    takeoverInProgress = true;
    console.log("[launcher] 收到重复启动，正在接管注入器");
    await closeSingleInstance(instanceLock);
    await ensureCodexDebugMode(port, launchOptions).catch((error) => {
      console.error(`[launcher] 准备 Codex 调试模式失败: ${error.message}`);
    });
    relaunchSelf(spawn);
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
    const debugReady = await hasCodexDebugPort(cdpPort);
    const relayReady = !options.relay
      ? true
      : options.relay.expectAbsent
        ? !await isRelayStateCurrent(options.relay.statePath)
        : await isRelayStateCurrent(options.relay.statePath, options.relay.generation);
    if (debugReady && relayReady) {
      console.log(`[launcher] Codex 已处于调试及模型中继模式（端口 ${cdpPort}）`);
      return;
    }
    console.log(`[launcher] 正在以调试及模型中继模式重启 Codex（端口 ${cdpPort}）`);
    await restartCodex(cdpPort, options);
  }

  async function hasCodexDebugPort(cdpPort) {
    if (!await isCodexRunning()) return false;
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, {
        signal: AbortSignal.timeout(2_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  function relaunchSelf(spawnImpl) {
    const child = spawnImpl(process.execPath, process.argv.slice(1), {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  }
}
