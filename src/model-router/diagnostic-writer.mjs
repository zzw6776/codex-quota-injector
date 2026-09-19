import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname, extname, basename, join } from "node:path";
import { secureDiagnosticPath } from "./diagnostic-permissions.mjs";

const DEFAULT_MAX_DIAGNOSTIC_FILE_BYTES = 256 * 1024 * 1024;

function archivePath(path, sessionId, rotation) {
  const extension = extname(path);
  const stem = basename(path, extension);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(dirname(path), `${stem}.${timestamp}.${sessionId.slice(0, 8)}.${rotation}${extension}`);
}

function createDiagnosticEventWriter(path, {
  maxFileBytes = DEFAULT_MAX_DIAGNOSTIC_FILE_BYTES,
  log = message => console.error(message),
} = {}) {
  const sessionId = randomUUID();
  let sequence = 0;
  let rotation = 0;
  let currentBytes = null;
  let buffer = [];
  let flushTimer = null;
  let closed = false;
  let tail = Promise.resolve();
  let warnedPermissions = false;
  let securedCurrent = false;
  const directoryReady = path ? mkdir(dirname(path), { recursive: true, mode: 0o700 }) : Promise.resolve();
  const prepare = async () => {
    await directoryReady;
    if (currentBytes == null) currentBytes = await stat(path).then(value => value.size).catch(error => {
      if (error.code === "ENOENT") return 0;
      throw error;
    });
  };
  const secureAndCheck = async () => {
    if (securedCurrent) return;
    const hostAclSecured = await secureDiagnosticPath(path, log);
    securedCurrent = true;
    if (warnedPermissions || process.platform === "win32") return;
    const mode = (await stat(path)).mode & 0o777;
    if (!hostAclSecured && (mode & 0o077) !== 0) {
      warnedPermissions = true;
      log(`[model-router] 全量请求日志权限为 ${mode.toString(8)}；挂载文件系统未执行 0600，需核对宿主 ACL：${path}`);
    }
  };
  const flush = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!path || buffer.length === 0) return tail;
    const batch = buffer;
    buffer = [];
    tail = tail.then(async () => {
      await prepare();
      let content = "";
      let contentBytes = 0;
      const append = async () => {
        if (!content) return;
        await appendFile(path, content, { encoding: "utf8", mode: 0o600 });
        currentBytes += contentBytes;
        content = "";
        contentBytes = 0;
        await secureAndCheck();
      };
      for (const payload of batch) {
        const line = `${JSON.stringify(payload)}\n`;
        const lineBytes = Buffer.byteLength(line);
        if (currentBytes + contentBytes > 0 && currentBytes + contentBytes + lineBytes > maxFileBytes) {
          await append();
          if (currentBytes > 0) {
            await secureAndCheck();
            await rename(path, archivePath(path, sessionId, ++rotation));
            currentBytes = 0;
            securedCurrent = false;
          }
        }
        content += line;
        contentBytes += lineBytes;
      }
      await append();
    }).catch(error => {
      log(`[model-router] 记录全量模型请求失败：${error.message}`);
    });
    return tail;
  };
  return {
    write(event) {
      if (closed || !path || !event?.type) return;
      buffer.push({ ...event, eventId: `${sessionId}:${++sequence}`, recordedAt: Date.now() });
      if (buffer.length >= 32) void flush();
      else if (!flushTimer) flushTimer = setTimeout(() => void flush(), 25);
    },
    close: async () => {
      closed = true;
      await flush();
      await tail;
    },
  };
}

export { DEFAULT_MAX_DIAGNOSTIC_FILE_BYTES, createDiagnosticEventWriter };
