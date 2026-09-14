import { readFile, writeFile } from "node:fs/promises";

export async function stripWindowsAuthenticode(filePath) {
  let image = await readFile(filePath);
  if (image.length < 512 || image.toString("ascii", 0, 2) !== "MZ") {
    throw new Error("The selected Node executable is not a valid Windows PE image.");
  }

  const peOffset = image.readUInt32LE(0x3c);
  if (peOffset + 24 > image.length || image.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") {
    throw new Error("The selected Node executable has an invalid PE header.");
  }

  const optionalHeaderOffset = peOffset + 24;
  const optionalHeaderMagic = image.readUInt16LE(optionalHeaderOffset);
  const isPe32Plus = optionalHeaderMagic === 0x20b;
  if (!isPe32Plus && optionalHeaderMagic !== 0x10b) {
    throw new Error("The selected Node executable has an unsupported PE optional header.");
  }

  const numberOfDataDirectoriesOffset = optionalHeaderOffset + (isPe32Plus ? 108 : 92);
  const dataDirectoryOffset = optionalHeaderOffset + (isPe32Plus ? 112 : 96);
  if (
    numberOfDataDirectoriesOffset + 4 > image.length ||
    image.readUInt32LE(numberOfDataDirectoriesOffset) < 5 ||
    dataDirectoryOffset + 40 > image.length
  ) {
    throw new Error("The selected Node executable has an incomplete PE data directory.");
  }

  const securityDirectoryOffset = dataDirectoryOffset + 4 * 8;
  const certificateOffset = image.readUInt32LE(securityDirectoryOffset);
  const certificateSize = image.readUInt32LE(securityDirectoryOffset + 4);
  image.writeUInt32LE(0, securityDirectoryOffset);
  image.writeUInt32LE(0, securityDirectoryOffset + 4);

  if (certificateOffset !== 0 || certificateSize !== 0) {
    const certificateEnd = certificateOffset + certificateSize;
    if (certificateOffset === 0 || certificateSize === 0 || certificateEnd !== image.length) {
      throw new Error("The Node Authenticode certificate table is not a removable end-of-file overlay.");
    }
    image = image.subarray(0, certificateOffset);
  }

  await writeFile(filePath, image);
}

export function assertSuccessfulPostject(result) {
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`postject exited with code ${result.status}.`);
  const output = stripAnsi(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  if (/Relocation corrupted|(?:^|\n)\s*(?:error|fatal):/i.test(output)) {
    throw new Error("postject reported a corrupted Windows PE relocation or another fatal error.");
  }
  if (!/Injection done!/i.test(output)) {
    throw new Error("postject did not confirm that the SEA blob was injected.");
  }
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}
