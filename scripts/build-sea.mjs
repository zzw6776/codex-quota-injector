import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

import { build } from "esbuild";

const options = parseOptions(process.argv.slice(2));
const root = resolve(import.meta.dirname, "..");
const output = resolve(options.output);
const nodeBinary = resolve(options.nodeBinary);
const workDir = resolve(root, "build", `sea-${process.platform}-${process.arch}`);
const bundle = resolve(workDir, "launcher.cjs");
const configPath = resolve(workDir, "sea-config.json");
const blob = resolve(workDir, "sea-prep.blob");

await rm(workDir, { recursive: true, force: true });
await mkdir(workDir, { recursive: true });
await mkdir(dirname(output), { recursive: true });

await build({
  entryPoints: [resolve(root, "src", "launcher.mjs")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: false,
  minify: true,
  legalComments: "none",
});

await writeFile(configPath, JSON.stringify({
  main: bundle,
  output: blob,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
}, null, 2));

execFileSync(process.execPath, ["--experimental-sea-config", configPath], {
  cwd: root,
  stdio: "inherit",
});
await copyFile(nodeBinary, output);

if (process.platform === "darwin") {
  execFileSync("/usr/bin/codesign", ["--remove-signature", output], {
    stdio: "ignore",
  });
}

const postjectCli = resolve(root, "node_modules", "postject", "dist", "cli.js");
const postjectArgs = [
  postjectCli,
  output,
  "NODE_SEA_BLOB",
  blob,
  "--sentinel-fuse",
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
];
if (process.platform === "darwin") {
  postjectArgs.push("--macho-segment-name", "NODE_SEA");
}
execFileSync(process.execPath, postjectArgs, { cwd: root, stdio: "inherit" });

if (process.platform === "darwin") {
  await chmod(output, 0o755);
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", output], {
    stdio: "inherit",
  });
} else if (process.platform === "win32") {
  await patchWindowsGuiSubsystem(output);
}

function parseOptions(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--output") values.output = args[++index];
    if (key === "--node-binary") values.nodeBinary = args[++index];
  }
  if (!values.output || !values.nodeBinary) {
    throw new Error("用法: build-sea.mjs --node-binary <node> --output <executable>");
  }
  return values;
}

async function patchWindowsGuiSubsystem(path) {
  const image = Buffer.from(await readFile(path));
  const peOffset = image.readUInt32LE(0x3c);
  if (image.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") {
    throw new Error("生成的 Windows 文件不是有效 PE 可执行文件");
  }
  const optionalHeaderOffset = peOffset + 24;
  const magic = image.readUInt16LE(optionalHeaderOffset);
  if (magic !== 0x10b && magic !== 0x20b) {
    throw new Error(`不支持的 PE Optional Header: 0x${magic.toString(16)}`);
  }
  image.writeUInt16LE(2, optionalHeaderOffset + 68);
  await writeFile(path, image);
}
