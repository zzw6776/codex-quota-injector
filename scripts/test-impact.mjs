import { createHash } from 'node:crypto';

export const TEST_EVIDENCE_VERSION = 1;
export const TEST_SCOPES = ['free', 'backend', 'desktop', 'lifecycle'];
export const TEST_RUNTIMES = ['macos-native', 'windows-native', 'wsl-native'];
const digest = value => createHash('sha256').update(value).digest('hex');

// Unknown executable/configuration inputs deliberately retain the broad scope.
// Narrow rules describe separable entry points, not guessed functional equivalence.
export function testImpactForPath(path) {
  path = path.replaceAll('\\', '/');
  const devLauncherRuntime = ['启动开发版.command', 'scripts/start-injector-macos.sh'].includes(path)
    ? ['macos-native']
    : ['启动开发版.cmd', 'scripts/start-injector-windows.ps1', 'scripts/windows-dev-dependencies.ps1',
      'scripts/dev-launch-console.ps1', 'scripts/dev-launch-log-reader.ps1'].includes(path)
      ? ['windows-native', 'wsl-native'] : null;
  let scopes = [...TEST_SCOPES];
  let reason = '共享实现或未细分的执行输入';
  if (/\.md$/.test(path) || path.startsWith('preview/')) {
    scopes = []; reason = '说明文档或展示预览';
  } else if (devLauncherRuntime) {
    scopes = ['free']; reason = '独立开发启动入口与日志观察，不被模型验收或正式启停执行器加载';
  } else if (path === 'src/widget.mjs' || path.startsWith('src/widget/')) {
    scopes = ['free', 'desktop']; reason = '页面运行时，不改变后台模型与启停编排';
  } else if (path === 'src/lifecycle-host.mjs') {
    scopes = ['free', 'desktop', 'lifecycle']; reason = '桌面验收与启停恢复共享的宿主检查';
  } else if (/^(?:src|scripts)\/lifecycle(?:[-/.])/.test(path) || /^scripts\/test-lifecycle/.test(path)) {
    scopes = ['free', 'lifecycle']; reason = '启停恢复实现或材料';
  } else if (/^scripts\/(?:desktop-host|test-desktop|test-computer-use|windows-test-host)/.test(path) || /^test\/desktop-host/.test(path)) {
    scopes = ['free', 'desktop']; reason = '桌面验收执行器或判据';
  } else if (path === 'live-tests/runtime.mjs') {
    scopes = ['free', 'backend', 'desktop']; reason = '后台材料及桌面共享的供应商配置';
  } else if (path.startsWith('live-tests/') || path === 'scripts/test-live.mjs') {
    scopes = ['free', 'backend']; reason = '后台模型验收执行器或材料';
  } else if (path.startsWith('runtime-tests/support/') || /^scripts\/build-(?:windows|wsl)-relay\.mjs$/.test(path)) {
    scopes = [...TEST_SCOPES]; reason = '真实模型共用材料或正式原生Relay构建输入';
  } else if (path.startsWith('test/') || path.startsWith('runtime-tests/') || path === 'scripts/test-offline.mjs' || /^docs\/testing-(?:scenarios|protocol-inventory)\.json$/.test(path)) {
    scopes = ['free']; reason = '免费回归用例、材料或场景索引';
  } else if (/^(?:installer|assets|\.github)\//.test(path) || /^scripts\/(?:build-|package-|windows-installer|windows-sea)/.test(path)) {
    scopes = ['free', 'lifecycle']; reason = '构建、正式包或安装输入';
  }
  // Shared Windows desktop code also applies when its app-server runs in WSL.
  const runtimes = devLauncherRuntime ?? (/(?:^|\/)(?:macos[-/]|[^/]+\.swift$)/.test(path)
    ? ['macos-native']
    : /(?:^|\/)wsl[-/]/.test(path) ? ['windows-native', 'wsl-native']
    : /(?:^|\/)windows[-/]/.test(path) || path.startsWith('installer/')
      ? ['windows-native', 'wsl-native'] : [...TEST_RUNTIMES]);
  return { scopes, runtimes, reason };
}

export function evidenceFile(path, bytes) {
  let effective = bytes;
  let runtimeSha256;
  if (path === 'package.json' || path === 'package-lock.json') {
    const value = JSON.parse(String(bytes));
    delete value.version;
    if (path === 'package-lock.json' && value.packages?.['']) delete value.packages[''].version;
    effective = JSON.stringify(value);
    delete value.scripts;
    runtimeSha256 = digest(JSON.stringify(value));
  }
  return { path, sha256: digest(effective), rawSha256: digest(bytes), ...(runtimeSha256 ? { runtimeSha256 } : {}) };
}

