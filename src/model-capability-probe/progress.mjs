async function runProtocolProbeWithRetry(probe, { onRetry = null } = {}) {
  const first = await probe();
  if (first.ok || !isRetryableProbeFailure(first.failure)) return first;
  onRetry?.(first.failure);
  return probe();
}

function createProbeProgressReporter(onProgress) {
  const notify = typeof onProgress === "function" ? onProgress : null;
  let last = { current: 1, stage: "starting" };
  const report = (current, stage, message, extra = {}) => {
    last = { current, stage };
    if (!notify) return;
    try {
      notify({
        current,
        total: 8,
        stage,
        message,
        retry: extra.retry === true,
      });
    } catch {
      // 展示进度不能中断真实能力检测。
    }
  };
  report.retry = message => report(last.current, last.stage, message, { retry: true });
  report.stage = () => last.stage;
  return report;
}

function isRetryableProbeFailure(failure) {
  if (failure?.retryExhausted) return false;
  if (failure?.kind === "contract") return true;
  const status = Number(failure?.status) || 0;
  return status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
}

export { runProtocolProbeWithRetry, createProbeProgressReporter, isRetryableProbeFailure };
