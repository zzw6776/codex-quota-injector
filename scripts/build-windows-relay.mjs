#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";
import packageJson from "../package.json" with { type: "json" };

const rootDir = resolve(import.meta.dirname, "..");
const options = parseOptions(process.argv.slice(2));
const nodeBinary = resolve(options.node ?? process.execPath);
const outputPath = resolve(
  options.output ??
    resolve(rootDir, "build", `codex-quota-relay-windows-${packageJson.version}.exe`),
);
const workDir = resolve(rootDir, "build", `sea-windows-relay-${process.arch}`);
const bundlePath = resolve(workDir, "windows-relay-bundle.cjs");
const blobPath = resolve(workDir, "windows-relay.blob");
const seaConfigPath = resolve(workDir, "windows-relay-sea-config.json");
const temporaryOutputPath = `${outputPath}.tmp-${process.pid}`;

if (process.platform !== "win32") {
  throw new Error("Windows relay SEA must be built on Windows.");
}

await mkdir(workDir, { recursive: true });
await mkdir(dirname(outputPath), { recursive: true });
await rm(temporaryOutputPath, { force: true });

try {
  await build({
    entryPoints: [resolve(rootDir, "src", "windows-relay-entry.mjs")],
    outfile: bundlePath,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    sourcemap: false,
    packages: "external",
  });

  await writeFile(
    seaConfigPath,
    `${JSON.stringify(
      {
        main: bundlePath,
        output: blobPath,
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  runChecked(nodeBinary, ["--experimental-sea-config", seaConfigPath], {
    cwd: rootDir,
    label: "Node SEA blob generation",
  });

  await copyFile(nodeBinary, temporaryOutputPath);
  await stripWindowsAuthenticode(temporaryOutputPath);

  const postjectPath = resolve(rootDir, "node_modules", "postject", "dist", "cli.js");
  const postjectResult = runCaptured(
    process.execPath,
    [
      postjectPath,
      temporaryOutputPath,
      "NODE_SEA_BLOB",
      blobPath,
      "--sentinel-fuse",
      "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    ],
    { cwd: rootDir },
  );
  const postjectOutput = `${postjectResult.stdout ?? ""}\n${postjectResult.stderr ?? ""}`;

  if (postjectResult.stdout) process.stdout.write(postjectResult.stdout);
  if (postjectResult.stderr) process.stderr.write(postjectResult.stderr);
  if (postjectResult.error) throw postjectResult.error;
  if (postjectResult.status !== 0) {
    throw new Error(`postject exited with code ${postjectResult.status}.`);
  }
  if (/Relocation corrupted|(?:^|\n)\s*(?:error|fatal):/i.test(stripAnsi(postjectOutput))) {
    throw new Error("postject reported a corrupted Windows PE relocation or another fatal error.");
  }
  if (!/Injection done!/i.test(stripAnsi(postjectOutput))) {
    throw new Error("postject did not confirm that the SEA blob was injected.");
  }

  await verifyWindowsSea(temporaryOutputPath);
  await rm(outputPath, { force: true });
  await rename(temporaryOutputPath, outputPath);

  const outputStat = await stat(outputPath);
  console.log(`Built native Windows relay SEA: ${outputPath}`);
  console.log(`Relay size: ${outputStat.size} bytes`);
} catch (error) {
  await rm(temporaryOutputPath, { force: true });
  throw error;
}

function parseOptions(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--node") {
      parsed.node = args[++index];
      continue;
    }
    if (argument === "--output") {
      parsed.output = args[++index];
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return parsed;
}

function runChecked(command, args, { cwd, label }) {
  const result = runCaptured(command, args, { cwd });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} exited with code ${result.status}.`);
  }
}

function runCaptured(command, args, { cwd }) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function stripWindowsAuthenticode(filePath) {
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

async function verifyWindowsSea(filePath) {
  const image = await readFile(filePath);
  if (image.length < 10 * 1024 * 1024 || image.toString("ascii", 0, 2) !== "MZ") {
    throw new Error("The generated Windows relay SEA is not a valid standalone PE executable.");
  }

  const activeFuse = Buffer.from(
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2:1",
    "ascii",
  );
  if (!image.includes(activeFuse)) {
    throw new Error("The generated Windows relay SEA does not contain an active Node SEA fuse.");
  }
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}