export function evidenceManifest(files, releaseVersion) {
  files = [...files].sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const hashFiles = selected => digest(JSON.stringify(selected.map(f => [f.path, f.sha256])));
  const fingerprints = Object.fromEntries(TEST_SCOPES.map(scope => [scope,
    Object.fromEntries(TEST_RUNTIMES.map(runtime => [runtime, hashFiles(files.filter(file => {
      const impact = testImpactForPath(file.path);
      return impact.scopes.includes(scope) && impact.runtimes.includes(runtime);
    }))])),
  ]));
  // Runtime equivalence is stricter than test scope equivalence: all production
  // and dependency inputs must match before accepting an older loaded release.
  const productionSha256 = hashFiles(files.filter(f => f.path.startsWith('src/') ||
    ['package.json', 'package-lock.json'].includes(f.path)).map(f => ({ ...f, sha256: f.runtimeSha256 ?? f.sha256 })));
  return { evidenceVersion: TEST_EVIDENCE_VERSION, releaseVersion, files, fingerprints, productionSha256 };
}

export function compareTestEvidence(previous, current, { scope, runtimeTarget } = {}) {
  if (!TEST_SCOPES.includes(scope) || !TEST_RUNTIMES.includes(runtimeTarget)) throw Error('必须指定测试组件与原生运行环境');
  if (previous?.evidenceVersion === TEST_EVIDENCE_VERSION && current?.evidenceVersion === TEST_EVIDENCE_VERSION) {
    const before = previous.fingerprints?.[scope]?.[runtimeTarget];
    const after = current.fingerprints?.[scope]?.[runtimeTarget];
    if (before && after) return { status: before === after ? 'reusable' : 'needs-retest', scope, runtimeTarget };
  }
  if (previous?.sha256 && previous.sha256 === current?.sha256) return { status: 'reusable', scope, runtimeTarget };
  return { status: 'review-required', scope, runtimeTarget,
    reason: '旧报告没有组件输入清单，需审核变更证据；不能自动判为失败、未执行或要求全面重测' };
}

export function changedEvidenceFiles(previous, current) {
  if (!Array.isArray(previous?.files) || !Array.isArray(current?.files)) return null;
  const before = new Map(previous.files.map(f => [f.path, f]));
  const after = new Map(current.files.map(f => [f.path, f]));
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap(path => {
    if (before.get(path)?.rawSha256 === after.get(path)?.rawSha256) return [];
    const metadataOnly = before.get(path)?.sha256 === after.get(path)?.sha256;
    return [{ path, metadataOnly, ...(metadataOnly
      ? { scopes: [], runtimes: [...TEST_RUNTIMES], reason: '仅发布版本或等价JSON格式变化' }
      : testImpactForPath(path)) }];
  });
}

export function impactPlan(changes) {
  const components = TEST_RUNTIMES.flatMap(runtimeTarget => TEST_SCOPES.flatMap(scope =>
    (scope === 'backend' || scope === 'desktop' ? ['official', 'deepseek'] : [scope === 'free' ? 'simulated' : 'official'])
      .map(profile => ({ scope, profile, runtimeTarget,
        changedPaths: changes.filter(c => c.scopes.includes(scope) && c.runtimes.includes(runtimeTarget)).map(c => c.path) }))));
  return { changes, affectedComponents: components.filter(c => c.changedPaths.length),
    unaffectedComponents: components.filter(c => !c.changedPaths.length),
    packageVerificationRequired: changes.some(c => /^(?:src\/|installer\/|assets\/|\.github\/|scripts\/(?:build-|package-))/.test(c.path) || ['package.json', 'package-lock.json'].includes(c.path)),
    executesTests: false, usesModelTokens: false, restartsCodex: false };
}

export function acceptableRuntimeVersions(current, backendSnapshot, projectVersion) {
  const versions = [projectVersion];
  if (current?.productionSha256 && current.productionSha256 === backendSnapshot?.productionSha256 && backendSnapshot.releaseVersion) {
    versions.push(backendSnapshot.releaseVersion);
  }
  return [...new Set(versions)];
}

export function compareModelRuntime(previous, current) {
  const keys = ['cli', 'node', 'browser'];
  if (keys.some(key => !previous?.[key]?.sha256 || !current?.[key]?.sha256)) {
    return { status: 'review-required', reason: '运行时证据不完整，需审核实际CLI、Node和浏览器；不自动要求全面重测' };
  }
  const changed = keys.filter(key => previous[key].sha256 !== current[key].sha256);
  return { status: changed.length ? 'needs-retest' : 'reusable', changed };
}
