import { webSocketLane, isTerminalResponseEvent } from "./websocket-transport.mjs";

function createWebSocketObservationQueue() {
  const lanes = new Map();
  return {
    add(streamId, observation, { onAccepted = () => {}, onRejected = () => {} } = {}) {
      const key = webSocketLane(streamId);
      const entry = { key, observation, onAccepted, onRejected, routeSettled: false };
      const queue = lanes.get(key) ?? [];
      queue.push(entry);
      lanes.set(key, queue);
      return entry;
    },
    accept(payload) {
      if (!payload || typeof payload !== "object") return;
      const key = webSocketLane(payload.stream_id);
      const queue = lanes.get(key);
      const entry = queue?.[0];
      if (!entry) return;
      if (!entry.routeSettled && isAcceptedResponseEvent(payload.type)) {
        entry.routeSettled = true;
        entry.onAccepted();
      }
      entry.observation.recordPayload(payload);
      if (!isTerminalResponseEvent(payload.type)) return;
      if (!entry.routeSettled) {
        entry.routeSettled = true;
        entry.onRejected();
      }
      if (["response.completed", "response.incomplete"].includes(payload.type)) {
        entry.observation.finish();
      } else {
        entry.observation.abort();
      }
      queue.shift();
      if (queue.length === 0) lanes.delete(key);
    },
    remove(entry) {
      const queue = lanes.get(entry.key);
      if (!queue) return;
      const index = queue.indexOf(entry);
      if (index >= 0) queue.splice(index, 1);
      if (!entry.routeSettled) {
        entry.routeSettled = true;
        entry.onRejected();
      }
      entry.observation.abort();
      if (queue.length === 0) lanes.delete(entry.key);
    },
    abortAll() {
      for (const queue of lanes.values()) {
        for (const entry of queue) {
          if (!entry.routeSettled) {
            entry.routeSettled = true;
            entry.onRejected();
          }
          entry.observation.abort();
        }
      }
      lanes.clear();
    },
  };
}

function ignoredResponseObservation() {
  return {
    markResponseStarted() {},
    recordPayload() {},
    finish() {},
    abort() {},
  };
}

function isAcceptedResponseEvent(type) {
  return typeof type === "string" && type.startsWith("response.") &&
    type !== "response.failed";
}

export { createWebSocketObservationQueue, ignoredResponseObservation };
