#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { copyFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";
import packageJson from "../package.json" with { type: "json" };
import { assertValidWindowsRelayExecutable } from "../src/windows-artifact.mjs";
import { assertSuccessfulPostject, stripWindowsAuthenticode } from "./windows-sea-support.mjs";

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
  if (postjectResult.stdout) process.stdout.write(postjectResult.stdout);
  if (postjectResult.stderr) process.stderr.write(postjectResult.stderr);
  assertSuccessfulPostject(postjectResult);

  await assertValidWindowsRelayExecutable(temporaryOutputPath);
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
