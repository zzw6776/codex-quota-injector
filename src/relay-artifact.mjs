import { readFile, stat } from "node:fs/promises";

const MIN_WSL_RELAY_SIZE = 10 * 1024 * 1024;
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const ACTIVE_SEA_FUSE = Buffer.from(
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2:1",
  "ascii",
);

export async function assertValidWslRelayExecutable(path) {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size < MIN_WSL_RELAY_SIZE) {
    throw new Error(`WSL relay 文件不存在或大小异常: ${path}`);
  }
  const image = await readFile(path);
  if (!image.subarray(0, ELF_MAGIC.length).equals(ELF_MAGIC)) {
    throw new Error(`WSL relay 不是有效的 ELF 文件: ${path}`);
  }
  if (!image.includes(ACTIVE_SEA_FUSE)) {
    throw new Error(`WSL relay 未包含已激活的 Node SEA fuse: ${path}`);
  }
  return true;
}
