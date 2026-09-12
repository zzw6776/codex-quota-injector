// Keep output timing separate from tool execution and from the token ledger.
// The server currently supplies response-level usage, not per-item usage.
export function normalizeOutputPhases(value) {
  if (!Array.isArray(value)) return null;
  return value.map((phase) => ({
    kind: ["text", "tool"].includes(phase?.kind) ? phase.kind : "unknown",
    textPhaseIndex: Number.isInteger(phase?.textPhaseIndex) && phase.textPhaseIndex >= 0
      ? phase.textPhaseIndex : null,
    startLatencyMs: finiteDuration(phase?.startLatencyMs),
    durationMs: finiteDuration(phase?.durationMs),
    ...(Number(phase?.outputSpeed) > 0 ? { outputSpeed: Number(phase.outputSpeed) } : {}),
  }));
}

export function generationSpeedWindow(sample) {
  const phases = normalizeOutputPhases(sample?.outputPhases);
  if (phases === null) {
    // Preserve valid historical pure-text metrics; never infer missing tool
    // generation timing from a later local execution duration.
    if (!sample?.hasVisibleText) return { durationMs: 0, reason: "no-visible-text" };
    if (sample?.hasNonTextOutput) return { durationMs: 0, reason: "unattributed-output" };
    const durationMs = finiteDuration(sample?.generationDurationMs) ?? 0;
    return { durationMs, reason: durationMs > 0 ? null : "insufficient-data" };
  }
  if (!sample.outputPhasesComplete || phases.length === 0 || phases.some((phase) =>
    phase.kind === "unknown" || phase.startLatencyMs == null || !(phase.durationMs > 0))) {
    return { durationMs: 0, reason: "insufficient-data" };
  }
  // Parallel tool streams can overlap. Count elapsed generation time once,
  // while still counting every output token once at the request level.
  const intervals = phases.map((phase) => [phase.startLatencyMs, phase.startLatencyMs + phase.durationMs])
    .sort((left, right) => left[0] - right[0]);
  let durationMs = 0;
  let end = -Infinity;
  for (const [start, nextEnd] of intervals) {
    durationMs += Math.max(0, nextEnd - Math.max(start, end));
    end = Math.max(end, nextEnd);
  }
  return { durationMs, reason: durationMs > 0 ? null : "insufficient-data" };
}

export function assignOutputPhaseSpeed(detail, speed) {
  if (!Array.isArray(detail?.outputPhases)) return;
  for (const phase of detail.outputPhases) delete phase.outputSpeed;
  // No proportional estimates: aggregate usage can be assigned to a child
  // only when that child is the entire measured response output.
  if (detail.outputPhasesComplete && detail.outputPhases.length === 1 && speed > 0) {
    detail.outputPhases[0].outputSpeed = speed;
  }
}

function finiteDuration(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}
