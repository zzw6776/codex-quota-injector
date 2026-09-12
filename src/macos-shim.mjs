import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isSea } from "node:sea";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SHIM_RESOURCE_NAME = "Codex Quota Injector Shim";

export async function resolveMacOSCodexShim() {
  if (process.platform !== "darwin") throw new Error("Codex exec shim 仅支持 macOS");
  const overridden = String(process.env.CODEX_QUOTA_MACOS_SHIM ?? "").trim();
  if (overridden) {
    const path = resolve(overridden);
    await access(path, fsConstants.X_OK);
    return path;
  }
  if (isSea()) {
    const path = resolve(dirname(process.execPath), SHIM_RESOURCE_NAME);
    await access(path, fsConstants.X_OK);
    return path;
  }

  const root = resolve(import.meta.dirname, "..");
  const source = resolve(root, "src", "macos-codex-shim.swift");
  const architecture = process.arch === "x64" ? "x86_64" : "arm64";
  const output = resolve(root, "build", `codex-quota-shim-macos-${process.arch}`);
  if (await isCurrentBuild(source, output)) return output;
  await mkdir(dirname(output), { recursive: true });
  await execFileAsync("/usr/bin/xcrun", [
    "swiftc",
    "-target",
    `${architecture}-apple-macos12.0`,
    "-O",
    source,
    "-o",
    output,
  ]);
  await execFileAsync("/usr/bin/codesign", ["--force", "--sign", "-", output]);
  return output;
}

async function isCurrentBuild(source, output) {
  try {
    const [sourceInfo, outputInfo] = await Promise.all([stat(source), stat(output)]);
    return outputInfo.isFile() && outputInfo.size > 0 && outputInfo.mtimeMs >= sourceInfo.mtimeMs;
  } catch {
    return false;
  }
}
