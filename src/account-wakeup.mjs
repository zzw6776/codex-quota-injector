import { normalizeWakeupTimes } from "./account-store.mjs";
import { sendWakeupRequest } from "./wakeup-client.mjs";

const CHECK_INTERVAL_MS = 15_000;
const MAX_SCHEDULE_DELAY_MS = 60_000;

export class AccountWakeupManager {
  constructor(accountManager, onChange, { sendRequest = sendWakeupRequest } = {}) {
    this.accounts = accountManager;
    this.store = accountManager.store;
    this.onChange = onChange;
    this.sendRequest = sendRequest;
    this.jobs = new Map();
    this.messages = new Map();
    this.queue = Promise.resolve();
    this.abortController = new AbortController();
    this.timer = null;
    this.checkPromise = null;
    this.lastCheckedAt = Date.now();
  }

  async start() {
    for (const account of this.store.list()) {
      if (account.wakeup.lastRun?.status === "running") {
        await this.store.update(account.id, (latest) => ({
          wakeup: { ...latest.wakeup, lastRun: {
            ...latest.wakeup.lastRun,
            status: "error",
            message: "上次唤醒被中断，结果未知，请手动刷新额度确认",
          } },
        }));
      }
    }
    this.lastCheckedAt = Date.now();
    this.timer = setInterval(() => {
      if (this.checkPromise || this.abortController.signal.aborted) return;
      this.checkPromise = this.checkSchedule()
        .catch((error) => console.error(`[wakeup] 定时检查失败：${error.message}`))
        .finally(() => { this.checkPromise = null; });
    }, CHECK_INTERVAL_MS);
  }

  close() {
    clearInterval(this.timer);
    this.timer = null;
    this.abortController.abort(new Error("注入器已停止"));
  }

  getViewModel(accountId) {
    const account = this.store.get(accountId);
    const wakeup = account?.wakeup;
    if (!wakeup) return null;
    return {
      enabled: wakeup.enabled,
      times: wakeup.times,
      nextAt: wakeup.enabled ? nextScheduledAt(wakeup) : null,
      lastRun: wakeup.lastRun,
      busy: this.jobs.has(accountId),
      message: this.messages.get(accountId) ?? null,
    };
  }

  async save(accountId, settings) {
    try {
      const account = this.store.get(accountId);
      if (account?.authMode !== "oauth") throw new Error("仅 OAuth 账号支持定时唤醒");
      const times = normalizeWakeupTimes(settings.times);
      if (settings.enabled && times.length === 0) throw new Error("请至少添加一个唤醒时间");
      await this.store.update(accountId, (latest) => ({
        wakeup: { ...latest.wakeup, enabled: settings.enabled === true, times, updatedAt: Date.now() },
      }));
      this.messages.set(accountId, { status: "success", text: "唤醒设置已保存" });
    } catch (error) {
      this.messages.set(accountId, { status: "error", text: error.message });
    }
    this.onChange();
  }

  async checkSchedule() {
    const now = Date.now();
    const previous = this.lastCheckedAt;
    this.lastCheckedAt = now;
    // Do not replay times missed while the computer was asleep or the clock moved.
    if (now <= previous || now - previous > MAX_SCHEDULE_DELAY_MS) return;
    const date = new Date(now);
    const dateKey = localDateKey(date);
    for (const account of this.store.list()) {
      if (this.abortController.signal.aborted) break;
      const settings = account.wakeup;
      if (account.authMode !== "oauth" || !settings.enabled) continue;
      for (const time of settings.times) {
        const due = localTimeAt(date, time);
        if (!Number.isFinite(due) || due <= previous || due <= settings.updatedAt || due > now) continue;
        if (settings.scheduledDate === dateKey && settings.scheduledTimes.includes(time)) continue;
        // Claim before queuing: a restart or uncertain network result must not resend this slot.
        try {
          await this.store.update(account.id, (latest) => ({
            wakeup: {
              ...latest.wakeup,
              scheduledDate: dateKey,
              scheduledTimes: [...new Set([
                ...(latest.wakeup.scheduledDate === dateKey ? latest.wakeup.scheduledTimes : []), time,
              ])],
            },
          }));
          this.trigger(account.id, { date: dateKey, time });
        } catch (error) {
          if (this.store.get(account.id)) {
            this.messages.set(account.id, { status: "error", text: `无法保存定时执行记录：${error.message}` });
          }
          console.error(`[wakeup] 无法保存定时执行记录：${error.message}`);
        }
      }
    }
    this.onChange();
  }

