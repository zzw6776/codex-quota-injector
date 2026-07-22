import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const DEFAULT_CODEX_BINARY =
  "/Applications/ChatGPT.app/Contents/Resources/codex";

export class AppServerClient {
  constructor({ binary = DEFAULT_CODEX_BINARY, requestTimeoutMs = 15_000 } = {}) {
    this.binary = binary;
    this.requestTimeoutMs = requestTimeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.process = null;
    this.stderr = [];
  }

  async start() {
    if (this.process) return;

    const child = spawn(this.binary, ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = child;

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderr.push(chunk);
      if (this.stderr.length > 20) this.stderr.shift();
    });

    child.on("exit", (code, signal) => {
      const reason = `app-server exited (code=${code}, signal=${signal ?? "none"})`;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(reason));
      }
      this.pending.clear();
      this.process = null;
    });

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.#handleLine(line));

    await this.request("initialize", {
      clientInfo: {
        name: "codex-quota-injector",
        title: "Codex Quota Injector",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [],
      },
    });
    this.notify("initialized");
  }

  notify(method, params) {
    this.#write(params === undefined ? { method } : { method, params });
  }

  request(method, params) {
    if (!this.process) throw new Error("app-server is not running");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`app-server request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.#write(params === undefined ? { id, method } : { id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async readRateLimits() {
    await this.start();
    return this.request("account/rateLimits/read", null);
  }

  close() {
    if (!this.process) return;
    this.process.kill("SIGTERM");
    this.process = null;
  }

  #write(message) {
    const stdin = this.process?.stdin;
    if (!stdin?.writable) throw new Error("app-server stdin is unavailable");
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (!("id" in message)) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(
        new Error(
          message.error.message ?? `app-server error ${message.error.code ?? "unknown"}`,
        ),
      );
      return;
    }
    pending.resolve(message.result);
  }
}

export function selectWeeklyWindow(response) {
  const uniqueWindows = collectUniqueWindows(response);

  if (uniqueWindows.length === 0) return null;
  return (
    uniqueWindows.find(
      (window) => Math.abs((window.windowDurationMins ?? 0) - 10_080) <= 1,
    ) ??
    uniqueWindows.reduce((longest, window) =>
      (window.windowDurationMins ?? 0) > (longest.windowDurationMins ?? 0)
        ? window
        : longest,
    )
  );
}

export function selectQuotaWindows(response) {
  const uniqueWindows = collectUniqueWindows(response);
  if (uniqueWindows.length === 0) return [];

  const preferredDurations = [300, 10_080];
  const preferred = preferredDurations
    .map((duration) =>
      uniqueWindows.find(
        (window) => Math.abs((window.windowDurationMins ?? 0) - duration) <= 1,
      ),
    )
    .filter(Boolean);

  if (preferred.length > 0) return preferred;
  return [
    uniqueWindows.reduce((longest, window) =>
      (window.windowDurationMins ?? 0) > (longest.windowDurationMins ?? 0)
        ? window
        : longest,
    ),
  ];
}

function collectUniqueWindows(response) {
  const snapshots = [];
  if (response?.rateLimits) snapshots.push(response.rateLimits);
  if (response?.rateLimitsByLimitId) {
    snapshots.push(...Object.values(response.rateLimitsByLimitId));
  }

  const uniqueWindows = [];
  const seen = new Set();
  for (const snapshot of snapshots) {
    for (const window of [snapshot?.primary, snapshot?.secondary]) {
      if (!window || !Number.isFinite(window.usedPercent)) continue;
      const key = `${window.windowDurationMins}:${window.resetsAt}:${window.usedPercent}`;
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueWindows.push(window);
    }
  }
  return uniqueWindows;
}

export function toWidgetQuota(window) {
  if (!window) return null;
  const usedPercent = clampPercent(window.usedPercent);
  return {
    label:
      Math.abs((window.windowDurationMins ?? 0) - 10_080) <= 1
        ? "weekly"
        : Math.abs((window.windowDurationMins ?? 0) - 300) <= 1
          ? "5-hour"
          : formatWindow(window.windowDurationMins),
    compactLabel:
      Math.abs((window.windowDurationMins ?? 0) - 10_080) <= 1
        ? "W"
        : formatWindow(window.windowDurationMins),
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetsAt: Number.isFinite(window.resetsAt) ? window.resetsAt : null,
  };
}

export function toWidgetQuotas(windows) {
  return { windows: windows.map(toWidgetQuota).filter(Boolean) };
}

function clampPercent(value) {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function formatWindow(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return "usage";
  if (minutes % 10_080 === 0) return `${minutes / 10_080}w`;
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

export { DEFAULT_CODEX_BINARY };
