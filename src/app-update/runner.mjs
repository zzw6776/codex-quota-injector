import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { closeSingleInstance } from "../single-instance.mjs";
import { downloadUpdate } from "./download.mjs";
import { inspectUpdateHistory } from "./history.mjs";
import { prepareNativeUpdate, stopForUpdate, installNativeUpdate, launchUpdatedApp,
  updatedAppReady, inspectWslUpdateHistory } from "./native-install.mjs";
import { startUpdateWindowServer } from "./window.mjs";
import { createUpdateViewer } from "./viewer.mjs";

const delay = (ms, { signal } = {}) => wait(ms, undefined, { signal });

export function createUpdateRun(control, { onState = () => {}, download = downloadUpdate,
  prepare = prepareNativeUpdate, history = inspectUpdateHistory, wslHistory = inspectWslUpdateHistory,
  stop = stopForUpdate, releaseLock = closeSingleInstance, install = installNativeUpdate,
  launch = launchUpdatedApp, ready = updatedAppReady, sleep = delay, now = Date.now } = {}) {
  let state = { id: control.id, status: "confirm", mode: control.owner.mode,
    ownerPid: control.owner.pid, assetId: control.asset.assetId,
    currentVersion: control.owner.version, version: control.asset.version, received: 0,
    total: control.asset.size, message: "是否更新到这个正式版本？" };
  let started = false, tracked = [], lock = null;
  const cancellation = new AbortController();
  const options = { signal: cancellation.signal };
  const checkpoint = () => cancellation.signal.throwIfAborted();
  const publish = patch => { state = { ...state, ...patch }; onState(state); };
  const probe = async () => {
    checkpoint();
    const result = control.wslNative ? await wslHistory(control, options) : await history(control, tracked);
    checkpoint();
    tracked = result.tracked;
    return result;
  };
  async function run() {
    try {
      checkpoint();
      publish({ status: "downloading", message: "正在下载安装包" });
      await probe();
      const path = await download(control.asset, join(control.directory, control.asset.name), {
        ...options,
        onProgress: (received, total) => publish({ received, total }),
      });
      checkpoint();
      publish({ status: "verifying", message: "校验文件、版本和架构" });
      const prepared = await prepare(control, path, options);
      checkpoint();
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
        await sleep(1000, options);
      }
      publish({ status: "installing", message: "正在替换正式版本" });
      checkpoint();
      lock = await stop(control, options);
      checkpoint();
      if (control.asset.platform === "win32") { await releaseLock(lock); lock = null; }
      await install(control, prepared, options);
      checkpoint();
      if (lock) { await releaseLock(lock); lock = null; }
      publish({ status: "launching", message: "已替换，正在启动并确认正式版" });
      await launch(control, options);
      checkpoint();
      const launchDeadline = now() + 90_000;
      while (!await ready(control, options)) {
        checkpoint();
        if (now() >= launchDeadline) throw new Error("应用已替换，但未确认正式版启动成功，请查看启动日志");
        await sleep(500, options);
      }
      checkpoint();
      publish({ status: "success", message: `正式版 ${control.asset.version} 已启动，更新成功` });
    } catch (error) {
      if (lock) await releaseLock(lock).catch(() => {});
      if (cancellation.signal.aborted) {
        const late = ["installing", "launching"].includes(state.status);
        publish({ cancelledStage: state.status, status: "cancelled", terminating: false,
          message: late ? "更新已终止；可能已执行部分替换或启动，请核对正式应用。未自动回滚或关闭已启动的应用。"
            : "更新已终止，未替换正式应用" });
      } else publish({ failedStage: state.status, status: "failed", message: error.message });
    }
    return state;
  }
  let completion = null;
  return { get state() { return state; }, get completion() { return completion; },
    terminate() {
      if (["success", "failed", "cancelled"].includes(state.status) || cancellation.signal.aborted) return completion;
      cancellation.abort(new Error("用户终止更新"));
      if (!started) {
        started = true;
        publish({ status: "cancelled", cancelledStage: "confirm", message: "更新已终止，未开始下载" });
        completion = Promise.resolve(state);
      } else publish({ terminating: true, message: "正在终止更新，等待当前操作结束…" });
      return completion;
    },
    confirm() { if (started) return completion; started = true; completion = run(); return completion; } };
}

export async function runAppUpdater() {
  process.title = "Quota Update Worker";
  const control = JSON.parse(await readFile(process.env.CODEX_QUOTA_UPDATE_CONTROL, "utf8"));
  let writeTail = Promise.resolve(), viewer, window, closing = false;
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
      viewer?.close();
      await writeTail;
      const registered = await readFile(control.registryPath, "utf8").then(JSON.parse).catch(() => null);
      if (registered?.id === control.id) await unlink(control.registryPath).catch(() => {});
      await window.close();
  };
  window = await startUpdateWindowServer({ state: () => ({ ...run.state, ...viewer?.state }),
    confirm: () => { void run.confirm(); }, terminate: () => { void run.terminate(); }, close: shutdown,
    show: () => viewer?.show() });
  const descriptor = { id: control.id, pid: process.pid, url: window.url, logPath: join(control.directory, "updater.log") };
  await writeFile(`${control.registryPath}.tmp`, JSON.stringify(descriptor), { mode: 0o600 });
  await rename(`${control.registryPath}.tmp`, control.registryPath);
  const args = process.platform === "darwin" ? [window.url] : ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", control.windowScript, "-Url", window.url];
  console.log(`[update] 状态服务已启动：${window.url}`);
  viewer = createUpdateViewer({
    spawn: () => spawn(control.windowExecutable, args, { stdio: ["ignore", "inherit", "inherit"], windowsHide: true }),
    focus: child => process.platform === "darwin" ? child.kill("SIGUSR1") : true,
    invalidate: () => window.invalidateReady(),
    log: message => console.error(`[update] ${message}`),
  });
  viewer.show();
}
