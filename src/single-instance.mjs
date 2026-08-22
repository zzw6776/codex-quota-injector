import { execFile } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { promisify } from "node:util";

const SINGLE_INSTANCE_PORT = 49_229;
const TAKEOVER_TIMEOUT_MS = 3_000;
const LISTEN_RETRY_DELAY_MS = 50;
const INSTANCE_MODES = new Set(["dev", "formal"]);
const UNRECOGNIZED_TAKEOVER_CODE = "CODEX_QUOTA_TAKEOVER_UNRECOGNIZED";
const execFileAsync = promisify(execFile);

export class SingleInstanceTakeoverError extends Error {
  constructor(cause) {
    super(`现有注入器未响应重启接管请求: ${cause?.message ?? cause}`);
    this.name = "SingleInstanceTakeoverError";
    this.code = "CODEX_QUOTA_TAKEOVER_UNRESPONSIVE";
  }
}

export async function acquireSingleInstance({
  mode = "dev",
  version = "0.0.0",
  explicitStart = false,
  onTakeover,
} = {}) {
  const owner = {
    mode: normalizeMode(mode),
    version: normalizeVersion(version),
    explicitStart: Boolean(explicitStart),
  };
  let takeoverStarted = false;
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.setTimeout(TAKEOVER_TIMEOUT_MS, () => socket.destroy());
    socket.once("data", (data) => {
      const request = parseTakeoverRequest(data);
      if (!request) {
        socket.end("invalid\n");
        return;
      }
      const replace = shouldReplace(owner, request);
      socket.end(`${replace ? "replace" : "keep"}\n`);
      if (!replace || takeoverStarted) return;
      takeoverStarted = true;
      socket.once("close", () => {
        Promise.resolve(onTakeover?.(request)).catch(() => undefined);
      });
    });
  });
  server.unref();

  try {
    await listenServer(server);
    return server;
  } catch (error) {
    if (error?.code !== "EADDRINUSE") throw error;
  }

  let decision;
  try {
    decision = await requestTakeover(owner);
  } catch (cause) {
    if (cause?.code !== UNRECOGNIZED_TAKEOVER_CODE) {
      throw new SingleInstanceTakeoverError(cause);
    }
    try {
      await replaceUnrecognizedOwner();
      decision = "replace";
    } catch (forceCause) {
      throw new SingleInstanceTakeoverError(forceCause);
    }
  }
  if (decision !== "replace") return null;

  const deadline = Date.now() + TAKEOVER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await listenServer(server);
      return server;
    } catch (error) {
      if (error?.code !== "EADDRINUSE") throw error;
      await delay(LISTEN_RETRY_DELAY_MS);
    }
  }
  throw new SingleInstanceTakeoverError(
    new Error(`等待旧注入器释放单实例锁超时（${TAKEOVER_TIMEOUT_MS}ms）`),
  );
}

export function closeSingleInstance(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

export function compareVersions(left, right) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  if (!leftParts || !rightParts) return 0;
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] > rightParts[index] ? 1 : -1;
    }
  }
  return 0;
}

function shouldReplace(owner, requester) {
  if (!requester.explicitStart) return false;
  if (!INSTANCE_MODES.has(owner.mode) || !INSTANCE_MODES.has(requester.mode)) return false;
  if (requester.mode === "formal" && owner.mode === "dev") return true;
  // A development launcher is an explicit request to run the checked-out
  // source. It must replace an older process from the same checkout even
  // before the package version changes.
  if (requester.mode === "dev" && owner.mode === "dev") return true;
  if (requester.mode === "dev" && owner.mode === "formal") return false;
  return compareVersions(requester.version, owner.version) > 0;
}

function parseTakeoverRequest(data) {
  const text = String(data ?? "").trim();
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    if (value?.type !== "takeover") return null;
    return {
      mode: normalizeMode(value.mode),
      version: normalizeVersion(value.version),
      explicitStart: value.explicitStart === true,
    };
  } catch {
    return null;
  }
}

