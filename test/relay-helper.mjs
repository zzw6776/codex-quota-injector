import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { waitFor } from "./helpers.mjs";

export async function startTestRelay(t, {
  usagePathIsDirectory = false,
  deepSeekEnabled = false,
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "codex-relay-contract-"));
  let child;
  let completion;
  let lines;
  t.after(async () => {
    if (child) {
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 2_000);
      await completion;
      clearTimeout(timer);
      lines.close();
    }
    await rm(directory, { recursive: true, force: true });
  });
  const executable = join(directory, process.platform === "win32" ? "fixture-node.exe" : "fixture-node");
  // Keep dynamically linked Node beside its libraries; Windows can use a hard link.
  if (process.platform === "win32") {
    await link(process.execPath, executable).catch(() => copyFile(process.execPath, executable));
  } else {
    await symlink(process.execPath, executable);
  }
  const configPath = join(directory, "relay.json");
  const catalogPath = join(directory, "catalog.json");
  const providerSettingsPath = join(directory, "deepseek.json");
  const settingsPath = join(directory, "models.json");
  const usagePath = join(directory, "usage.jsonl");
  await mkdir(join(directory, "codex-home"));
  if (usagePathIsDirectory) await mkdir(usagePath);
  await writeFile(catalogPath, JSON.stringify({ models: [{ slug: "official" }] }));
  if (deepSeekEnabled) {
    await writeFile(providerSettingsPath, JSON.stringify({ enabled: true, apiKey: "test-only" }));
  }
  await writeFile(settingsPath, JSON.stringify({ platforms: [{
    id: "fixture", name: "Fixture", enabled: true, apiKey: "test-only",
    baseUrl: "http://127.0.0.1:1/v1/",
    models: ["custom-a", "custom-b", "custom-c"].map((id) => ({
      id, displayName: id, reasoningEfforts: ["low", "high"], defaultReasoningEffort: "low",
    })),
  }] }));
  await writeFile(configPath, JSON.stringify({
    upstreamExecutable: executable, modelCatalogPath: catalogPath,
    extraModelSettingsPath: settingsPath, tokenUsageEventsPath: usagePath,
    ...(deepSeekEnabled ? { providerSettingsPath } : {}),
  }));
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "PATHEXT"].includes(name),
  ));
  child = spawn(process.execPath, [
    "src/launcher.mjs", join(import.meta.dirname, "fixtures", "relay-upstream.mjs"), "app-server",
  ], {
    cwd: join(import.meta.dirname, ".."), windowsHide: true,
    env: { ...environment, CODEX_HOME: join(directory, "codex-home"),
      CODEX_QUOTA_ROLE: "app-server-relay", CODEX_QUOTA_RELAY_CONFIG: configPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  let processError = null;
  let closed = false;
  child.once("error", (error) => { processError = error; });
  completion = new Promise((resolve) => child.once("close", (code, signal) => {
    closed = true;
    resolve({ code, signal });
  }));
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const messages = [];
  lines = createInterface({ input: child.stdout });
  lines.on("line", (raw) => messages.push({ raw, message: JSON.parse(raw) }));
  const take = async (predicate) => {
    const index = await waitFor(() => {
      const found = messages.findIndex(({ message }) => predicate(message));
      if (found >= 0) return { value: found };
      if (processError || closed) throw processError ?? new Error(`测试中继已退出：${stderr}`);
      return false;
    }, { timeoutMs: 5_000 });
    return messages.splice(index.value, 1)[0];
  };
  const sendRaw = async (value) => {
    if (!child.stdin.write(value)) await once(child.stdin, "drain");
  };
  const send = (message) => sendRaw(`${JSON.stringify(message)}\n`);
  await take((message) => message.method === "fixture/ready");
  return {
    directory, child, take, send, sendRaw,
    received: async (id) => (await take((message) =>
      message.method === "fixture/received" && message.params.message.id === id)).message.params.message,
    emit: (message) => send({ method: "fixture/emit", params: { message } }),
    emitRaw: (raw, chunkSize) => send({ method: "fixture/emit", params: { raw, chunkSize } }),
    stderr: () => stderr,
    events: async () => (await readFile(usagePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line)),
  };
}
