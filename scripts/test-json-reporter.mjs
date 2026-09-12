// A durable event log survives a failing test worker and is independent of Codex.
export default async function* reporter(source) {
  for await (const event of source) {
    if (!["test:pass", "test:fail", "test:summary", "test:diagnostic"].includes(event.type)) continue;
    const error = event.data.details?.error;
    yield JSON.stringify({ type: event.type, ...event.data,
      ...(error ? { details: { ...event.data.details, error: { message: error.message, stack: error.stack, failureType: error.failureType } } } : {}) }) + "\n";
  }
}
