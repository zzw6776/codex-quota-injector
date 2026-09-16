import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import { chmod, mkdir, rename, writeFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import process from "node:process";
import { createReadStream } from "node:fs";

const execFileAsync = promisify(execFile);

const WAIT_INTERVAL_MS = 500;

async function writePrivateJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function runCommand(file, args, options = {}) {
  return execFileAsync(file, args, {
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  });
}

async function runPowerShell(script) {
  return execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
  );
}

async function fileHash(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function writePrivateText(path, contents) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function hashBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function quoteWindowsArgument(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

function powershellQuote(value) {
  return String(value).replaceAll("'", "''");
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export { pathExists, execFileAsync, hashBytes, writePrivateText, fileHash, writePrivateJson, delay, runCommand, WAIT_INTERVAL_MS, quoteWindowsArgument, powershellQuote, runPowerShell };
