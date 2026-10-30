const RELEASES_URL = "https://api.github.com/repos/openai/codex/releases?per_page=10";
const RELEASE_TAG = /^rust-v(.+)$/;
const DIGEST = /^sha256:([a-f0-9]{64})$/i;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const MAX_ASSET_SIZE = 512 * 1024 * 1024;
const MCP_CONNECTION_SHARING_MIN_VERSION = "0.166.0-alpha.1";

function parseCodexVersion(value) {
  const match = VERSION.exec(String(value ?? "").trim());
  if (!match) return null;
  return {
    raw: match[0],
    core: match.slice(1, 4).map(Number),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function compareCodexVersions(leftValue, rightValue) {
  const left = parseCodexVersion(leftValue);
  const right = parseCodexVersion(rightValue);
  if (!left || !right) throw new Error("Codex 版本号格式无效");
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) {
      return left.core[index] < right.core[index] ? -1 : 1;
    }
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length
      ? 0
      : left.prerelease.length === 0 ? 1 : -1;
  }
  const count = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart == null || rightPart == null) {
      return leftPart == null && rightPart == null ? 0 : leftPart == null ? -1 : 1;
    }
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) < Number(rightPart) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function codexAssetName(arch) {
  if (arch === "arm64") return "codex-aarch64-apple-darwin.tar.gz";
  if (arch === "x64") return "codex-x86_64-apple-darwin.tar.gz";
  return null;
}

function codeModeHostAssetName(arch) {
  if (arch === "arm64") return "codex-code-mode-host-aarch64-apple-darwin.tar.gz";
  if (arch === "x64") return "codex-code-mode-host-x86_64-apple-darwin.tar.gz";
  return null;
}

function releaseAsset(release, name) {
  const asset = release.assets?.find((item) => item?.name === name && item?.state === "uploaded");
  if (!asset || !Number.isInteger(asset.id) || !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 || asset.size > MAX_ASSET_SIZE) return null;
  let url;
  try {
    url = new URL(asset.browser_download_url);
  } catch {
    return null;
  }
  const expectedPath = `/openai/codex/releases/download/${release.tag_name}/${name}`;
  const sha256 = DIGEST.exec(String(asset.digest ?? ""))?.[1]?.toLowerCase() ?? null;
  if (url.origin !== "https://github.com" || url.pathname !== expectedPath || !sha256) return null;
  return {
    assetId: asset.id,
    name,
    size: asset.size,
    sha256,
    url: url.href,
  };
}

function supportsMcpConnectionSharing(version) {
  try {
    return compareCodexVersions(version, MCP_CONNECTION_SHARING_MIN_VERSION) >= 0;
  } catch {
    return false;
  }
}

function releaseVersion(release, channel) {
  const version = RELEASE_TAG.exec(String(release?.tag_name ?? ""))?.[1] ?? null;
  const parsed = parseCodexVersion(version);
  if (!parsed || release?.draft) return null;
  if (channel === "alpha") {
    if (!release?.prerelease || parsed.prerelease[0] !== "alpha") return null;
  } else if (channel === "stable") {
    if (release?.prerelease || parsed.prerelease.length > 0) return null;
  } else {
    return null;
  }
  return version;
}

function codexReleaseCandidate(releases, {
  arch = process.arch,
  channel = "alpha",
} = {}) {
  const cliName = codexAssetName(arch);
  const codeModeHostName = codeModeHostAssetName(arch);
  if (!cliName || !codeModeHostName || !Array.isArray(releases)) return null;
  const candidates = [];
  for (const release of releases) {
    const version = releaseVersion(release, channel);
    if (!version) continue;
    const codex = releaseAsset(release, cliName);
    const codeModeHost = releaseAsset(release, codeModeHostName);
    if (!codex || !codeModeHost) continue;
    candidates.push({
      version,
      tag: release.tag_name,
      size: codex.size + codeModeHost.size,
      components: { codex, codeModeHost },
      channel,
      publishedAt: typeof release.published_at === "string" ? release.published_at : null,
    });
  }
  candidates.sort((left, right) => compareCodexVersions(right.version, left.version));
  return candidates[0] ?? null;
}

async function fetchCodexReleases({ fetchImpl = fetch, etag = null } = {}) {
  const response = await fetchImpl(RELEASES_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "codex-quota-injector",
      ...(etag ? { "If-None-Match": etag } : {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 304) return { unchanged: true, etag };
  if (!response.ok) throw new Error(`GitHub Codex 版本检查失败（HTTP ${response.status}）`);
  const releases = await response.json();
  if (!Array.isArray(releases)) throw new Error("GitHub Codex 版本响应格式无效");
  return { releases, etag: response.headers.get("etag") };
}

export {
  RELEASES_URL,
  MCP_CONNECTION_SHARING_MIN_VERSION,
  codeModeHostAssetName,
  codexAssetName,
  codexReleaseCandidate,
  compareCodexVersions,
  fetchCodexReleases,
  parseCodexVersion,
  supportsMcpConnectionSharing,
};
