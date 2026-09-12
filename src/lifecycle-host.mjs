import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { isCodexDebugPortReady } from "./cdp-client.mjs";
import {
  defaultAccountDataDir,
  isRelayStateCurrent,
  listCodexProcessIds,
} from "./platform.mjs";

const execFileAsync = promisify(execFile);
export const DEFAULT_INSTALLED_APP = "/Applications/Codex Quota Injector.app";
export const SINGLE_INSTANCE_PORT = 49_229;

export function lifecycleFingerprint(value) {
  if (!value) return null;
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}

export function relayProtocolFromGeneration(generation) {
  const match = String(generation ?? "").match(/(?:^|:)usage-events-v(\d+)(?::|$)/);
  return match ? Number(match[1]) : null;
}

export function selectLifecycleAccountPair(index) {
  const accounts = Array.isArray(index?.accounts) ? index.accounts : [];
  const currentAccountId = typeof index?.currentAccountId === "string"
    ? index.currentAccountId
    : null;
  const current = accounts.find((account) => account?.id === currentAccountId);
  const target = accounts.find((account) =>
    account?.id && account.id !== currentAccountId && account.authMode === "oauth"
  );
  if (!current || current.authMode !== "oauth" || !target) {
    return { currentAccountId: null, targetAccountId: null, available: false };
  }
  return {
    currentAccountId,
    targetAccountId: target.id,
    available: true,
  };
}

export function evaluateLifecycleReadiness({
  relayConfig,
  relayState,
  relayPidAlive,
  relayStateCurrent = relayPidAlive,
  codexPids,
  injectorPids,
  debugReady = true,
  expectedProtocol,
} = {}) {
  const protocol = relayProtocolFromGeneration(relayConfig?.generation);
  const generationMatches = Boolean(
    relayConfig?.generation && relayState?.generation === relayConfig.generation,
  );
  const relayReady = generationMatches && relayPidAlive === true && relayStateCurrent === true &&
    Number.isInteger(relayState?.pid) && relayState.pid > 0;
  const singleInjector = Array.isArray(injectorPids) && injectorPids.length === 1;
  const codexRunning = Array.isArray(codexPids) && codexPids.length > 0;
  return {
    ready: codexRunning && debugReady && singleInjector && relayReady && protocol === expectedProtocol,
    codexRunning,
    debugReady,
    singleInjector,
    relayReady,
    generationMatches,
    protocol,
    expectedProtocol,
  };
}

export async function inspectLifecycleHost({
  dataDir = defaultAccountDataDir(),
  installedApp = DEFAULT_INSTALLED_APP,
  expectedProtocol,
  cdpPort = 9_229,
} = {}) {
  const relayConfigPath = join(dataDir, "app-server-relay-config.json");
  const relayStatePath = join(dataDir, "app-server-relay-state.json");
  const accountIndexPath = join(dataDir, "accounts.json");
  const [relayConfig, relayState, accountIndex, codexPids, injectorPids, installedVersion, debugReady] =
    await Promise.all([
      readJson(relayConfigPath),
      readJson(relayStatePath),
      readJson(accountIndexPath),
      listCodexProcessIds(),
      findInjectorListenerPids(),
      readMacAppVersion(installedApp),
      isCodexDebugPortReady(cdpPort),
    ]);
  const pair = selectLifecycleAccountPair(accountIndex);
  const relayPidAlive = isProcessAlive(relayState?.pid);
  const relayStateCurrent = relayConfig?.generation
    ? await isRelayStateCurrent(relayStatePath, relayConfig.generation)
    : false;
  const readiness = evaluateLifecycleReadiness({
    relayConfig,
    relayState,
    relayPidAlive,
    relayStateCurrent,
    codexPids,
    injectorPids,
    debugReady,
    expectedProtocol,
  });
  return {
    platform: process.platform,
    arch: process.arch,
    installedApp,
    installedVersion,
    codexPids,
    injectorPids,
    relay: {
      configVersion: Number.isInteger(relayConfig?.version) ? relayConfig.version : null,
      protocol: readiness.protocol,
      generationMatches: readiness.generationMatches,
      pid: Number.isInteger(relayState?.pid) ? relayState.pid : null,
      pidAlive: relayPidAlive,
      stateCurrent: relayStateCurrent,
    },
    readiness,
    accounts: {
      count: Array.isArray(accountIndex?.accounts) ? accountIndex.accounts.length : 0,
      roundTripAvailable: pair.available,
      current: lifecycleFingerprint(pair.currentAccountId),
      target: lifecycleFingerprint(pair.targetAccountId),
    },
    privateAccountPair: pair,
    paths: { relayConfigPath, relayStatePath, accountIndexPath },
  };
}

export async function findInjectorListenerPids(port = SINGLE_INSTANCE_PORT) {
  if (process.platform !== "darwin") return [];
  const { stdout } = await execFileAsync("/usr/sbin/lsof", [
    "-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN",
  ]).catch((error) => {
    if (error?.code === 1) return { stdout: "" };
    throw error;
  });
  return [...new Set(String(stdout).split(/\r?\n/)
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0))];
}

export async function readMacAppVersion(appPath) {
  if (process.platform !== "darwin") return null;
  const plist = join(appPath, "Contents", "Info.plist");
  const { stdout } = await execFileAsync("/usr/libexec/PlistBuddy", [
    "-c", "Print :CFBundleShortVersionString", plist,
  ]).catch(() => ({ stdout: "" }));
  return String(stdout).trim() || null;
}

export async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function publicLifecycleHost(snapshot) {
  const { privateAccountPair: _privateAccountPair, paths: _paths, ...publicSnapshot } = snapshot;
  return publicSnapshot;
}
