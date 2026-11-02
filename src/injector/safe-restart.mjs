import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { inspectWslUpdateHistory } from "../app-update/native-install.mjs";
import {
  inspectCodexShutdownReadiness,
  waitForCodexShutdownReadiness,
} from "../lifecycle-shutdown-gate.mjs";

export function createSafeRestartCoordinator({
  getLaunchOptions = () => null,
  getThreadId = () => null,
  restart,
  onChange = () => {},
  createInspector = createShutdownInspector,
  waitForReady = waitForCodexShutdownReadiness,
  timeoutMs = Number.POSITIVE_INFINITY,
} = {}) {
  if (typeof restart !== "function") throw new TypeError("缺少 Codex 重启实现");
  let operation = null;
  let pending = null;
  let cancellation = null;
  let forceRequested = false;

  const publish = (next) => {
    const normalized = next ? { ...next } : null;
    if (JSON.stringify(normalized) === JSON.stringify(operation)) return;
    operation = normalized;
    onChange(getViewModel());
  };

  function getViewModel() {
    return operation ? { ...operation } : null;
  }

  function request() {
    if (pending) return pending;
    forceRequested = false;
    cancellation = new AbortController();
    const signal = cancellation.signal;
    pending = Promise.resolve().then(async () => {
      publish({ phase: "waiting", message: "正在确认活动回合与任务历史" });
      let inspector = null;
      try {
        inspector = await createInspector({
          launchOptions: getLaunchOptions?.(),
          threadId: getThreadId?.() ?? null,
          signal,
        });
        await waitForReady({
          inspect: inspector.inspect,
          timeoutMs,
          signal,
          onStatus(result) {
            publish({
              phase: "waiting",
              message: result.ready ? "正在确认任务历史稳定" : result.reason,
            });
          },
        });
      } catch (error) {
        if (!forceRequested || !signal.aborted) throw error;
      } finally {
        try {
          await inspector?.close?.();
        } catch (error) {
          if (!forceRequested) throw error;
        }
      }
      if (!forceRequested) signal.throwIfAborted();
      publish({ phase: "restarting", message: forceRequested
        ? "已确认强制重启，正在重启 Codex"
        : "任务已保存，正在重启 Codex" });
      await restart();
      publish(null);
    }).catch((error) => {
      // Force aborts only the safety wait. Restart failures still need a
      // retryable state; close() clears forceRequested to suppress shutdown.
      if (!signal.aborted || forceRequested) {
        publish({ phase: "failed", message: `安全重启失败：${error.message}` });
      }
      throw error;
    }).finally(() => {
      pending = null;
      cancellation = null;
      forceRequested = false;
    });
    return pending;
  }

  function force() {
    if (!pending || operation?.phase !== "waiting") {
      return pending ?? Promise.reject(new Error("当前没有等待中的安全重启"));
    }
    forceRequested = true;
    publish({ phase: "restarting", message: "已确认强制重启，正在停止安全等待" });
    cancellation.abort(new Error("用户确认强制重启"));
    return pending;
  }

  function close() {
    forceRequested = false;
    cancellation?.abort(new Error("注入器已停止"));
  }

  return { request, force, close, getViewModel, get pending() { return pending; } };
}

export async function createShutdownInspector({ launchOptions, threadId, signal } = {}) {
  signal?.throwIfAborted();
  if (launchOptions?.relay?.wslNative !== true) {
    return {
      inspect: (tracked) => inspectCodexShutdownReadiness({ threadId }, tracked),
      async close() {},
    };
  }

  const source = String(launchOptions?.env?.CODEX_CLI_PATH ?? "").trim();
  if (!source) throw new Error("缺少当前 WSL 历史检查运行时");
  const directory = await mkdtemp(join(tmpdir(), "codex-quota-safe-restart-"));
  const wslRelay = join(directory, "history-relay");
  try {
    await copyFile(source, wslRelay);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const control = { directory, wslRelay, threadId };
  return {
    inspect: (_tracked, options = {}) => inspectWslUpdateHistory(control, options),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}
