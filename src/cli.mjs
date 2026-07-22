import { access } from "node:fs/promises";
import { AppServerClient, DEFAULT_CODEX_BINARY, selectQuotaWindows, toWidgetQuotas } from "./app-server.mjs";
import { findCodexTarget } from "./cdp-client.mjs";
import { DEFAULT_PORT, runInjector } from "./injector.mjs";

const command = process.argv[2] ?? "doctor";
const port = Number(process.env.CODEX_QUOTA_CDP_PORT ?? DEFAULT_PORT);

try {
  switch (command) {
    case "doctor":
      await doctor(port);
      break;
    case "read-quota":
      await readQuota();
      break;
    case "inject":
      await runInjector({ port, once: process.argv.includes("--once") });
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function doctor(cdpPort) {
  await access(DEFAULT_CODEX_BINARY);
  console.log(`Codex binary: ${DEFAULT_CODEX_BINARY}`);
  try {
    const target = await findCodexTarget(cdpPort);
    console.log(target ? `CDP: ready (${target.url})` : "CDP: ready, Codex page not found");
  } catch {
    console.log(`CDP: unavailable on 127.0.0.1:${cdpPort}`);
  }
  const quota = await getQuota();
  console.log(`Quota: ${JSON.stringify(quota)}`);
}

async function readQuota() {
  const quota = await getQuota();
  console.log(JSON.stringify(quota, null, 2));
}

async function getQuota() {
  const client = new AppServerClient();
  try {
    const response = await client.readRateLimits();
    return toWidgetQuotas(selectQuotaWindows(response));
  } finally {
    client.close();
  }
}
