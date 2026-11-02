import { readFile, writeFile } from "node:fs/promises";
import { inspectCodexShutdownReadiness } from "../lifecycle-shutdown-gate.mjs";

// Keep a record of every active turn seen while downloading/waiting, so an idle
// observation cannot hide a terminal event whose SQLite projection is behind.
export const inspectUpdateHistory = inspectCodexShutdownReadiness;

export async function runUpdateHistoryProbe() {
  const path = process.env.CODEX_QUOTA_UPDATE_CONTROL;
  const control = JSON.parse(await readFile(path, "utf8"));
  const tracked = JSON.parse(await readFile(`${path}.history`, "utf8").catch(() => "[]"));
  const result = await inspectUpdateHistory({ ...control, ...control.wslDirectories }, tracked);
  await writeFile(`${path}.history`, JSON.stringify(result.tracked), { mode: 0o600 });
  console.log(JSON.stringify(result));
}
