import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import { assertValidWslRelayExecutable } from "../src/relay-artifact.mjs";
import { assertValidWindowsRelayExecutable } from "../src/windows-artifact.mjs";

const options = parseOptions(process.argv.slice(2));
const root = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const wslRelayExecutable = resolve(options.wslRelayExecutable);
const windowsRelayExecutable = resolve(options.windowsRelayExecutable);
await assertValidWslRelayExecutable(wslRelayExecutable);
await assertValidWindowsRelayExecutable(windowsRelayExecutable);
const outputDir = resolve(options.outputDir);
const output = resolve(
  outputDir,
  `Codex-Quota-Injector-${packageJson.version}-windows-x64-Setup.exe`,
);
await mkdir(outputDir, { recursive: true });

execFileSync(options.makensis, [
  `/DVERSION=${packageJson.version}`,
  `/DINPUT_EXE=${resolve(options.inputExecutable)}`,
  `/DWINDOWS_RELAY_EXE=${windowsRelayExecutable}`,
  `/DWSL_RELAY_EXE=${wslRelayExecutable}`,
  `/DAPP_ICON=${resolve(root, "assets", "AppIcon.ico")}`,
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
    if (key === "--windows-relay-executable") values.windowsRelayExecutable = args[++index];
    if (key === "--wsl-relay-executable") values.wslRelayExecutable = args[++index];
    if (key === "--node-license") values.nodeLicense = args[++index];
    if (key === "--output-dir") values.outputDir = args[++index];
    if (key === "--makensis") values.makensis = args[++index];
  }
  if (!values.inputExecutable || !values.windowsRelayExecutable || !values.wslRelayExecutable ||
    !values.nodeLicense || !values.outputDir) {
    throw new Error("Windows 打包参数不完整");
  }
  return values;
}
