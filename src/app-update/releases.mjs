import { compareVersions } from "../single-instance.mjs";

export const RELEASES_URL = "https://api.github.com/repos/zzw6776/codex-quota-injector/releases?per_page=100";
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const VERSION = /^v?(\d+\.\d+\.\d+)$/;
const DIGEST = /^sha256:([a-f0-9]{64})$/i;
const RELEASES_PATH = "/repos/zzw6776/codex-quota-injector/releases";

export function releaseUpdate(release, { version, mode, platform = process.platform, arch = process.arch }, releases = [release]) {
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
    releaseNotes: combinedReleaseNotes(release, releases, version, remote),
    sha256: DIGEST.exec(String(asset.digest ?? ""))?.[1]?.toLowerCase() ?? null,
    platform, arch };
}

export async function fetchRelease({ fetchImpl = fetch, etag = null } = {}) {
  const releases = [];
  let url = RELEASES_URL, first = true, nextEtag = null;
  while (url) {
    const response = await fetchImpl(url, { headers: {
      Accept: "application/vnd.github+json", "User-Agent": "codex-quota-injector",
      ...(first && etag ? { "If-None-Match": etag } : {}),
    }, signal: AbortSignal.timeout(15_000) });
    if (first && response.status === 304) return { unchanged: true, etag };
    if (!response.ok) throw new Error(`GitHub 更新检查失败（HTTP ${response.status}）`);
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error("GitHub 更新检查返回了无效的发布列表");
    if (first) nextEtag = response.headers.get("etag");
    releases.push(...page);
    url = nextReleasePage(response.headers.get("link"));
    first = false;
  }
  const release = releases.find(item => VERSION.test(String(item?.tag_name ?? "")) && !item.draft && !item.prerelease);
  return { release, releases, etag: nextEtag };
}

function combinedReleaseNotes(release, releases, currentVersion, targetVersion) {
  const upgrading = compareVersions(targetVersion, currentVersion) > 0;
  const seen = new Set(), selected = [];
  for (const item of [release, ...(Array.isArray(releases) ? releases : [])]) {
    const version = VERSION.exec(String(item?.tag_name ?? ""))?.[1];
    if (!version || item.draft || item.prerelease || seen.has(version)) continue;
    if (upgrading
      ? compareVersions(version, currentVersion) <= 0 || compareVersions(version, targetVersion) > 0
      : version !== targetVersion) continue;
    seen.add(version);
    selected.push({ version, body: typeof item.body === "string" ? item.body.trim() : "" });
  }
  selected.sort((left, right) => compareVersions(right.version, left.version));
  return selected.map(item => item.body || `# ${item.version}\n\n该版本暂无更新日志`).join("\n\n");
}

function nextReleasePage(link) {
  const part = String(link ?? "").split(",").find(item => /;\s*rel="next"\s*$/.test(item));
  const href = /^\s*<([^>]+)>/.exec(part ?? "")?.[1];
  if (!href) return null;
  const url = new URL(href);
  if (url.origin !== "https://api.github.com" || url.pathname !== RELEASES_PATH) {
    throw new Error("GitHub 更新检查返回了无效的分页地址");
  }
  return url.href;
}
