import { readFile, stat } from "node:fs/promises";

const MIN_WINDOWS_RELAY_SIZE = 10 * 1024 * 1024;
const ACTIVE_SEA_FUSE = Buffer.from(
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2:1",
  "ascii",
);

export async function assertValidWindowsRelayExecutable(path) {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size < MIN_WINDOWS_RELAY_SIZE) {
    throw new Error(`Windows relay 文件不存在或大小异常: ${path}`);
  }
  const image = await readFile(path);
  if (image.subarray(0, 2).toString("ascii") !== "MZ") {
    throw new Error(`Windows relay 不是有效的 PE 文件: ${path}`);
  }
  if (!image.includes(ACTIVE_SEA_FUSE)) {
    throw new Error(`Windows relay 未包含已激活的 Node SEA fuse: ${path}`);
  }
  return true;
}
