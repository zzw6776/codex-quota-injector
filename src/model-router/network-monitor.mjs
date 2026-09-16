import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import { nonEmptyString, MAX_NETWORK_SAMPLES } from "./contract.mjs";

function classifyNetworkLatency(previousSamples, latencyMs) {
  const current = Number(latencyMs);
  if (!Number.isFinite(current) || current < 0) return "fluctuating";
  const samples = (Array.isArray(previousSamples) ? previousSamples : [])
    .map(Number)
    .filter((value) => Number.isFinite(value) && value >= 0)
    .slice(-9)
    .sort((left, right) => left - right);
  if (samples.length < 3) return "stable";
  const middle = Math.floor(samples.length / 2);
  const baseline = samples.length % 2 === 1
    ? samples[middle]
    : (samples[middle - 1] + samples[middle]) / 2;
  const threshold = Math.max(baseline * 3, baseline + 100);
  return current >= threshold ? "fluctuating" : "stable";
}

function unavailableNetworkState() {
  return {
    status: "unavailable",
    latencyMs: null,
    sampledAt: null,
    connectionId: null,
  };
}

function normalizeNetworkState(value) {
  const status = [
    "unavailable",
    "measuring",
    "stable",
    "fluctuating",
    "reconnecting",
    "reconnected",
  ].includes(value?.status)
    ? value.status
    : "unavailable";
  const latency = value?.latencyMs == null ? Number.NaN : Number(value.latencyMs);
  const sampledAt = value?.sampledAt == null ? Number.NaN : Number(value.sampledAt);
  return {
    status,
    latencyMs: Number.isFinite(latency) && latency >= 0 ? Math.round(latency) : null,
    sampledAt: Number.isFinite(sampledAt) && sampledAt > 0 ? sampledAt : null,
    connectionId: nonEmptyString(value?.connectionId),
  };
}

class RouterNetworkMonitor {
  constructor({ networkProbeIntervalMs, networkProbeTimeoutMs }) {
    this.networkConnections = new Map();
    this.networkListeners = new Set();
    this.networkState = unavailableNetworkState();
    this.networkRebuildPending = false;
    this.networkProbeIntervalMs = Math.max(10, Number(networkProbeIntervalMs) || 0);
    this.networkProbeTimeoutMs = Math.max(10, Number(networkProbeTimeoutMs) || 0);
  }

  onChange(listener) {
    if (typeof listener !== "function") return () => {};
    this.networkListeners.add(listener);
    return () => this.networkListeners.delete(listener);
  }

  getViewModel() { return { ...this.networkState }; }

  close() {
    this.stopAllNetworkMonitors({ notify: false });
    this.networkListeners.clear();
  }

  startNetworkMonitor(socket, connectionId) {
    const normalizedConnectionId = nonEmptyString(connectionId);
    if (!normalizedConnectionId || socket.readyState !== WebSocket.OPEN) return;
    const rebuilt = this.networkRebuildPending;
    this.networkRebuildPending = false;
    const state = {
      connectionId: normalizedConnectionId,
      socket,
      samples: [],
      interval: null,
      pending: null,
      onPong: null,
      rebuilt,
      current: {
        status: rebuilt ? "reconnected" : "measuring",
        latencyMs: null,
        sampledAt: Date.now(),
        connectionId: normalizedConnectionId,
      },
    };
    state.onPong = (payload) => {
      const pending = state.pending;
      if (!pending || Buffer.from(payload).toString("utf8") !== pending.payload) return;
      clearTimeout(pending.timeout);
      state.pending = null;
      const sampledAt = Date.now();
      const latencyMs = Math.max(1, sampledAt - pending.startedAt);
      const previousLatencies = state.samples
        .map((sample) => Number(sample.latencyMs))
        .filter((value) => Number.isFinite(value) && value >= 0);
      const sample = {
        status: state.rebuilt
          ? "reconnected"
          : classifyNetworkLatency(previousLatencies, latencyMs),
        latencyMs,
        sampledAt,
        connectionId: normalizedConnectionId,
      };
      state.rebuilt = false;
      state.samples.push(sample);
      if (state.samples.length > MAX_NETWORK_SAMPLES) {
        state.samples.splice(0, state.samples.length - MAX_NETWORK_SAMPLES);
      }
      state.current = sample;
      this.#setNetworkState(sample);
    };
    socket.on("pong", state.onPong);
    this.networkConnections.set(normalizedConnectionId, state);
    this.#setNetworkState(state.current);
    this.#probeNetworkConnection(state);
    state.interval = setInterval(
      () => this.#probeNetworkConnection(state),
      this.networkProbeIntervalMs,
    );
    state.interval.unref?.();
  }

