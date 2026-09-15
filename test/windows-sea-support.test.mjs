import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { assertSuccessfulPostject, stripWindowsAuthenticode } from "../scripts/windows-sea-support.mjs";
import { useTempDir } from "./helpers.mjs";

function signedPeImage({ certificateOffset = 768, certificateSize = 256 } = {}) {
  const image = Buffer.alloc(1024);
  image.write("MZ", 0, "ascii");
  image.writeUInt32LE(0x80, 0x3c);
  image.write("PE\0\0", 0x80, "ascii");
  const optionalHeaderOffset = 0x80 + 24;
  image.writeUInt16LE(0x20b, optionalHeaderOffset);
  image.writeUInt32LE(16, optionalHeaderOffset + 108);
  const securityDirectoryOffset = optionalHeaderOffset + 112 + 4 * 8;
  image.writeUInt32LE(certificateOffset, securityDirectoryOffset);
  image.writeUInt32LE(certificateSize, securityDirectoryOffset + 4);
  image.fill(0xa5, certificateOffset, Math.min(image.length, certificateOffset + certificateSize));
  return { image, securityDirectoryOffset };
}

test("[platform:windows-native] Windows SEA 构建在改写 PE 前移除文件尾 Authenticode 证书表", async (t) => {
  const directory = await useTempDir(t, "windows-sea-support-");
  const path = join(directory, "node.exe");
  const { image, securityDirectoryOffset } = signedPeImage();
  await writeFile(path, image);

  await stripWindowsAuthenticode(path);

  const stripped = await readFile(path);
  assert.equal(stripped.length, 768);
  assert.equal(stripped.readUInt32LE(securityDirectoryOffset), 0);
  assert.equal(stripped.readUInt32LE(securityDirectoryOffset + 4), 0);
});

test("[platform:windows-native] Windows SEA 构建拒绝伪成功的 postject 重定位损坏输出", () => {
  assert.throws(() => assertSuccessfulPostject({
    status: 0,
    stdout: "error: Relocation corrupted: BlockSize is out of bound\nInjection done!",
    stderr: "",
  }), /corrupted Windows PE relocation/);
  assert.doesNotThrow(() => assertSuccessfulPostject({
    status: 0,
    stdout: "Injection done!",
    stderr: "",
  }));
});
