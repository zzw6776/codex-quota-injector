#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

if (process.platform !== "win32") {
  throw new Error("Windows relay 只能在 Windows 环境构建");
}

const options = parseOptions(process.argv.slice(2));
const root = resolve(import.meta.dirname, "..");
const nodeBinary = resolve(options.nodeBinary ?? process.execPath);
const output = resolve(options.output ?? resolve(root, "build", "codex-quota-relay.exe"));

await mkdir(dirname(output), { recursive: true });
execFileSync(process.execPath, [
  resolve(root, "scripts", "build-sea.mjs"),
  "--node-binary",
  nodeBinary,
  "--output",
  output,
], { cwd: root, stdio: "inherit" });

const outputInfo = await stat(output).catch(() => null);
if (!outputInfo?.isFile() || outputInfo.size <= 0) {
  throw new Error(`Windows relay 构建未生成有效文件: ${output}`);
}
console.log(`Windows 开发版 relay 已构建: ${output}`);

function parseOptions(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--node-binary") values.nodeBinary = args[++index];
    if (key === "--output") values.output = args[++index];
  }
  return values;
}
