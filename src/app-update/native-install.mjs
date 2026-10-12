import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { acquireSingleInstance, closeSingleInstance, readSingleInstanceStatus } from "../single-instance.mjs";
import { stopCodex, getCodexLaunchReadiness } from "../platform.mjs";
import { defaultAccountDataDir } from "../platform/directories.mjs";
const exec = promisify(execFile);

export async function prepareNativeUpdate(control, download, { signal } = {}) {
  signal?.throwIfAborted();
  if (control.asset.platform === "darwin") {
    const mount = join(control.directory, "mount");
    await mkdir(mount, { recursive: true });
    const stage = `${control.installedApp}.update-${randomUUID()}`;
    let attached = false;
    try {
      await exec("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, download], { signal });
      attached = true;
      const bundle = join(mount, "Codex Quota Injector.app");
      await verifyMacUpdate(bundle, control.asset, { signal });
      await exec("/usr/bin/ditto", [bundle, stage], { signal });
      await verifyMacUpdate(stage, control.asset, { signal });
      return { stage };
    } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
    finally {
      await exec("/usr/bin/hdiutil", ["detach", mount], { timeout: 20_000 }).catch(error => {
        if (attached) throw error;
      });
    }
  }
  const file = await readFile(download);
  const offset = file.length >= 64 ? file.readUInt32LE(0x3c) : -1;
  if (file.toString("ascii", 0, 2) !== "MZ" || offset < 0 || offset + 6 > file.length ||
      file.toString("ascii", offset, offset + 4) !== "PE\0\0" ||
      ![0x14c, 0x8664].includes(file.readUInt16LE(offset + 4))) throw new Error("Windows 安装包不是有效 PE 文件");
  return { installer: download };
}

async function verifyMacUpdate(bundle, asset, { signal } = {}) {
  const plist = join(bundle, "Contents", "Info.plist");
  const value = async key => (await exec("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist], { signal })).stdout.trim();
  if (await value("CFBundleShortVersionString") !== asset.version ||
      await value("CFBundleIdentifier") !== "com.zzw6776.codex-quota-injector") throw new Error("正式应用版本或标识不匹配");
  await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle], { signal });
  for (const path of [join(bundle, "Contents", "MacOS", "Codex Quota Injector"),
    join(bundle, "Contents", "Resources", "Codex Quota Injector Worker"),
    join(bundle, "Contents", "Resources", "Codex Quota Injector Shim")]) {
    const names = (await exec("/usr/bin/lipo", ["-archs", path], { signal })).stdout.trim().split(/\s+/);
    if (names.length !== 1 || names[0] !== (asset.arch === "x64" ? "x86_64" : "arm64")) throw new Error("正式应用架构不匹配");
  }
  for (const name of ["AppIcon.icns", "NODE_LICENSE.txt"]) {
    if (!(await stat(join(bundle, "Contents", "Resources", name))).isFile()) throw new Error("正式应用资源不完整");
  }
}

export async function stopForUpdate(control, { signal } = {}) {
  signal?.throwIfAborted();
  const current = await readSingleInstanceStatus();
  if (current.pid !== control.owner.pid || current.mode !== control.owner.mode || current.version !== control.owner.version) {
    throw new Error("运行实例已经变化，请关闭更新窗口后重新检查");
  }
  signal?.throwIfAborted();
  const lock = await acquireSingleInstance({ mode: "formal", version: control.asset.version,
    explicitStart: true, purpose: "install-update", getStatus: () => ({ phase: "updating" }) });
  if (!lock) throw new Error("现有实例拒绝更新接管");
  try { signal?.throwIfAborted(); await stopCodex({ timeoutMs: 10_000 }); }
  catch (error) { await closeSingleInstance(lock); throw error; }
  return lock;
}

export async function installNativeUpdate(control, prepared, { signal } = {}) {
  signal?.throwIfAborted();
  if (control.asset.platform === "darwin") {
    await rm(control.installedApp, { recursive: true, force: true });
    // Complete the filesystem replacement before honoring cancellation; do not
    // leave the application absent by stopping between removal and rename.
    await rename(prepared.stage, control.installedApp);
    signal?.throwIfAborted();
    await verifyMacUpdate(control.installedApp, control.asset, { signal });
  } else {
    // NSIS calls --prepare-update; the runner must release its lock before it
    // starts so the installer can acquire the same update-preparation lock.
    await exec(prepared.installer, ["/S", `/D=${control.installedApp}`], { windowsHide: true, timeout: 120_000, signal });
  }
}

export async function launchUpdatedApp(control, { signal } = {}) {
  signal?.throwIfAborted();
  if (control.asset.platform === "darwin") await exec("/usr/bin/open", ["-n", control.installedApp,
    "--env", `CODEX_QUOTA_DATA_DIR=${control.dataDir}`, "--env", `CODEX_QUOTA_CDP_PORT=${control.cdpPort ?? 9229}`], { signal });
  else {
    const { spawn } = await import("node:child_process");
    const child = spawn(join(control.installedApp, "Codex Quota Injector.exe"), [], {
      detached: true, stdio: "ignore", windowsHide: true, env: { ...cleanUpdateEnvironment(),
        CODEX_QUOTA_DATA_DIR: control.dataDir, CODEX_QUOTA_CDP_PORT: String(control.cdpPort ?? 9229) },
    });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
  }
}

export async function updatedAppReady(control, { signal } = {}) {
  signal?.throwIfAborted();
  const owner = await readSingleInstanceStatus().catch(() => null);
  if (owner?.pid === control.owner.pid || owner?.mode !== "formal" ||
      owner?.version !== control.asset.version || owner?.phase !== "ready") return false;
  if (control.asset.platform === "darwin") {
    const file = await stat(join(control.installedApp, "Contents", "Resources", "Codex Quota Injector Worker"), { bigint: true });
    const { stdout } = await exec("/usr/sbin/lsof", ["-a", "-p", String(owner.pid), "-d", "txt", "-FfDin"], { signal });
    if (!loadedFileMatches(stdout, file)) return false;
  } else {
    const actual = (await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(owner.pid)}').ExecutablePath`], { windowsHide: true, signal })).stdout.trim();
    if (actual.toLowerCase() !== join(control.installedApp, "Codex Quota Injector.exe").toLowerCase()) return false;
  }
  const configPath = join(control.dataDir ?? defaultAccountDataDir(), "app-server-relay-config.json");
  const config = JSON.parse(await readFile(configPath, "utf8").catch(() => "null"));
  const readiness = await getCodexLaunchReadiness(control.cdpPort ?? 9229, { relay: config ? {
    configPath, statePath: config.relayStatePath, generation: config.generation,
    wslNative: config.runtimeTarget === "wsl-native",
  } : null });
  return readiness.ready;
}

export function loadedFileMatches(output, { dev, ino }) {
  return String(output).split(/\n(?=f)/).some(record => {
    const fields = record.split(/\r?\n/);
    if (!fields.includes("ftxt")) return false;
    try { return BigInt(fields.find(field => field.startsWith("D"))?.slice(1)) === dev &&
      BigInt(fields.find(field => field.startsWith("i"))?.slice(1)) === ino; }
    catch { return false; }
  });
}

export function cleanUpdateEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) =>
    !name.startsWith("CODEX_QUOTA_") && !name.startsWith("CODEX_APP_TOOLS_") &&
    !["CODEX_CLI_PATH", "CODEX_APP_SERVER_FORCE_CLI", "NODE_OPTIONS"].includes(name)));
}

