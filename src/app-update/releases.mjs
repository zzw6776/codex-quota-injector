import { compareVersions } from "../single-instance.mjs";

export const RELEASES_URL = "https://api.github.com/repos/zzw6776/codex-quota-injector/releases/latest";
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const VERSION = /^v?(\d+\.\d+\.\d+)$/;
const DIGEST = /^sha256:([a-f0-9]{64})$/i;

export function releaseUpdate(release, { version, mode, platform = process.platform, arch = process.arch }) {
  const remote = VERSION.exec(String(release?.tag_name ?? ""))?.[1];
  if (!remote || release.draft || release.prerelease) return null;
  const suffix = platform === "darwin" && ["arm64", "x64"].includes(arch)
    ? `macos-${arch}.dmg` : platform === "win32" && arch === "x64" ? "windows-x64-Setup.exe" : null;
  if (!suffix) return null;
  const name = `Codex-Quota-Injector-${remote}-${suffix}`;
  const asset = release.assets?.find(item => item.name === name && item.state === "uploaded");
  if (!asset || !Number.isInteger(asset.id) || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 1024 ** 3) return null;
  const url = new URL(asset.browser_download_url);
  if (url.origin !== "https://github.com" ||
      url.pathname !== `/zzw6776/codex-quota-injector/releases/download/${release.tag_name}/${name}`) return null;
  if (mode !== "dev" && compareVersions(remote, version) <= 0) return null;
  return { version: remote, assetId: asset.id, name, size: asset.size, url: url.href,
    releaseNotes: typeof release.body === "string" ? release.body.trim() : "",
    sha256: DIGEST.exec(String(asset.digest ?? ""))?.[1]?.toLowerCase() ?? null,
    platform, arch };
}

export async function fetchRelease({ fetchImpl = fetch, etag = null } = {}) {
  const response = await fetchImpl(RELEASES_URL, { headers: {
    Accept: "application/vnd.github+json", "User-Agent": "codex-quota-injector",
    ...(etag ? { "If-None-Match": etag } : {}),
  }, signal: AbortSignal.timeout(15_000) });
  if (response.status === 304) return { unchanged: true, etag };
  if (!response.ok) throw new Error(`GitHub 更新检查失败（HTTP ${response.status}）`);
  return { release: await response.json(), etag: response.headers.get("etag") };
}
