import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import process from "node:process";
import { requestThreadHistoryRebuild } from "../../src/lifecycle-history-rebuild.mjs";
import { readJson } from "../../src/lifecycle-host.mjs";
import { defaultAccountDataDir } from "../../src/platform.mjs";
import { WINDOWS_NATIVE, WSL_NATIVE } from "../test-runtime-targets.mjs";
import { writePrivateJson } from "./io.mjs";
import { windowsPathToWsl, defaultWslCodexDirectories } from "./wsl-history-store.mjs";

async function requestWindowsRuntimeHistoryRebuild(control, runtimeTarget, threadIds, {
  requestHistory = requestThreadHistoryRebuild,
} = {}) {
  if (![WINDOWS_NATIVE, WSL_NATIVE].includes(runtimeTarget)) {
    throw new Error(`未知 Codex 历史运行环境：${runtimeTarget}`);
  }
  const runDirectory = dirname(control.reportPath);
  const relayConfigPath = join(
    control.dataDir ?? defaultAccountDataDir(),
    "app-server-relay-config.json",
  );
  const relayConfig = await readJson(relayConfigPath);
  if (!relayConfig?.upstreamExecutable) {
    throw new Error("当前正式包中继配置不可读，无法主动重建会话历史");
  }
  const rebuildConfigPath = join(runDirectory, `history-rebuild-${runtimeTarget}-relay.json`);
  const rebuildStatePath = join(runDirectory, `history-rebuild-${runtimeTarget}-state.json`);
  const rebuildUsagePath = join(runDirectory, `history-rebuild-${runtimeTarget}-usage.jsonl`);
  await writePrivateJson(rebuildConfigPath, {
    ...relayConfig,
    relayStatePath: rebuildStatePath,
    tokenUsageEventsPath: rebuildUsagePath,
    generation: `${relayConfig.generation}:history-rebuild:${randomUUID()}`,
  });

  let command;
  let args;
  let env = { ...process.env };
  if (runtimeTarget === WINDOWS_NATIVE) {
    command = join(
      control.installedApp,
      "relay",
      `codex-quota-relay-windows-${control.projectVersion}.exe`,
    );
    args = ["app-server", "--listen", "stdio://"];
    env.CODEX_HOME = control.codexHome;
    env.CODEX_SQLITE_HOME = control.codexHome;
    env.CODEX_QUOTA_RELAY_CONFIG = rebuildConfigPath;
    env.CODEX_QUOTA_WINDOWS_NATIVE = "1";
    env.CODEX_QUOTA_WSL_NATIVE = "0";
  } else {
    const [relayExecutable, directories] = await Promise.all([
      windowsPathToWsl(join(
        control.installedApp,
        "relay",
        `codex-quota-relay-wsl-${control.projectVersion}`,
      )),
      defaultWslCodexDirectories(),
    ]);
    command = "wsl.exe";
    args = [
      "-e", "env",
      `CODEX_HOME=${directories.codexHome}`,
      `CODEX_SQLITE_HOME=${directories.sqliteHome}`,
      `CODEX_QUOTA_RELAY_CONFIG=${rebuildConfigPath}`,
      "CODEX_QUOTA_WSL_NATIVE=1",
      "CODEX_QUOTA_WINDOWS_NATIVE=0",
      relayExecutable,
      "app-server", "--listen", "stdio://",
    ];
  }
  const result = await requestHistory({ command, args, env, threadIds });
  return {
    ...result,
    method: "thread/resume",
    relayRuntime: runtimeTarget,
  };
}

export { requestWindowsRuntimeHistoryRebuild };
