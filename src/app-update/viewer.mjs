export function createUpdateViewer({ spawn, focus = () => true, invalidate = () => {}, log = () => {} }) {
  let child = null, error = null, closed = false;
  const unavailable = (viewer, message) => {
    if (closed || child !== viewer) return;
    child = null;
    error = message;
    invalidate();
    log(message);
  };
  return {
    get state() { return { windowPid: child?.pid ?? null, windowError: error }; },
    show() {
      if (closed) throw new Error("更新窗口服务已关闭");
      if (child && child.exitCode == null && child.signalCode == null && focus(child)) return;
      error = null;
      invalidate();
      let viewer;
      try { viewer = spawn(); }
      catch (cause) {
        child = null;
        error = `状态窗口启动失败：${cause.message}`;
        throw cause;
      }
      child = viewer;
      viewer.once("error", cause => unavailable(viewer, `状态窗口启动失败：${cause.message}`));
      viewer.once("exit", (code, signal) => unavailable(viewer,
        `状态窗口已退出（${signal ? `信号 ${signal}` : `退出码 ${code}`}）`));
    },
    close() { closed = true; child?.kill(); child = null; invalidate(); },
  };
}
