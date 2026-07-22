export class CdpClient {
  constructor(webSocketDebuggerUrl) {
    this.url = webSocketDebuggerUrl;
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
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    socket.addEventListener("message", (event) => this.#handle(event.data));
    socket.addEventListener("close", () => {
      if (this.socket === socket) this.socket = null;
      for (const { reject } of this.pending.values()) {
        reject(new Error("CDP connection closed"));
      }
      this.pending.clear();
    });
  }

  request(method, params = {}) {
    if (!this.isConnected) {
      throw new Error("CDP is not connected");
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.pending.delete(id);
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
    this.socket?.close();
    this.socket = null;
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
    if (message.error) {
      pending.reject(new Error(message.error.message ?? "CDP request failed"));
    } else {
      pending.resolve(message.result);
    }
  }
}

export async function findCodexTarget(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
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
