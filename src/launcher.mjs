import { findCodexTarget } from "./cdp-client.mjs";
import { installFileLogger } from "./file-logger.mjs";
import { runInjector } from "./injector.mjs";
import { isCodexRunning, launchCodex, stopCodex } from "./platform.mjs";
import { acquireSingleInstance } from "./single-instance.mjs";

const CDP_PORT = Number(process.env.CODEX_QUOTA_CDP_PORT ?? 9229);

process.title = "Codex Quota Injector";
const logPath = installFileLogger();

async function main() {
  let instanceLock = null;
  try {
    instanceLock = await acquireSingleInstance();
    if (!instanceLock) return;

    const target = await findCodexTarget(CDP_PORT).catch(() => null);
    if (!target) {
      if (await isCodexRunning()) await stopCodex();
      await launchCodex(CDP_PORT);
    }

    console.log(`[launcher] 已启动，日志=${logPath}`);
    await runInjector({ port: CDP_PORT });
  } catch (error) {
    console.error(`[launcher] ${error?.stack ?? error}`);
    process.exitCode = 1;
  } finally {
    instanceLock?.close();
  }
}

main();
