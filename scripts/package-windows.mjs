import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const options = parseOptions(process.argv.slice(2));
const root = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const outputDir = resolve(options.outputDir);
const output = resolve(
  outputDir,
  `Codex-Quota-Injector-${packageJson.version}-windows-x64-setup.exe`,
);
await mkdir(outputDir, { recursive: true });

execFileSync(options.makensis, [
  `/DVERSION=${packageJson.version}`,
  `/DINPUT_EXE=${resolve(options.inputExecutable)}`,
  `/DNODE_LICENSE=${resolve(options.nodeLicense)}`,
  `/DOUTPUT_EXE=${output}`,
  resolve(root, "installer", "windows-installer.nsi"),
], { stdio: "inherit" });

console.log(output);

function parseOptions(args) {
  const values = { makensis: "makensis.exe" };
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--input-executable") values.inputExecutable = args[++index];
    if (key === "--node-license") values.nodeLicense = args[++index];
    if (key === "--output-dir") values.outputDir = args[++index];
    if (key === "--makensis") values.makensis = args[++index];
  }
  if (!values.inputExecutable || !values.nodeLicense || !values.outputDir) {
    throw new Error("Windows 打包参数不完整");
  }
  return values;
}
