import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const RETRY_DELAYS_MS = [25, 50, 100, 200];
const TRANSIENT_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);

// Windows readers can briefly deny replacement. Keep the old complete file
// visible until replacement succeeds; never remove it to bypass a lock.
export async function writeLifecycleFile(path, content, {
  platform = process.platform,
  renameFile = rename,
  sleep = delay,
} = {}) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try {
        await renameFile(temporary, path);
        return;
      } catch (error) {
        const retryDelay = RETRY_DELAYS_MS[attempt];
        if (platform !== "win32" || retryDelay == null ||
          !TRANSIENT_ERRORS.has(error.code)) throw error;
        await sleep(retryDelay);
      }
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
