import { inspect } from "node:util";

// Emit scheduling events immediately: completion-only output hides the file
// whose worker is stuck, including workers kept alive by a leaked timer.
export default async function* reporter(source) {
  for await (const { type, data } of source) {
    const stamp = new Date().toISOString();
    const label = { "test:dequeue": "START", "test:pass": "PASS", "test:fail": "FAIL" }[type];
    if (label) {
      const location = data.file ? ` ${data.file}:${data.line ?? 0}` : "";
      const duration = data.details?.duration_ms;
      const outcome = data.skip ? " SKIP" : data.todo ? " TODO" : "";
      yield `[${stamp}] ${label}${outcome} ${data.name}${location}${duration == null ? "" : ` (${duration} ms)`}\n`;
      if (data.details?.error) yield `${inspect(data.details.error, { depth: 5, colors: false })}\n`;
    } else if (["test:stdout", "test:stderr", "test:diagnostic"].includes(type)) {
      yield `[${stamp}] ${type} ${data.message}\n`;
    } else if (type === "test:summary") {
      yield `[${stamp}] SUMMARY ${JSON.stringify(data)}\n`;
    }
  }
}
