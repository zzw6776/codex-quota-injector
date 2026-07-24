import { createConnection, createServer } from "node:net";

const SINGLE_INSTANCE_PORT = 49_229;
const TAKEOVER_TIMEOUT_MS = 3_000;

export class SingleInstanceTakeoverError extends Error {
  constructor(cause) {
    super(`现有注入器未响应重启接管请求: ${cause?.message ?? cause}`);
    this.name = "SingleInstanceTakeoverError";
    this.code = "CODEX_QUOTA_TAKEOVER_UNRESPONSIVE";
  }
}

export async function acquireSingleInstance({ onTakeover } = {}) {
  let takeoverStarted = false;
  const server = createServer((socket) => {
    socket.setTimeout(TAKEOVER_TIMEOUT_MS, () => socket.destroy());
    socket.once("data", (data) => {
      if (String(data).trim() !== "takeover") {
        socket.end("invalid");
        return;
      }
      socket.end("ok");
      if (takeoverStarted) return;
      takeoverStarted = true;
      socket.once("close", () => {
        Promise.resolve(onTakeover?.()).catch(() => undefined);
      });
    });
  });
  server.unref();
  return new Promise((resolve, reject) => {
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        requestTakeover().then(() => resolve(null)).catch((cause) => {
          reject(new SingleInstanceTakeoverError(cause));
        });
      } else {
        reject(error);
      }
    });
    server.listen(SINGLE_INSTANCE_PORT, "127.0.0.1", () => resolve(server));
  });
}

export function closeSingleInstance(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function requestTakeover() {
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
    socket.once("connect", () => socket.write("takeover\n"));
    socket.on("data", (data) => {
      response += data;
    });
    socket.once("end", () => {
      if (response.trim() === "ok") {
        finish(resolve);
      } else {
        finish(reject, new Error("现有实例拒绝了接管请求"));
      }
    });
    socket.once("error", (error) => finish(reject, error));
  });
}
