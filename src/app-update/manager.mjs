import { isSea } from "node:sea";
import { defaultAccountDataDir } from "../platform/directories.mjs";
import { readSingleInstanceStatus } from "../single-instance.mjs";
import { fetchRelease, releaseUpdate, UPDATE_CHECK_INTERVAL_MS } from "./releases.mjs";
import { launchUpdateWindow } from "./launch.mjs";
import { warmUpdateWindow } from "./window-executable.mjs";

export class AppUpdateManager {
  constructor({ version, mode = isSea() ? "formal" : "dev", platform = process.platform, arch = process.arch,
    dataDir = defaultAccountDataDir(), fetchLatest = fetchRelease, launch = launchUpdateWindow,
    readOwner = readSingleInstanceStatus, onChange = () => {}, intervalMs = UPDATE_CHECK_INTERVAL_MS } = {}) {
    Object.assign(this, { version, mode, platform, arch, dataDir, fetchLatest, launch, readOwner, onChange, intervalMs });
    this.view = { status: "idle", available: false, version: null, error: null, opening: false };
    this.asset = null; this.etag = null; this.checking = null; this.opening = null; this.closed = false;
  }
  getViewModel() { return this.view; }
  publish(patch) { if (this.closed) return; this.view = { ...this.view, ...patch }; this.onChange(); }
  start() {
    if (this.timer || this.closed) return;
    void warmUpdateWindow().catch(error => console.warn(`[update] 窗口预编译失败，点击时将重试：${error.message}`));
    void this.check(); this.timer = setInterval(() => void this.check(), this.intervalMs); this.timer.unref?.();
  }
  close() { this.closed = true; clearInterval(this.timer); }
  check() {
    if (this.checking) return this.checking;
    this.checking = (async () => {
      try {
        const result = await this.fetchLatest({ etag: this.etag });
        if (this.closed) return false;
        if (result.unchanged) {
          this.publish({ status: "ready", checkError: null, error: null });
          return true;
        }
        this.etag = result.etag;
        this.asset = releaseUpdate(result.release, this);
        this.publish({ status: "ready", available: this.asset != null, version: this.asset?.version ?? null,
          checkError: null, error: null });
        return true;
      } catch (error) { this.publish({ status: "failed", checkError: error.message }); return false; }
    })().finally(() => { this.checking = null; });
    return this.checking;
  }
  open(options = {}) {
    if (this.opening) return this.opening;
    this.publish({ error: null, opening: true, requestId: options.requestId ?? null });
    this.opening = (async () => {
      // A click must start its own check after any older background request.
      if (this.checking) await this.checking;
      if (!await this.check()) throw new Error(this.view.checkError ?? "无法确认远端最新版本，请重试");
      if (!this.asset) return null;
      const owner = await this.readOwner();
      if (owner.pid !== process.pid || owner.mode !== this.mode) throw new Error("运行实例已变化，请重新打开更新入口");
      return this.launch(this.asset, { ...options, dataDir: this.dataDir, owner });
    })().catch(error => { this.publish({ error: error.message }); throw error; })
      .finally(() => { this.opening = null; this.publish({ opening: false }); });
    return this.opening;
  }
}
