#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { build } from "esbuild";
import { assertValidWslRelayExecutable } from "../src/relay-artifact.mjs";

const options = parseOptions(process.argv.slice(2));
if (options.verify) {
  const verifiedPath = resolve(options.verify);
  await assertValidWslRelayExecutable(verifiedPath);
  console.log(`WSL relay 校验通过: ${verifiedPath}`);
} else {
  await buildWslRelay(options);
}

async function buildWslRelay({ output: outputOption, nodeBinary: nodeBinaryOption }) {
  if (process.platform !== "win32" && process.platform !== "linux") {
    throw new Error("WSL relay 只能在 Windows 或 Linux 环境构建");
  }
  const root = resolve(import.meta.dirname, "..");
  const output = resolve(outputOption);
  const nodeBinary = resolve(nodeBinaryOption);
  const workDir = resolve(root, "build", `sea-wsl-${process.arch}`);
  const bundle = resolve(workDir, "wsl-relay.cjs");
  const configPath = resolve(workDir, "sea-config.json");
  const blob = resolve(workDir, "sea-prep.blob");
  const temporaryOutput = `${output}.${process.pid}.${Date.now()}.tmp`;

  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  await mkdir(dirname(output), { recursive: true });

  await build({
    entryPoints: [resolve(root, "src", "wsl-relay-entry.mjs")],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    sourcemap: false,
    minify: true,
    legalComments: "none",
  });

  const executionNode = executionPath(nodeBinary);
  const executionConfig = executionPath(configPath);
  await writeFile(configPath, JSON.stringify({
    main: executionPath(bundle),
    output: executionPath(blob),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  }, null, 2));

  if (process.platform === "win32") {
    execFileSync("wsl.exe", [
      "-e",
      executionNode,
      "--experimental-sea-config",
      executionConfig,
    ], { cwd: root, stdio: "inherit", windowsHide: true });
  } else {
    execFileSync(executionNode, ["--experimental-sea-config", executionConfig], {
      cwd: root,
      stdio: "inherit",
    });
  }

  try {
    await copyFile(nodeBinary, temporaryOutput);
    const postjectCli = resolve(root, "node_modules", "postject", "dist", "cli.js");
    execFileSync(process.execPath, [
      postjectCli,
      temporaryOutput,
      "NODE_SEA_BLOB",
      blob,
      "--sentinel-fuse",
      "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    ], { cwd: root, stdio: "inherit", windowsHide: process.platform === "win32" });

    if (process.platform === "win32") {
      execFileSync("wsl.exe", ["-e", "chmod", "755", executionPath(temporaryOutput)], {
        cwd: root,
        stdio: "inherit",
        windowsHide: true,
      });
    } else {
      await chmod(temporaryOutput, 0o755);
    }

    await assertValidWslRelayExecutable(temporaryOutput);
    await rm(output, { force: true });
    await rename(temporaryOutput, output);
  } catch (error) {
    await rm(temporaryOutput, { force: true }).catch(() => undefined);
    throw error;
  }
  console.log(`WSL 原生 SEA relay 已就绪: ${output}`);
}

function executionPath(path) {
  return process.platform === "win32" ? toWslPath(path) : path;
}

function toWslPath(path) {
  const converted = execFileSync("wsl.exe", ["-e", "wslpath", "-u", path], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  if (!converted) throw new Error(`无法转换 WSL 路径: ${path}`);
  return converted;
}

function parseOptions(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--node-binary") values.nodeBinary = args[++index];
    if (key === "--output") values.output = args[++index];
    if (key === "--verify") values.verify = args[++index];
  }
  if (!values.verify && (!values.output || !values.nodeBinary)) {
    throw new Error("用法: build-wsl-relay.mjs --node-binary <linux-node> --output <executable>");
  }
  return values;
}