export async function inspectWslUpdateHistory(control, { signal } = {}) {
  signal?.throwIfAborted();
  if (!control.wslRelay) throw new Error("缺少当前源码的 WSL 历史检查运行时");
  if (!control.wslControl) {
    const convert = async path => (await exec("wsl.exe", ["-e", "wslpath", "-u", path], { windowsHide: true, signal })).stdout.trim();
    const directories = (await exec("wsl.exe", ["-e", "sh", "-lc",
      'printf "%s\\n%s\\n" "${CODEX_HOME:-$HOME/.codex}" "${CODEX_SQLITE_HOME:-$HOME/.codex/sqlite}"'], { windowsHide: true, signal })).stdout.trim().split(/\r?\n/);
    if (!directories.every(path => path.startsWith("/")) || directories.length !== 2) throw new Error("无法确定 WSL 历史目录");
    control.wslDirectories = { codexHome: directories[0], sqliteHome: directories[1] };
    const controlPath = join(control.directory, "wsl-history.json");
    await writeFile(controlPath, JSON.stringify(control), { mode: 0o600 });
    control.wslControl = await convert(controlPath);
    control.wslExecutable = await convert(control.wslRelay);
  }
  const { stdout } = await exec("wsl.exe", ["-e", "env", "CODEX_QUOTA_ROLE=update-history",
    `CODEX_QUOTA_UPDATE_CONTROL=${control.wslControl}`, control.wslExecutable], { windowsHide: true, timeout: 60_000, signal });
  return JSON.parse(stdout);
}
