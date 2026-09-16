import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

async function codexRunsInWindowsSubsystemForLinux() {
  if (process.platform !== "win32") return false;
  const configPath = join(homedir(), ".codex", "config.toml");
  const contents = await readFile(configPath, "utf8").catch(() => "");
  return parseWindowsSubsystemSetting(contents);
}

function parseWindowsSubsystemSetting(contents) {
  let inDesktopSection = false;
  for (const line of String(contents ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    const section = trimmed.match(/^\[([^\]]+)\]$/);
    if (section) {
      inDesktopSection = section[1] === "desktop";
      continue;
    }
    if (!inDesktopSection) continue;
    const setting = trimmed.match(
      /^runCodexInWindowsSubsystemForLinux\s*=\s*(true|false)(?:\s+#.*)?$/,
    );
    if (setting) return setting[1] === "true";
  }
  return false;
}

function updateWindowsSubsystemSetting(contents, enabled) {
  const source = String(contents ?? "");
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const hadFinalNewline = source.endsWith("\n");
  const lines = source ? source.split(/\r?\n/) : [];
  if (hadFinalNewline) lines.pop();
  let desktopStart = -1;
  let desktopEnd = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const section = lines[index].trim().match(/^\[([^\]]+)\]$/);
    if (!section) continue;
    if (desktopStart >= 0) {
      desktopEnd = index;
      break;
    }
    if (section[1] === "desktop") desktopStart = index;
  }
  const settingIndexes = [];
  if (desktopStart >= 0) {
    for (let index = desktopStart + 1; index < desktopEnd; index += 1) {
      if (/^\s*runCodexInWindowsSubsystemForLinux\s*=/.test(lines[index])) {
        settingIndexes.push(index);
      }
    }
  }
  if (settingIndexes.length > 1) {
    throw new Error("[desktop] 中存在重复的 runCodexInWindowsSubsystemForLinux，拒绝自动切换");
  }
  const value = enabled ? "true" : "false";
  if (settingIndexes.length === 1) {
    const index = settingIndexes[0];
    const match = lines[index].match(/^(\s*runCodexInWindowsSubsystemForLinux\s*=\s*)(true|false)(\s*(?:#.*)?)$/);
    if (!match) {
      throw new Error("[desktop] 的 runCodexInWindowsSubsystemForLinux 不是可安全修改的布尔值");
    }
    lines[index] = `${match[1]}${value}${match[3]}`;
  } else if (desktopStart >= 0) {
    lines.splice(desktopStart + 1, 0, `runCodexInWindowsSubsystemForLinux = ${value}`);
  } else {
    if (lines.length && lines.at(-1) !== "") lines.push("");
    lines.push("[desktop]", `runCodexInWindowsSubsystemForLinux = ${value}`);
  }
  return `${lines.join(newline)}${hadFinalNewline || lines.length ? newline : ""}`;
}

export { codexRunsInWindowsSubsystemForLinux, parseWindowsSubsystemSetting, updateWindowsSubsystemSetting };
