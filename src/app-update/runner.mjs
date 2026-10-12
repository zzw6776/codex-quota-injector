import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { closeSingleInstance } from "../single-instance.mjs";
import { downloadUpdate } from "./download.mjs";
import { inspectUpdateHistory } from "./history.mjs";
import { prepareNativeUpdate, stopForUpdate, installNativeUpdate, launchUpdatedApp,
  updatedAppReady, inspectWslUpdateHistory } from "./native-install.mjs";
import { startUpdateWindowServer } from "./window.mjs";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createUpdateRun(control, { onState = () => {}, download = downloadUpdate,
  prepare = prepareNativeUpdate, history = inspectUpdateHistory, wslHistory = inspectWslUpdateHistory,
  stop = stopForUpdate, releaseLock = closeSingleInstance, install = installNativeUpdate,
  launch = launchUpdatedApp, ready = updatedAppReady, sleep = delay, now = Date.now } = {}) {
  let state = { id: control.id, status: "confirm", mode: control.owner.mode,
    currentVersion: control.owner.version, version: control.asset.version, received: 0,
    total: control.asset.size, message: "是否更新到这个正式版本？" };
  let started = false, tracked = [], lock = null;
  const publish = patch => { state = { ...state, ...patch }; onState(state); };
  const probe = async () => {
    const result = control.wslNative ? await wslHistory(control) : await history(control, tracked);
    tracked = result.tracked;
    return result;
  };
  async function run() {
    try {
      publish({ status: "downloading", message: "正在下载安装包" });
      await probe();
      const path = await download(control.asset, join(control.directory, control.asset.name), {
        onProgress: (received, total) => publish({ received, total }),
      });
      publish({ status: "verifying", message: "校验文件、版本和架构" });
      const prepared = await prepare(control, path);
      publish({ status: "waiting", message: "确认任务已结束并保存" });
      const deadline = now() + 30 * 60_000;
      let stable = null;
      while (true) {
        const result = await probe();
        if (result.ready) {
          const signature = JSON.stringify(result.tracked);
          if (stable === signature) break;
          stable = signature;
        } else { stable = null; publish({ message: result.reason }); }
        if (now() >= deadline) throw new Error("等待任务结束或历史落盘超时，未执行更新接管");
        await sleep(1000);
      }
      publish({ status: "installing", message: "正在替换正式版本" });
      lock = await stop(control);
      if (control.asset.platform === "win32") { await releaseLock(lock); lock = null; }
      await install(control, prepared);
      if (lock) { await releaseLock(lock); lock = null; }
      publish({ status: "launching", message: "已替换，正在启动并确认正式版" });
      await launch(control);
      const launchDeadline = now() + 90_000;
      while (!await ready(control)) {
        if (now() >= launchDeadline) throw new Error("应用已替换，但未确认正式版启动成功，请查看启动日志");
        await sleep(500);
      }
      publish({ status: "success", message: `正式版 ${control.asset.version} 已启动，更新成功` });
    } catch (error) {
      if (lock) await releaseLock(lock).catch(() => {});
      publish({ failedStage: state.status, status: "failed", message: error.message });
    }
    return state;
  }
  let completion = null;
  return { get state() { return state; }, get completion() { return completion; },
    confirm() { if (started) return completion; started = true; completion = run(); return completion; } };
}

export async function runAppUpdater() {
  process.title = "Quota Update Worker";
  const control = JSON.parse(await readFile(process.env.CODEX_QUOTA_UPDATE_CONTROL, "utf8"));
  let writeTail = Promise.resolve(), windowChild, window, closing = false;
  const statePath = join(control.directory, "status.json");
  const run = createUpdateRun(control, { onState(state) {
    writeTail = writeTail.then(async () => {
      await writeFile(`${statePath}.tmp`, JSON.stringify(state), { mode: 0o600 });
      await rename(`${statePath}.tmp`, statePath);
    }).catch(error => console.error(`[update] 状态记录失败：${error.message}`));
  } });
  const shutdown = async () => {
      if (closing) return;
      closing = true;
      windowChild?.kill();
      await writeTail;
      const registered = await readFile(control.registryPath, "utf8").then(JSON.parse).catch(() => null);
      if (registered?.id === control.id) await unlink(control.registryPath).catch(() => {});
      await window.close();
  };
  window = await startUpdateWindowServer({ state: () => run.state,
    confirm: () => { void run.confirm(); }, close: shutdown,
    show: () => { if (process.platform === "darwin") windowChild?.kill("SIGUSR1"); } });
  const descriptor = { id: control.id, pid: process.pid, url: window.url, logPath: join(control.directory, "updater.log") };
  await writeFile(`${control.registryPath}.tmp`, JSON.stringify(descriptor), { mode: 0o600 });
  await rename(`${control.registryPath}.tmp`, control.registryPath);
  const args = process.platform === "darwin" ? [window.url] : ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", control.windowScript, "-Url", window.url];
  console.log(`[update] 状态服务已启动：${window.url}`);
  windowChild = spawn(control.windowExecutable, args, { stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
  windowChild.once("error", error => {
    console.error(`[update] 状态窗口启动失败：${error.message}`);
    void shutdown();
  });
  windowChild.once("exit", (code, signal) => {
    if (!closing) console.log(`[update] 状态窗口已退出：code=${code}, signal=${signal}`);
    // Closing a terminal window is a user action. During installation the
    // worker and its status server must survive a viewer's unexpected exit.
    if (["confirm", "success", "failed"].includes(run.state.status)) {
      void shutdown();
    }
  });
}
