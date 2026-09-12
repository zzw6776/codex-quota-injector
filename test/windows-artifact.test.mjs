import assert from "node:assert/strict";
import { open } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { assertValidWindowsRelayExecutable } from "../src/windows-artifact.mjs";
import { useTempDir } from "./helpers.mjs";

const MINIMUM_SIZE = 10 * 1024 * 1024;
const ACTIVE_SEA_FUSE = Buffer.from(
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2:1",
  "ascii",
);

async function writeSparseArtifact(path, { magic = "MZ", includeFuse = true } = {}) {
  const file = await open(path, "w");
  try {
    await file.truncate(MINIMUM_SIZE);
    await file.write(Buffer.from(magic, "ascii"), 0, 2, 0);
    if (includeFuse) {
      await file.write(ACTIVE_SEA_FUSE, 0, ACTIVE_SEA_FUSE.length, 512);
    }
  } finally {
    await file.close();
  }
}

test("Windows 中继产物必须同时具有 PE 标识、有效体积和激活的 SEA fuse", async (t) => {
  const directory = await useTempDir(t, "codex-windows-artifact-");
  const valid = join(directory, "valid.exe");
  const invalidPe = join(directory, "invalid-pe.exe");
  const missingFuse = join(directory, "missing-fuse.exe");
  const tooSmall = join(directory, "too-small.exe");

  await writeSparseArtifact(valid);
  await writeSparseArtifact(invalidPe, { magic: "NO" });
  await writeSparseArtifact(missingFuse, { includeFuse: false });
  const smallFile = await open(tooSmall, "w");
  await smallFile.truncate(1024);
  await smallFile.close();

  await assert.doesNotReject(assertValidWindowsRelayExecutable(valid));
  await assert.rejects(assertValidWindowsRelayExecutable(invalidPe), /不是有效的 PE 文件/);
  await assert.rejects(assertValidWindowsRelayExecutable(missingFuse), /未包含已激活的 Node SEA fuse/);
  await assert.rejects(assertValidWindowsRelayExecutable(tooSmall), /大小异常/);
  await assert.rejects(
    assertValidWindowsRelayExecutable(join(directory, "missing.exe")),
    /文件不存在或大小异常/,
  );
});
