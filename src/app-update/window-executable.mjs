import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isSea } from "node:sea";
import { promisify } from "node:util";

const exec = promisify(execFile);
const builds = new Map();

export async function resolveDevUpdateWindow({ root = resolve(import.meta.dirname, "../.."),
  arch = process.arch, compile = async (source, output) => {
    await exec("/usr/bin/xcrun", ["swiftc", "-target", `${arch === "x64" ? "x86_64" : "arm64"}-apple-macos12.0`, "-O", source, "-o", output]);
    await exec("/usr/bin/codesign", ["--force", "--sign", "-", output]);
  } } = {}) {
  const source = join(root, "src", "macos-update-window.swift");
  const hash = createHash("sha256").update(await readFile(source)).digest("hex").slice(0, 20);
  const directory = join(root, "build");
  const output = join(directory, `update-window-${arch}-${hash}`);
  const info = await stat(output).catch(() => null);
  if (info?.isFile() && info.size > 0) { await access(output); return output; }
  if (builds.has(output)) return builds.get(output);
  const pending = (async () => {
    await mkdir(directory, { recursive: true });
    const temporary = `${output}.${randomUUID()}.tmp`;
    try { await compile(source, temporary); await rename(temporary, output); }
    finally { await rm(temporary, { force: true }); }
    return output;
  })().finally(() => { builds.delete(output); });
  builds.set(output, pending);
  return pending;
}

export async function warmUpdateWindow() {
  if (process.platform === "darwin" && !isSea()) await resolveDevUpdateWindow();
}
