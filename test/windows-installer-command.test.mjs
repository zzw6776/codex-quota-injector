import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { windowsInstallerArguments } from "../scripts/windows-installer-command.mjs";

test("[platform:windows-native] Windows 安装器显式以 UTF-8 读取包含中文的 NSIS 脚本", () => {
  const scriptPath = "D:\\project\\installer\\windows-installer.nsi";
  const args = windowsInstallerArguments({
    version: "1.2.3",
    inputExecutable: "D:\\build\\app.exe",
    windowsRelayExecutable: "D:\\build\\relay.exe",
    wslRelayExecutable: "D:\\build\\relay-wsl",
    appIcon: "D:\\assets\\icon.ico",
    nodeLicense: "D:\\node\\LICENSE",
    outputExecutable: "D:\\release\\setup.exe",
    scriptPath,
  });

  assert.deepEqual(args.slice(0, 2), ["/INPUTCHARSET", "UTF8"]);
  assert.equal(args.at(-1), scriptPath);
  assert.ok(args.indexOf("UTF8") < args.indexOf(scriptPath),
    "NSIS 必须在读取脚本前切换到 UTF-8");
});

test("[platform:windows-native] Windows 安装器把独立应用图标安装并绑定到两个快捷方式", async () => {
  const script = await readFile(resolve(import.meta.dirname, "../installer/windows-installer.nsi"), "utf8");
  assert.match(script, /File "\/oname=AppIcon\.ico" "\$\{APP_ICON\}"/);
  assert.match(script, /CreateShortCut "\$SMPROGRAMS\\Codex Quota Injector\\Codex Quota Injector\.lnk"[^\n]+"\$INSTDIR\\AppIcon\.ico"/);
  assert.match(script, /CreateShortCut "\$DESKTOP\\Codex Quota Injector\.lnk"[^\n]+"\$INSTDIR\\AppIcon\.ico"/);
  assert.match(script, /Delete "\$INSTDIR\\AppIcon\.ico"/);
});
