#!/usr/bin/env node

import packageJson from "../package.json" with { type: "json" };
import { isSea } from "node:sea";

if (
  process.env.CODEX_QUOTA_ROLE === "app-server-relay" ||
  String(process.env.CODEX_QUOTA_RELAY_CONFIG ?? "").trim()
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
  const { ExtraModelManager } = await import("./extra-model-manager.mjs");
  const { installFileLogger } = await import("./file-logger.mjs");
  const { runInjector } = await import("./injector.mjs");
  const {
    activateCodex,
    getCodexLaunchReadiness,
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
  const explicitStart = isSea() || process.env.CODEX_QUOTA_EXPLICIT_START === "1";
  process.title = "Codex Quota Injector";
  const logPath = installFileLogger();
  if (!explicitStart) {
    console.warn("[launcher] 未经开发版或正式版启动入口触发，拒绝启动及接管现有实例");
    return;
  }
  let instanceLock = null;
  let takeoverInProgress = false;
  let launchOptions = { env: {}, relay: null };
  const contextManager = new CodexContextManager();
  const deepSeekManager = new DeepSeekManager();
  const extraModelManager = new ExtraModelManager();

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
        explicitStart,
        onTakeover: restartFromTakeover,
      });
    } catch (error) {
      if (!(error instanceof SingleInstanceTakeoverError)) throw error;
      console.warn(`[launcher] ${error.message}`);
      return;
    }
    if (!instanceLock) {
      console.log(
        `[launcher] 已有注入器保留运行，当前 ${instanceMode} v${instanceVersion} 未接管`,
      );
      return;
    }

    await contextManager.initialize();
    await deepSeekManager.initialize();
    await extraModelManager.initialize();
    launchOptions = await prepareCodexLaunch({ deepSeekManager, extraModelManager, contextManager });
    await ensureCodexDebugMode(port, launchOptions);

    console.log(`[launcher] 已启动，日志=${logPath}`);
    await runInjector({
      port,
      injectionMode: launchOptions.injectionMode,
      contextManager,
      deepSeekManager,
      extraModelManager,
      managersInitialized: true,
      prepareLaunch: () => prepareCodexLaunch({ deepSeekManager, extraModelManager, contextManager }),
    });
  } catch (error) {
    console.error(`[launcher] ${error?.stack ?? error}`);
    process.exitCode = 1;
  } finally {
    await closeSingleInstance(instanceLock);
  }

  async function ensureCodexDebugMode(cdpPort, options) {
    const isRunning = await isCodexRunning();
    const readiness = isRunning
      ? await getCodexLaunchReadiness(cdpPort, options)
      : {
        ready: false,
        debugReady: false,
        relayRequired: Boolean(options?.relay && !options.relay.expectAbsent),
        relayConfigReady: false,
        relayStateReady: false,
        relayStateReason: "Codex 未运行",
      };
    const relayConfigStatus = readiness.relayRequired
      ? readiness.relayConfigReady ? "正常" : "未就绪"
      : "不要求";
    const relayStateStatus = readiness.relayRequired
      ? readiness.relayStateReady
        ? "正常"
        : `未就绪（${readiness.relayStateReason ?? "未知原因"}）`
      : "不要求";
    console.log(
      `[launcher] Codex 启动条件：进程=${isRunning ? "运行中" : "未运行"}，` +
      `调试端口 ${cdpPort}=${readiness.debugReady ? "正常" : "不可用"}，` +
      `模型中继配置=${relayConfigStatus}，模型中继进程=${relayStateStatus}，` +
      `决策=${readiness.ready ? "复用并激活" : "重启"}`,
    );
    if (readiness.ready) {
      await activateCodex();
      console.log(`[launcher] Codex 已处于调试及模型中继模式（端口 ${cdpPort}）`);
      return;
    }
    console.log(`[launcher] 正在以调试及模型中继模式重启 Codex（端口 ${cdpPort}）`);
    await restartCodex(cdpPort, options);
  }

}
