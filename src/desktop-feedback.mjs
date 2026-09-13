import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function openInjectorLog(logPath) {
  const path = String(logPath ?? "").trim();
  if (!path) throw new Error("注入器日志路径为空");
  if (process.platform === "darwin") {
    await execFileAsync("/usr/bin/open", [path]);
    return;
  }
  if (process.platform === "win32") {
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      windowsOpenLogScript(path),
    ], { windowsHide: true });
    return;
  }
  throw new Error(`当前平台 ${process.platform} 无法打开注入器日志`);
}

export async function showWindowsStartupFailure(logPath) {
  if (process.platform !== "win32") return false;
  await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    windowsStartupFailureScript(logPath),
  ], { windowsHide: true });
  return true;
}

export function windowsOpenLogScript(logPath) {
  return [
    `$path='${powershellQuote(logPath)}'`,
    "Start-Process -FilePath 'notepad.exe' -ArgumentList @($path)",
  ].join("; ");
}

export function windowsStartupFailureScript(logPath) {
  const detail = logPath
    ? `启动未完成。请查看日志：\n${String(logPath)}`
    : "启动未完成。请查看 Codex Quota Injector 日志。";
  return [
    "Add-Type -AssemblyName PresentationFramework",
    `[void][System.Windows.MessageBox]::Show('${powershellQuote(detail)}','Codex Quota Injector 启动失败','OK','Error')`,
  ].join("; ");
}

function powershellQuote(value) {
  return String(value ?? "").replaceAll("'", "''");
}
