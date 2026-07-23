export class CdpClient {
  constructor(webSocketDebuggerUrl, { connectTimeoutMs = 5_000, requestTimeoutMs = 5_000 } = {}) {
    this.url = webSocketDebuggerUrl;
    this.connectTimeoutMs = connectTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  get isConnected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  async connect() {
    if (this.isConnected) return;
    const socket = new WebSocket(this.url);
    this.socket = socket;
    try {
      await new Promise((resolve, reject) => {
        const finish = (callback, value) => {
          clearTimeout(timer);
          socket.removeEventListener("open", onOpen);
          socket.removeEventListener("error", onError);
          socket.removeEventListener("close", onClose);
          callback(value);
        };
        const onOpen = () => finish(resolve);
        const onError = () => finish(reject, new Error("CDP connection failed"));
        const onClose = () => finish(reject, new Error("CDP connection closed before ready"));
        const timer = setTimeout(() => {
          finish(reject, new Error(`CDP connection timed out after ${this.connectTimeoutMs}ms`));
          socket.close();
        }, this.connectTimeoutMs);
        socket.addEventListener("open", onOpen, { once: true });
        socket.addEventListener("error", onError, { once: true });
        socket.addEventListener("close", onClose, { once: true });
      });
    } catch (error) {
      if (this.socket === socket) this.socket = null;
      try {
        socket.close();
      } catch {
        // Socket may already be closed by the runtime.
      }
      throw error;
    }
    socket.addEventListener("message", (event) => this.#handle(event.data));
    socket.addEventListener("close", () => {
      if (this.socket === socket) this.socket = null;
      this.#rejectPending(new Error("CDP connection closed"));
    });
  }

  request(method, params = {}) {
    if (!this.isConnected) {
      throw new Error("CDP is not connected");
    }
    const id = this.nextId++;
    const socket = this.socket;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.reject(new Error(`CDP request timed out after ${this.requestTimeoutMs}ms: ${method}`));
        if (this.socket === socket) this.close();
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  async evaluate(expression) {
    const response = await this.request("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text ??
          "Runtime.evaluate failed",
      );
    }
    return response.result?.value;
  }

  close() {
    const socket = this.socket;
    this.socket = null;
    this.#rejectPending(new Error("CDP connection closed"));
    try {
      socket?.close();
    } catch {
      // Socket may already be closed by the runtime.
    }
  }

  #handle(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!("id" in message)) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(message.error.message ?? "CDP request failed"));
    } else {
      pending.resolve(message.result);
    }
  }

  #rejectPending(error) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }
}

export async function findCodexTarget(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`CDP target list returned ${response.status}`);
  const targets = await response.json();
  return (
    targets.find(
      (target) =>
        target.type === "page" &&
        typeof target.url === "string" &&
        target.url.startsWith("app://") &&
        target.webSocketDebuggerUrl,
    ) ?? null
  );
}