function requestTakeover(owner) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: SINGLE_INSTANCE_PORT });
    let response = "";
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      callback(value);
    };
    const timer = setTimeout(() => {
      finish(reject, new Error(`接管请求超时（${TAKEOVER_TIMEOUT_MS}ms）`));
    }, TAKEOVER_TIMEOUT_MS);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(JSON.stringify({
      type: "takeover",
      mode: owner.mode,
      version: owner.version,
      explicitStart: owner.explicitStart,
    }) + "\n"));
    socket.on("data", (data) => {
      response += data;
    });
    socket.once("end", () => {
      const result = response.trim();
      if (result === "replace" || result === "keep") {
        finish(resolve, result);
      } else {
        const error = new Error(
          `现有实例返回了无法识别的接管结果: ${result || "空响应"}`,
        );
        error.code = UNRECOGNIZED_TAKEOVER_CODE;
        finish(reject, error);
      }
    });
    socket.once("error", (error) => finish(reject, error));
  });
}

async function replaceUnrecognizedOwner() {
  const owners = await findListeningOwners();
  const candidates = owners.filter(({ pid }) => pid !== process.pid);
  if (candidates.length === 0) return;

  const unknownOwners = candidates.filter((owner) => !isLikelyInjectorOwner(owner));
  if (unknownOwners.length > 0) {
    const details = unknownOwners
      .map(({ pid, name, commandLine }) => `${pid} ${name || commandLine || "unknown"}`)
      .join(", ");
    throw new Error(`49229 端口占用者不是可确认的注入器，拒绝强制终止: ${details}`);
  }

  console.warn(
    `[single-instance] 旧注入器接管协议无法识别，正在终止旧实例: ${candidates
      .map(({ pid }) => pid).join(", ")}`,
  );
  for (const { pid } of candidates) {
    await terminateProcess(pid);
  }
}

async function findListeningOwners() {
  if (process.platform === "win32") {
    const script = `
$owners=@(
  Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort ${SINGLE_INSTANCE_PORT} -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object {
      $ownerProcessId=[int]$_;
      Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f $ownerProcessId) |
        Select-Object ProcessId,Name,ExecutablePath,CommandLine
    }
);
if ($owners.Count -gt 0) { $owners | ConvertTo-Json -Compress }
`;
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
    );
    return parseProcessInfo(stdout);
  }

  if (process.platform === "darwin") {
    const { stdout } = await execFileAsync(
      "lsof",
      ["-nP", "-t", `-iTCP:${SINGLE_INSTANCE_PORT}`, "-sTCP:LISTEN"],
    ).catch((error) => {
      if (error?.code === 1) return { stdout: "" };
      throw error;
    });
    const pids = String(stdout)
      .split(/\r?\n/)
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value > 0);
    return Promise.all(pids.map(async (pid) => {
      const processInfo = await execFileAsync("ps", ["-p", String(pid), "-o", "pid=,comm=,args="])
        .catch(() => ({ stdout: "" }));
      const commandLine = String(processInfo.stdout).trim();
      return { pid, name: commandLine, executablePath: commandLine, commandLine };
    }));
  }

  return [];
}

function parseProcessInfo(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return [];
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`无法读取 49229 端口占用进程信息: ${error.message}`);
  }
  const records = Array.isArray(value) ? value : [value];
  return records
    .map((record) => ({
      pid: Number(record?.ProcessId),
      name: String(record?.Name ?? ""),
      executablePath: String(record?.ExecutablePath ?? ""),
      commandLine: String(record?.CommandLine ?? ""),
    }))
    .filter(({ pid }) => Number.isInteger(pid) && pid > 0);
}

function isLikelyInjectorOwner(owner) {
  const identity = [owner.name, owner.executablePath, owner.commandLine]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return identity.includes("codex quota injector") ||
    identity.includes("codex-quota-injector") ||
    /src[\\/]launcher\.mjs/.test(identity);
}

async function terminateProcess(pid) {
  if (process.platform === "win32") {
    await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
    });
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function listenServer(server) {
  return new Promise((resolve, reject) => {
    const onListening = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      server.off("listening", onListening);
      server.off("error", onError);
    };
    server.once("listening", onListening);
    server.once("error", onError);
    server.listen(SINGLE_INSTANCE_PORT, "127.0.0.1");
  });
}

function parseVersion(value) {
  const match = String(value ?? "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? match.slice(1, 4).map(Number) : null;
}

function normalizeMode(value) {
  const mode = String(value ?? "").trim();
  return INSTANCE_MODES.has(mode) ? mode : "unknown";
}

function normalizeVersion(value) {
  return String(value ?? "").trim() || "0.0.0";
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
