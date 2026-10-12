import { createHash } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";

export async function downloadUpdate(asset, path, { fetchImpl = fetch, onProgress = () => {}, signal } = {}) {
  if (!/^[a-f0-9]{64}$/.test(asset.sha256 ?? "")) throw new Error("发布包缺少 SHA-256 校验信息，无法自动安装");
  const temporary = `${path}.part`;
  let file;
  try {
    signal?.throwIfAborted();
    const response = await fetchImpl(asset.url, { signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]) : AbortSignal.timeout(10 * 60_000) });
    if (!response.ok || !response.body) throw new Error(`安装包下载失败（HTTP ${response.status}）`);
    file = await open(temporary, "wx", 0o600);
    const hash = createHash("sha256");
    let received = 0, notifiedAt = 0;
    for await (const bytes of response.body) {
      signal?.throwIfAborted();
      received += bytes.length;
      if (received > asset.size) throw new Error("下载文件超过发布包声明大小");
      hash.update(bytes);
      // FileHandle.write can perform a short write; writeFile writes the whole chunk.
      await file.writeFile(bytes);
      if (Date.now() - notifiedAt >= 100 || received === asset.size) {
        notifiedAt = Date.now(); onProgress(received, asset.size);
      }
    }
    signal?.throwIfAborted();
    if (received !== asset.size || hash.digest("hex") !== asset.sha256) throw new Error("安装包大小或 SHA-256 校验失败");
    await file.close(); file = null;
    await rename(temporary, path);
    return path;
  } catch (error) {
    await file?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
