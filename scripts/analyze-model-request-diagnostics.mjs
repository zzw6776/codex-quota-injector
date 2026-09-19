#!/usr/bin/env node
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { analyzeStateLifecycle } from "../src/model-router/state-lifecycle-analysis.mjs";

const options = Object.fromEntries(process.argv.slice(2).map(argument => {
  const match = /^--(path|thread|model|output)=(.+)$/.exec(argument);
  if (!match) throw Error("用法：node scripts/analyze-model-request-diagnostics.mjs --path=<JSONL> [--thread=<任务ID>] [--model=<模型>] [--output=<脱敏JSON>]");
  return [match[1], match[2]];
}));
if (!options.path) throw Error("必须提供 --path=<model-request-diagnostics.jsonl>");
const path = resolve(options.path);
const extension = extname(path);
const stem = basename(path, extension);
const files = (await readdir(dirname(path))).filter(name => name === basename(path) ||
  (name.startsWith(`${stem}.`) && name.endsWith(extension))).sort((left, right) => {
    if (left === basename(path)) return 1;
    if (right === basename(path)) return -1;
    return left.localeCompare(right);
  }).map(name => resolve(dirname(path), name));
const records = [];
for (const file of files) {
  const lines = (await readFile(file, "utf8")).split("\n");
  lines.forEach((line, index) => {
    if (!line) return;
    try { records.push({ ...JSON.parse(line), sourceFile: file, line: index + 1 }); }
    catch (error) { throw Error(`${file}:${index + 1} 不是有效 JSON：${error.message}`); }
  });
}
const result = analyzeStateLifecycle(records, { threadId: options.thread ?? null, model: options.model ?? null });
const output = `${JSON.stringify({ sources: files, ...result }, null, 2)}\n`;
if (options.output) {
  const outputPath = resolve(options.output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, output, { encoding: "utf8", mode: 0o600 });
  console.log(JSON.stringify({ output: outputPath, containsRawStateValues: false,
    requestCount: result.requestCount, responseStateCount: result.responseStateCount }));
} else {
  process.stdout.write(output);
}
