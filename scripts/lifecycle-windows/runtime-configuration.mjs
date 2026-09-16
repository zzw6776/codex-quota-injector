import { readFile, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { updateWindowsSubsystemSetting, parseWindowsSubsystemSetting } from "../../src/platform.mjs";
import { WINDOWS_NATIVE, WSL_NATIVE } from "../test-runtime-targets.mjs";
import { hashBytes, writePrivateText } from "./io.mjs";

async function captureWindowsRuntimeConfiguration({
  runDirectory,
  configPath = join(homedir(), ".codex", "config.toml"),
} = {}) {
  const backupPath = join(runDirectory, "codex-config.before-runtime-switch.toml");
  let contents;
  let existed = true;
  try {
    contents = await readFile(configPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    existed = false;
    contents = Buffer.alloc(0);
  }
  if (existed) await writeFile(backupPath, contents, { mode: 0o600 });
  const text = contents.toString("utf8");
  return {
    configPath,
    backupPath,
    existed,
    sha256: hashBytes(contents),
    generatedSha256: {
      [WINDOWS_NATIVE]: hashBytes(Buffer.from(updateWindowsSubsystemSetting(text, false))),
      [WSL_NATIVE]: hashBytes(Buffer.from(updateWindowsSubsystemSetting(text, true))),
    },
    originalRuntime: parseConfigRuntime(text),
    mutationStarted: false,
  };
}

async function setWindowsRuntimeConfiguration(configuration, runtimeTarget) {
  if (![WINDOWS_NATIVE, WSL_NATIVE].includes(runtimeTarget)) {
    throw new Error(`Windows 生命周期运行环境无效：${runtimeTarget}`);
  }
  const contents = await readFile(configuration.configPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  const currentHash = contents == null ? null : hashBytes(contents);
  const allowedHashes = new Set([
    configuration.sha256,
    ...Object.values(configuration.generatedSha256 ?? {}),
    configuration.lastAppliedSha256,
    configuration.restoredSha256,
  ]);
  const initialMissing = contents == null && !configuration.existed && !configuration.mutationStarted;
  const externalChangeAfterMutation = currentHash != null && !allowedHashes.has(currentHash) &&
    configuration.mutationStarted &&
    parseConfigRuntime(contents.toString("utf8")) === configuration.activeRuntime;
  const preservingExternalContent = externalChangeAfterMutation ||
    currentHash === configuration.lastAppliedSha256 &&
      configuration.externalChangesPreserved === true;
  if (!initialMissing && (currentHash == null ||
    !allowedHashes.has(currentHash) && !externalChangeAfterMutation)) {
    throw new Error("Codex 配置在生命周期测试期间被外部修改，拒绝切换运行方式");
  }
  const updated = updateWindowsSubsystemSetting(contents?.toString("utf8") ?? "", runtimeTarget === WSL_NATIVE);
  if (!preservingExternalContent && hashBytes(Buffer.from(updated)) !==
    configuration.generatedSha256?.[runtimeTarget]) {
    throw new Error("Codex 运行方式切换结果与测试前生成的安全版本不一致");
  }
  await writePrivateText(configuration.configPath, updated);
  configuration.mutationStarted = true;
  configuration.activeRuntime = runtimeTarget;
  configuration.lastAppliedSha256 = hashBytes(Buffer.from(updated));
  configuration.restoredSha256 = null;
  configuration.externalChangesPreserved = configuration.externalChangesPreserved === true ||
    externalChangeAfterMutation;
  const actual = parseConfigRuntime(await readFile(configuration.configPath, "utf8"));
  if (actual !== runtimeTarget) throw new Error(`Codex 运行方式写入后仍为 ${actual}`);
  return { runtimeTarget, configSha256: hashBytes(Buffer.from(updated)) };
}

async function restoreWindowsRuntimeConfiguration(configuration) {
  const current = await readFile(configuration.configPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  const currentHash = current ? hashBytes(current) : null;
  const allowedHashes = new Set([
    configuration.sha256,
    ...Object.values(configuration.generatedSha256 ?? {}),
    configuration.lastAppliedSha256,
  ]);
  let restored;
  let externalChangesPreserved = false;
  if (currentHash != null && currentHash === configuration.restoredSha256) {
    restored = current;
    externalChangesPreserved = configuration.externalChangesPreserved === true;
  } else if (currentHash != null && (!allowedHashes.has(currentHash) ||
    currentHash === configuration.lastAppliedSha256 &&
      configuration.externalChangesPreserved === true)) {
    if (!configuration.mutationStarted ||
      parseConfigRuntime(current.toString("utf8")) !== configuration.activeRuntime) {
      throw new Error("Codex 运行方式被外部修改或不属于本次测试，拒绝覆盖");
    }
    restored = Buffer.from(updateWindowsSubsystemSetting(
      current.toString("utf8"),
      configuration.originalRuntime === WSL_NATIVE,
    ));
    externalChangesPreserved = true;
    await writePrivateText(configuration.configPath, restored);
  } else if (currentHash == null && configuration.existed) {
    throw new Error("Codex 配置在生命周期测试期间被删除，拒绝覆盖未知状态");
  } else if (configuration.existed) {
    const original = await readFile(configuration.backupPath);
    if (hashBytes(original) !== configuration.sha256) {
      throw new Error("Codex 运行方式备份哈希不匹配，拒绝恢复未知内容");
    }
    await writePrivateText(configuration.configPath, original);
    restored = original;
  } else {
    await rm(configuration.configPath, { force: true });
    restored = null;
  }
  configuration.activeRuntime = configuration.originalRuntime;
  configuration.lastAppliedSha256 = restored ? hashBytes(restored) : null;
  configuration.restoredSha256 = restored ? hashBytes(restored) : null;
  configuration.externalChangesPreserved = externalChangesPreserved;
  if (!await windowsRuntimeConfigurationMatches(configuration)) {
    throw new Error("Codex 运行方式没有恢复为测试前内容");
  }
  return {
    runtimeTarget: configuration.originalRuntime,
    configRestored: true,
    configSha256: configuration.restoredSha256,
    externalChangesPreserved,
  };
}

async function windowsRuntimeConfigurationMatches(configuration) {
  try {
    const contents = await readFile(configuration.configPath);
    return parseConfigRuntime(contents.toString("utf8")) === configuration.originalRuntime;
  } catch (error) {
    return !configuration.existed && error?.code === "ENOENT";
  }
}

function parseConfigRuntime(contents) {
  return parseWindowsSubsystemSetting(contents) ? WSL_NATIVE : WINDOWS_NATIVE;
}

export { captureWindowsRuntimeConfiguration, setWindowsRuntimeConfiguration, restoreWindowsRuntimeConfiguration, windowsRuntimeConfigurationMatches };