  trigger(accountId, slot = null) {
    if (this.abortController.signal.aborted || this.jobs.has(accountId)) return;
    if (this.store.get(accountId)?.authMode !== "oauth") return;
    this.messages.set(accountId, { status: "loading", text: "等待唤醒…" });
    // Serial requests avoid process bursts when many accounts share the same time.
    const task = this.queue.catch(() => undefined)
      .then(() => this.run(accountId, slot))
      .catch((error) => {
        this.messages.set(accountId, { status: "error", text: `无法保存唤醒结果：${error.message}` });
        console.error(`[wakeup] 无法保存唤醒结果：${error.message}`);
      })
      .finally(() => {
        this.jobs.delete(accountId);
        this.onChange();
      });
    this.jobs.set(accountId, task);
    this.queue = task;
    this.onChange();
  }

  async run(accountId, slot) {
    const account = this.store.get(accountId);
    if (this.abortController.signal.aborted || !account) return;
    if (slot && (!account.wakeup.enabled || !account.wakeup.times.includes(slot.time))) {
      this.messages.set(accountId, { status: "success", text: "设置已变更，已取消排队的定时唤醒" });
      return;
    }
    const startedAt = Date.now();
    const lastRun = {
      source: slot ? "scheduled" : "manual",
      scheduledTime: slot ? `${slot.date} ${slot.time}` : null,
      startedAt,
      completedAt: null,
      status: "running",
      message: "正在发送唤醒请求…",
      model: null,
      reply: null,
    };
    await this.updateRun(accountId, lastRun);
    this.messages.delete(accountId);
    this.onChange();
    try {
      const result = await this.accounts.withWakeupAccount(accountId, (getCredentials) =>
        this.sendRequest(getCredentials, this.abortController.signal));
      Object.assign(lastRun, result, {
        status: "success",
        completedAt: Date.now(),
        message: "模型已回复，正在刷新额度…",
      });
      await this.updateRun(accountId, lastRun);
      this.onChange();
      try {
        await this.accounts.refreshAccount(accountId);
        lastRun.message = "模型请求完成，额度已刷新；请查看重置时间确认计时情况";
      } catch (error) {
        lastRun.message = `模型请求完成，但额度刷新失败：${error.message}`;
      }
    } catch (error) {
      lastRun.status = "error";
      lastRun.completedAt = Date.now();
      lastRun.message = error.message;
    }
    await this.updateRun(accountId, lastRun);
  }

  async updateRun(accountId, lastRun) {
    if (!this.store.get(accountId)) return;
    await this.store.update(accountId, (latest) => ({
      wakeup: { ...latest.wakeup, lastRun: { ...lastRun } },
    }));
  }
}

function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function localTimeAt(date, time) {
  const [hours, minutes] = time.split(":").map(Number);
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hours, minutes);
  // A nonexistent local time during a daylight-saving jump is skipped.
  return result.getHours() === hours && result.getMinutes() === minutes ? result.getTime() : NaN;
}

function nextScheduledAt(settings) {
  const now = Date.now();
  for (let offset = 0; offset <= 2; offset += 1) {
    const date = new Date(now);
    date.setDate(date.getDate() + offset);
    for (const time of settings.times) {
      if (settings.scheduledDate === localDateKey(date) && settings.scheduledTimes.includes(time)) continue;
      const due = localTimeAt(date, time);
      if (due > now) return due;
    }
  }
  return null;
}
