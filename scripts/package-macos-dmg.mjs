import { execFileSync } from "node:child_process";
import { lstat, readdir, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const MIB = 1024 * 1024;
const BLOCK_BYTES = 4096;

export async function planMacDmg(appPath) {
  let logicalBytes = 0;
  let allocatedBytes = 0;
  let copyBytes = 0;
  let entries = 0;
  async function visit(path) {
    // Do not follow symlinks or use allocated blocks as the copy size: sparse
    // and compressed source files can expand on the destination filesystem.
    const info = await lstat(path);
    entries++;
    allocatedBytes += info.blocks * 512;
    if (info.isDirectory()) {
      copyBytes += BLOCK_BYTES;
      for (const name of await readdir(path)) await visit(join(path, name));
    } else {
      logicalBytes += info.size;
      copyBytes += Math.max(BLOCK_BYTES, Math.ceil(info.size / BLOCK_BYTES) * BLOCK_BYTES);
    }
  }
  await visit(appPath);
  // Include partition/filesystem metadata and room for future bundle growth.
  const imageMiB = Math.ceil((copyBytes + Math.max(64 * MIB, copyBytes * 0.25)) / MIB);
  return { logicalBytes, allocatedBytes, entries, imageMiB };
}

export async function createMacDmg({ appPath, dmgPath, run = execFileSync, log = console.log }) {
  const plan = await planMacDmg(appPath);
  const diskSpace = async () => Promise.all([dirname(dmgPath), tmpdir()].map(async path => {
    try {
      const info = await statfs(path);
      return { path, availableBytes: info.bavail * info.bsize };
    } catch (error) {
      return { path, error: error.message };
    }
  }));
  log(`[dmg] ${JSON.stringify({ ...plan, filesystem: "HFS+", diskSpace: await diskSpace() })}`);
  try {
    run("/usr/bin/hdiutil", [
      "create", "-volname", "Codex Quota Injector", "-srcfolder", appPath,
      "-fs", "HFS+", "-size", `${plan.imageMiB}m`, "-ov", "-format", "UDZO", dmgPath,
    ], { stdio: "inherit" });
    run("/usr/bin/hdiutil", ["verify", dmgPath], { stdio: "inherit" });
  } catch (error) {
    log(`[dmg] failed; diskSpace=${JSON.stringify(await diskSpace())}`);
    throw error;
  }
  return plan;
}
