import { WINDOWS_NATIVE, WSL_NATIVE } from "../test-runtime-targets.mjs";

function publicHostEvidence(host, extra = {}) {
  return {
    codexPids: host.codexPids,
    hostHealth: host.hostHealth ?? host.readiness.hostHealth,
    ...(host.taskToolsActivation ? { taskToolsActivation: host.taskToolsActivation } : {}),
    appServerPids: host.appServerPids,
    injectorPids: host.injectorPids,
    relayPid: host.relay.pid,
    relayProtocol: host.relay.protocol,
    runtimeTarget: hostRuntimeTarget(host),
    relayMode: host.relay.wslNative ? "WSL 原生 Relay" : "Windows 原生 Relay",
    debugReady: host.readiness.debugReady,
    generationMatches: host.relay.generationMatches,
    ...extra,
  };
}

function hostRuntimeTarget(host) {
  return host?.relay?.wslNative ? WSL_NATIVE : WINDOWS_NATIVE;
}

function runtimeModeMatches(host, runtimeTarget) {
  return hostRuntimeTarget(host) === runtimeTarget;
}

function assertSamePids(left, right, message) {
  if (!samePids(left, right)) throw new Error(message);
}

function samePids(left, right) {
  return JSON.stringify([...(left ?? [])].sort((a, b) => a - b)) ===
    JSON.stringify([...(right ?? [])].sort((a, b) => a - b));
}

export { publicHostEvidence, hostRuntimeTarget, runtimeModeMatches, samePids, assertSamePids };
