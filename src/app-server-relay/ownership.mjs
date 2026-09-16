import { RELAY_PROTOCOL_VERSION, RELAY_STATE_VERSION } from "../relay-contract.mjs";
import { readFile, unlink, mkdir, writeFile, stat, rmdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { readJson, PRIMARY_APP_SERVER_ENV, RELAY_STATE_LOCK_RETRY_MS, RELAY_STATE_LOCK_TIMEOUT_MS, RELAY_STATE_LOCK_STALE_MS } from "./contract.mjs";

async function claimRelayState(path, generation, processIdentity = null) {
  if (!path) return false;
  const resolvedGeneration = generation ??
    process.env.CODEX_QUOTA_BRIDGE_GENERATION ??
    `usage-events-v${RELAY_PROTOCOL_VERSION}`;
  const identity = processIdentity ?? await currentRelayProcessIdentity(
    process.env.CODEX_QUOTA_WSL_NATIVE === "1",
  );
  return withRelayStateLock(path, async () => {
    const current = await readJson(path);
    if (current?.generation === resolvedGeneration &&
      current?.pid !== identity.pid && await relayStateProcessIsAlive(current)) {
      return false;
    }
    const now = Date.now();
    const state = {
      version: RELAY_STATE_VERSION,
      pid: identity.pid,
      generation: resolvedGeneration,
      processStartedAt: identity.processStartedAt,
      ...(identity.bootId ? { bootId: identity.bootId } : {}),
      ...(identity.processStartTicks != null
        ? { processStartTicks: identity.processStartTicks }
        : {}),
      startedAt: current?.pid === identity.pid && Number.isFinite(Number(current.startedAt))
        ? Number(current.startedAt)
        : now,
      updatedAt: now,
    };
    await writeJsonAtomically(path, state, identity.pid);
    return true;
  });
}

async function currentRelayProcessIdentity(wslNative) {
  const processStartedAt = Math.max(
    0,
    Math.floor(Date.now() - process.uptime() * 1000),
  );
  const wslProcessIdentity = wslNative ? await readCurrentLinuxProcessIdentity() : null;
  return {
    pid: process.pid,
    processStartedAt,
    ...(wslProcessIdentity ?? {}),
  };
}

async function readCurrentLinuxProcessIdentity() {
  const [bootIdText, statText] = await Promise.all([
    readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    readFile(`/proc/${process.pid}/stat`, "utf8"),
  ]);
  const bootId = String(bootIdText).trim();
  const processStartTicks = parseLinuxProcessStartTicks(statText);
  if (!bootId || !Number.isSafeInteger(processStartTicks) || processStartTicks < 0) {
    throw new Error("无法读取 WSL 中继的稳定进程身份");
  }
  return { bootId, processStartTicks };
}

function parseLinuxProcessStartTicks(statText) {
  const text = String(statText ?? "").trim();
  const commandEnd = text.lastIndexOf(")");
  if (commandEnd < 0) return null;
  // `/proc/<pid>/stat` 在 comm 字段后从第 3 字段 state 继续；starttime
  // 是第 22 字段，因此对应剩余字段中的索引 19。
  const fields = text.slice(commandEnd + 1).trim().split(/\s+/);
  const startTicks = Number(fields[19]);
  return Number.isSafeInteger(startTicks) && startTicks >= 0 ? startTicks : null;
}

function shouldPublishHostState(_args, environment = process.env) {
  // Only the desktop launch bridge owns these process-global files. Auxiliary
  // app-servers are not guaranteed to retain their parent's --listen argument;
  // inferring ownership from argv lets a short-lived task replace the desktop
  // Relay PID and leave host health permanently stale after it exits.
  return String(environment?.[PRIMARY_APP_SERVER_ENV] ?? "").trim() === "1";
}

async function removeRelayState(path, processIdentity = null) {
  if (!path) return;
  try {
    const identity = processIdentity ?? { pid: process.pid };
    await withRelayStateLock(path, async () => {
      const state = await readJson(path);
      if (state?.pid === identity.pid) await unlink(path).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    });
  } catch (error) {
    if (error.code !== "ENOENT") console.error(`清理模型中继状态失败: ${error.message}`);
  }
}

async function relayStateProcessIsAlive(state) {
  const pid = Number(state?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === "linux" && state?.bootId &&
    Number.isSafeInteger(Number(state?.processStartTicks))) {
    try {
      const [bootIdText, statText] = await Promise.all([
        readFile("/proc/sys/kernel/random/boot_id", "utf8"),
        readFile(`/proc/${pid}/stat`, "utf8"),
      ]);
      return String(bootIdText).trim() === String(state.bootId) &&
        parseLinuxProcessStartTicks(statText) === Number(state.processStartTicks);
    } catch {
      return false;
    }
  }
  return true;
}

async function withRelayStateLock(path, action) {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + RELAY_STATE_LOCK_TIMEOUT_MS;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      try {
        await writeFile(join(lockPath, "created-at"), String(Date.now()), { flag: "wx" });
      } catch (error) {
        await removeRelayStateLock(lockPath);
        throw error;
      }
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const lockAge = await readLockAge(lockPath);
      if (lockAge != null && lockAge >= RELAY_STATE_LOCK_STALE_MS) {
        await removeRelayStateLock(lockPath);
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`等待状态锁超时: ${lockPath}`);
      await new Promise((resolve) => setTimeout(resolve, RELAY_STATE_LOCK_RETRY_MS));
    }
  }
  try {
    return await action();
  } finally {
    await removeRelayStateLock(lockPath);
  }
}

async function readLockAge(path) {
  try {
    const value = Number(await readFile(join(path, "created-at"), "utf8"));
    return Number.isFinite(value) ? Date.now() - value : null;
  } catch {
    const details = await stat(path).catch(() => null);
    return details ? Date.now() - details.mtimeMs : null;
  }
}

async function removeRelayStateLock(path) {
  await unlink(join(path, "created-at")).catch(() => undefined);
  await rmdir(path).catch(() => undefined);
}

async function writeJsonAtomically(path, value, pid) {
  const temporaryPath = `${path}.${pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export { claimRelayState, currentRelayProcessIdentity, shouldPublishHostState, removeRelayState };