  #probeNetworkConnection(state) {
    if (!state || state.pending || state.socket.readyState !== WebSocket.OPEN) return;
    const payload = `cqi-rtt:${randomBytes(8).toString("hex")}`;
    const startedAt = Date.now();
    const timeout = setTimeout(() => {
      if (state.pending?.payload !== payload) return;
      state.pending = null;
      const sample = {
        status: "fluctuating",
        latencyMs: null,
        sampledAt: Date.now(),
        connectionId: state.connectionId,
      };
      state.samples.push(sample);
      if (state.samples.length > MAX_NETWORK_SAMPLES) {
        state.samples.splice(0, state.samples.length - MAX_NETWORK_SAMPLES);
      }
      state.current = sample;
      this.#setNetworkState(sample);
    }, this.networkProbeTimeoutMs);
    timeout.unref?.();
    state.pending = { payload, startedAt, timeout };
    try {
      state.socket.ping(payload);
    } catch {
      clearTimeout(timeout);
      state.pending = null;
      const sample = {
        status: "fluctuating",
        latencyMs: null,
        sampledAt: Date.now(),
        connectionId: state.connectionId,
      };
      state.samples.push(sample);
      if (state.samples.length > MAX_NETWORK_SAMPLES) {
        state.samples.splice(0, state.samples.length - MAX_NETWORK_SAMPLES);
      }
      state.current = sample;
      this.#setNetworkState(sample);
    }
  }

  stopNetworkMonitor(connectionId, { unexpected = false } = {}) {
    const normalizedConnectionId = nonEmptyString(connectionId);
    const state = normalizedConnectionId
      ? this.networkConnections.get(normalizedConnectionId)
      : null;
    if (state) {
      clearInterval(state.interval);
      if (state.pending) clearTimeout(state.pending.timeout);
      state.socket.off("pong", state.onPong);
      this.networkConnections.delete(normalizedConnectionId);
    }
    if (this.networkConnections.size > 0) {
      const current = [...this.networkConnections.values()]
        .sort((left, right) => right.current.sampledAt - left.current.sampledAt)[0]?.current;
      if (current) this.#setNetworkState(current);
      return;
    }
    if (unexpected) {
      this.networkRebuildPending = true;
      this.#setNetworkState({
        status: "reconnecting",
        latencyMs: null,
        sampledAt: Date.now(),
        connectionId: normalizedConnectionId,
      });
      return;
    }
    this.#setNetworkState(unavailableNetworkState());
  }

  stopAllNetworkMonitors({ notify = true } = {}) {
    for (const state of this.networkConnections.values()) {
      clearInterval(state.interval);
      if (state.pending) clearTimeout(state.pending.timeout);
      state.socket.off("pong", state.onPong);
    }
    this.networkConnections.clear();
    this.networkRebuildPending = false;
    if (notify) this.#setNetworkState(unavailableNetworkState());
    else this.networkState = unavailableNetworkState();
  }

  #setNetworkState(value) {
    const next = normalizeNetworkState(value);
    if (JSON.stringify(next) === JSON.stringify(this.networkState)) return;
    this.networkState = next;
    for (const listener of this.networkListeners) {
      try {
        listener({ ...next });
      } catch (error) {
        console.error(`[model-router] 网络状态监听器失败: ${error.message}`);
      }
    }
  }

  nearestNetworkSample(connectionId, timestamp) {
    const state = this.networkConnections.get(nonEmptyString(connectionId));
    if (!state || state.samples.length === 0) return null;
    const targetAt = Number(timestamp) || Date.now();
    const sample = [...state.samples].sort((left, right) =>
      Math.abs(left.sampledAt - targetAt) - Math.abs(right.sampledAt - targetAt))[0];
    return sample ? { ...sample } : null;
  }
}

export { RouterNetworkMonitor, classifyNetworkLatency };
