import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const options = parseOptions(process.argv.slice(2));
const root = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const releaseDir = resolve(options.outputDir);
const appPath = resolve(releaseDir, "Codex Quota Injector.app");
const contents = resolve(appPath, "Contents");
const executable = resolve(contents, "MacOS", "Codex Quota Injector");
const resources = resolve(contents, "Resources");
const worker = resolve(resources, "Codex Quota Injector Worker");
const launcherSource = resolve(root, "src", "macos-launcher.swift");
const launcherArm64 = resolve(root, "build", "macos-launcher-arm64");
const launcherX64 = resolve(root, "build", "macos-launcher-x64");
const dmgPath = resolve(
  releaseDir,
  `Codex-Quota-Injector-${packageJson.version}-macos-universal.dmg`,
);

await rm(releaseDir, { recursive: true, force: true });
await mkdir(resolve(contents, "MacOS"), { recursive: true });
await mkdir(resources, { recursive: true });

execFileSync("/usr/bin/lipo", [
  "-create",
  resolve(options.arm64Executable),
  resolve(options.x64Executable),
  "-output",
  worker,
], { stdio: "inherit" });

for (const [architecture, output] of [["arm64", launcherArm64], ["x86_64", launcherX64]]) {
  execFileSync("/usr/bin/xcrun", [
    "swiftc",
    "-target",
    `${architecture}-apple-macos12.0`,
    "-O",
    launcherSource,
    "-o",
    output,
  ], { stdio: "inherit" });
}
execFileSync("/usr/bin/lipo", [
  "-create",
  launcherArm64,
  launcherX64,
  "-output",
  executable,
], { stdio: "inherit" });

await cp(
  resolve(root, "assets", "AppIcon.icns"),
  resolve(resources, "AppIcon.icns"),
);
await cp(resolve(options.nodeLicense), resolve(resources, "NODE_LICENSE.txt"));
await writeFile(resolve(contents, "Info.plist"), infoPlist(packageJson.version));

execFileSync("/bin/chmod", ["755", executable, worker]);
execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appPath], {
  stdio: "inherit",
});
execFileSync("/usr/bin/hdiutil", [
  "create",
  "-volname",
  "Codex Quota Injector",
  "-srcfolder",
  appPath,
  "-ov",
  "-format",
  "UDZO",
  dmgPath,
], { stdio: "inherit" });

console.log(dmgPath);

function parseOptions(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--arm64-executable") values.arm64Executable = args[++index];
    if (key === "--x64-executable") values.x64Executable = args[++index];
    if (key === "--node-license") values.nodeLicense = args[++index];
    if (key === "--output-dir") values.outputDir = args[++index];
  }
  if (!values.arm64Executable || !values.x64Executable || !values.nodeLicense || !values.outputDir) {
    throw new Error("macOS 打包参数不完整");
  }
  return values;
}

function infoPlist(version) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
  <key>CFBundleExecutable</key><string>Codex Quota Injector</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleIdentifier</key><string>com.zzw6776.codex-quota-injector</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Codex Quota Injector</string>
  <key>CFBundleDisplayName</key><string>Codex Quota Injector</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`;
}
