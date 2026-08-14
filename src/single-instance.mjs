import { createConnection, createServer } from "node:net";

const SINGLE_INSTANCE_PORT = 49_229;
const TAKEOVER_TIMEOUT_MS = 3_000;
const LISTEN_RETRY_DELAY_MS = 50;
const INSTANCE_MODES = new Set(["dev", "formal"]);

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
  onTakeover,
} = {}) {
  const owner = {
    mode: normalizeMode(mode),
    version: normalizeVersion(version),
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
    throw new SingleInstanceTakeoverError(cause);
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
  if (!INSTANCE_MODES.has(owner.mode) || !INSTANCE_MODES.has(requester.mode)) return false;
  if (requester.mode === "formal" && owner.mode === "dev") return true;
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
    }) + "\n"));
    socket.on("data", (data) => {
      response += data;
    });
    socket.once("end", () => {
      const result = response.trim();
      if (result === "replace" || result === "keep") {
        finish(resolve, result);
      } else {
        finish(reject, new Error("现有实例返回了无法识别的接管结果"));
      }
    });
    socket.once("error", (error) => finish(reject, error));
  });
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
