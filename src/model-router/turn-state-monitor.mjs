import { nonEmptyString } from "./contract.mjs";
import { turnStateSummaries } from "./turn-state.mjs";
import { EXPECTED_CODEX_TURN_STATE_BYTES } from "../relay-contract.mjs";

const MAX_TRACKED_THREADS = 256;

function unknownViewModel() {
  return {
    status: "unknown",
    expectedByteLength: EXPECTED_CODEX_TURN_STATE_BYTES,
    byteLength: null,
    model: null,
    observedAt: null,
  };
}

class CodexTurnStateMonitor {
  constructor({ clock = Date.now } = {}) {
    this.clock = clock;
    this.byThread = new Map();
    this.listeners = new Set();
  }

  onChange(listener) {
    if (typeof listener !== "function") return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  observe(context, value, prefix = "") {
    if (context?.target?.kind !== "official") return false;
    const threadId = nonEmptyString(context.threadId);
    if (!threadId) return false;
    const states = turnStateSummaries(value, prefix)
      .filter((state) => state.field.toLowerCase().split(".").at(-1) === "x-codex-turn-state");
    const state = states.at(-1);
    if (!state) return false;
    const view = {
      status: state.byteLength === EXPECTED_CODEX_TURN_STATE_BYTES ? "match" : "mismatch",
      expectedByteLength: EXPECTED_CODEX_TURN_STATE_BYTES,
      byteLength: state.byteLength,
      model: nonEmptyString(context.model),
      observedAt: this.clock(),
    };
    this.byThread.delete(threadId);
    this.byThread.set(threadId, view);
    while (this.byThread.size > MAX_TRACKED_THREADS) {
      this.byThread.delete(this.byThread.keys().next().value);
    }
    for (const listener of this.listeners) {
      try { listener(view, threadId); } catch {}
    }
    return true;
  }

  getViewModel(threadId) {
    const normalized = nonEmptyString(threadId);
    return normalized && this.byThread.has(normalized)
      ? { ...this.byThread.get(normalized) }
      : unknownViewModel();
  }

  clear() {
    if (this.byThread.size === 0) return;
    this.byThread.clear();
    for (const listener of this.listeners) {
      try { listener(unknownViewModel(), null); } catch {}
    }
  }
}

function withTurnStateObservation(observation, monitor, context) {
  return {
    recordPayload(payload) {
      monitor.observe(context, payload);
      observation.recordPayload(payload);
    },
    finish() { observation.finish(); },
    abort() { observation.abort(); },
  };
}

export {
  CodexTurnStateMonitor,
  EXPECTED_CODEX_TURN_STATE_BYTES,
  withTurnStateObservation,
};
