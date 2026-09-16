import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { useTempDir } from './helpers.mjs';
import { modelTestRuntimeSnapshot, ROOT, sourceSnapshot } from '../scripts/test-support.mjs';
import { acceptableRuntimeVersions, changedEvidenceFiles, compareModelRuntime, compareTestEvidence,
  evidenceFile, evidenceManifest, impactPlan, TEST_RUNTIMES, TEST_SCOPES } from '../scripts/test-impact.mjs';
import { desktopLoadedVersionMatches, validateBackendReport } from '../scripts/test-desktop-host.mjs';

const files = {
  'package.json': JSON.stringify({ version: '1.0.0', type: 'module', dependencies: { foo: '1.0.0' } }),
  'package-lock.json': JSON.stringify({ version: '1.0.0', packages: { '': { version: '1.0.0' }, 'node_modules/foo': { version: '1.0.0' } } }),
  'src/model-router.mjs': 'router-v1',
  'src/widget/styles.mjs': 'styles-v1',
  'src/lifecycle-host.mjs': 'host-v1',
  'src/macos-codex-shim.swift': 'shim-v1',
  'src/windows-relay-entry.mjs': 'relay-v1',
  'scripts/desktop-host-evidence.mjs': 'desktop-v1',
  'scripts/lifecycle-windows/operations.mjs': 'lifecycle-v1',
  'runtime-tests/support/mcp-fixture.mjs': 'mcp-v1',
  'live-tests/tools.test.mjs': 'tools-v1',
  'test/token-usage.test.mjs': 'contract-v1',
  'docs/testing-desktop-host.md': 'documentation-v1',
};
const snapshot = values => evidenceManifest(Object.entries(values).map(([path, text]) => evidenceFile(path, text)), JSON.parse(values['package.json']).version);
const baseline = snapshot(files);
const compare = (current, scope, runtimeTarget = 'windows-native') => compareTestEvidence(baseline, current, { scope, runtimeTarget }).status;

test('[HAR-04] 文档与三处发布版本变化保留全部18个环境位置的测试证据', () => {
  const current = snapshot({ ...files,
    'package.json': files['package.json'].replace('1.0.0', '1.0.1'),
    'package-lock.json': JSON.stringify({ version: '1.0.1', packages: { '': { version: '1.0.1' }, 'node_modules/foo': { version: '1.0.0' } } }),
    'docs/testing-desktop-host.md': 'new documentation',
  });
  for (const scope of TEST_SCOPES) for (const runtime of TEST_RUNTIMES) assert.equal(compare(current, scope, runtime), 'reusable');
  assert.equal(current.productionSha256, baseline.productionSha256);
  const plan = impactPlan(changedEvidenceFiles(baseline, current));
  assert.equal(plan.affectedComponents.length, 0);
  assert.equal(plan.unaffectedComponents.length, 18);
  assert.equal(plan.packageVerificationRequired, true);
  assert.equal(plan.usesModelTokens, false);
  assert.equal(plan.restartsCodex, false);
});

test('[HAR-04] 页面与桌面判据变化不强制重新消耗后台模型Token', () => {
  for (const path of ['src/widget/styles.mjs', 'scripts/desktop-host-evidence.mjs']) {
    const current = snapshot({ ...files, [path]: 'changed' });
    assert.equal(compare(current, 'free'), 'needs-retest');
    assert.equal(compare(current, 'desktop'), 'needs-retest');
    assert.equal(compare(current, 'backend'), 'reusable');
    assert.equal(compare(current, 'lifecycle'), 'reusable');
    const plan = { profile: 'deepseek', runtimeTarget: 'windows-native', backendComponent: 'deepseek-backend' };
    const report = { snapshot: baseline, profileFilter: 'deepseek', runtimeTarget: 'windows-native',
      platform: 'win32', arch: 'x64', backendStatus: 'passed' };
    assert.equal(validateBackendReport(report, plan, current, { platform: 'win32', arch: 'x64' }).status, 'reusable');
    assert.throws(() => validateBackendReport({ ...report, backendStatus: 'failed' }, plan, current, { platform: 'win32', arch: 'x64' }), /未通过/);
    assert.throws(() => validateBackendReport({ ...report, runtimeTarget: 'wsl-native' }, plan, current, { platform: 'win32', arch: 'x64' }), /运行环境/);
  }
});

test('[HAR-04] 独立免费用例和启停材料修改不使模型后台与桌面报告全部失效', () => {
  const contract = snapshot({ ...files, 'test/token-usage.test.mjs': 'new assertion' });
  assert.equal(compare(contract, 'free'), 'needs-retest');
  for (const scope of ['backend', 'desktop', 'lifecycle']) assert.equal(compare(contract, scope), 'reusable');
  const lifecycle = snapshot({ ...files, 'scripts/lifecycle-windows/operations.mjs': 'new sequence' });
  assert.equal(compare(lifecycle, 'lifecycle'), 'needs-retest');
  for (const scope of ['backend', 'desktop']) assert.equal(compare(lifecycle, scope), 'reusable');
});

test('[HAR-04] 路由、依赖、共享MCP材料和正式Relay构建变化不能继承受影响的模型结果', () => {
  for (const path of ['src/model-router.mjs', 'runtime-tests/support/mcp-fixture.mjs', 'scripts/build-windows-relay.mjs']) {
    const current = snapshot({ ...files, [path]: 'changed' });
    assert.equal(compare(current, 'backend'), 'needs-retest');
  }
  const dependency = snapshot({ ...files, 'package-lock.json': files['package-lock.json'].replace('"node_modules/foo":{"version":"1.0.0"}', '"node_modules/foo":{"version":"2.0.0"}') });
  for (const scope of TEST_SCOPES) assert.equal(compare(dependency, scope), 'needs-retest');
  const host = snapshot({ ...files, 'src/lifecycle-host.mjs': 'changed' });
  assert.equal(compare(host, 'desktop'), 'needs-retest');
  assert.equal(compare(host, 'backend'), 'reusable');
});

test('[HAR-04] 平台专用输入、删除与未知新模块均留下真实影响范围', () => {
  const mac = snapshot({ ...files, 'src/macos-codex-shim.swift': 'changed' });
  assert.equal(compare(mac, 'backend', 'macos-native'), 'needs-retest');
  for (const runtime of ['windows-native', 'wsl-native']) assert.equal(compare(mac, 'backend', runtime), 'reusable');
  const unknown = snapshot({ ...files, 'src/new-routing-module.mjs': 'new' });
  for (const scope of TEST_SCOPES) assert.equal(compare(unknown, scope), 'needs-retest');
  const deleted = { ...files }; delete deleted['src/model-router.mjs'];
  assert.equal(compare(snapshot(deleted), 'backend'), 'needs-retest');
});

test('[HAR-04] 旧报告缺少输入证据需审核，不能偷偷判失败、自动通过或全面重测', () => {
  assert.equal(compareTestEvidence({ sha256: 'old' }, { ...baseline, sha256: 'new' }, { scope: 'backend', runtimeTarget: 'windows-native' }).status, 'review-required');
  assert.equal(compareTestEvidence({ sha256: 'same' }, { ...baseline, sha256: 'same' }, { scope: 'backend', runtimeTarget: 'windows-native' }).status, 'reusable');
  assert.equal(changedEvidenceFiles({ sha256: 'old' }, baseline), null);
});

test('[HAR-04] 只有全部生产输入一致才允许旧发布版本的已加载桌面，真实生产变化仍阻断', () => {
  const release = snapshot({ ...files, 'package.json': files['package.json'].replace('1.0.0', '1.0.1') });
  const plan = { projectVersion: '1.0.1', acceptableRuntimeVersions: acceptableRuntimeVersions(release, baseline, '1.0.1') };
  assert.equal(desktopLoadedVersionMatches(plan, 'Windows · v1.0.0.dev'), true);
  const changed = snapshot({ ...files, 'src/widget/styles.mjs': 'changed' });
  assert.deepEqual(acceptableRuntimeVersions(changed, baseline, '1.0.1'), ['1.0.1']);
  assert.equal(desktopLoadedVersionMatches({ projectVersion: '1.0.1' }, 'Windows · v1.0.0.dev'), false);
  assert.deepEqual(acceptableRuntimeVersions(release, { sha256: 'legacy' }, '1.0.1'), ['1.0.1']);
});

test('[HAR-04] CLI与Node字节变化只使对应环境证据需重测，路径和发布版本本身不改变运行时结论', () => {
  const runtime = { cli: { path: 'old', sha256: 'cli' }, node: { sha256: 'node' }, browser: { sha256: 'browser' } };
  assert.equal(compareModelRuntime(runtime, { ...runtime, cli: { path: 'new', sha256: 'cli' } }).status, 'reusable');
  assert.deepEqual(compareModelRuntime(runtime, { ...runtime, node: { sha256: 'new' } }).changed, ['node']);
  assert.equal(compareModelRuntime({}, runtime).status, 'review-required');
});

test('[HAR-04] WSL后台运行时指纹绑定Linux CLI与Node，不继承Windows运行时', async () => {
  const host = { cli: { sha256: 'windows-cli' }, node: { sha256: 'windows-node' }, browser: { sha256: 'shared-browser' } };
  const cliHash = 'a'.repeat(64), nodeHash = 'b'.repeat(64);
  const current = await modelTestRuntimeSnapshot('wsl-native', {
    inspectHostRuntime: async () => host,
    exec: async (command, args) => {
      assert.equal(command, 'wsl.exe');
      if (args.includes('sh')) {
        // Reproduce the real dash failure: a multi-name command -v returns only CLI.
        return { stdout: args.at(-1) === 'command -v codex node' ? '/usr/local/bin/codex\n'
          : '/usr/local/bin/codex\n/usr/local/bin/node\n' };
      }
      assert.deepEqual(args, ['-e', 'sha256sum', '--', '/usr/local/bin/codex', '/usr/local/bin/node']);
      return { stdout: `${cliHash}  /usr/local/bin/codex\n${nodeHash}  /usr/local/bin/node\n` };
    },
  });
  assert.equal(current.cli.sha256, cliHash);
  assert.equal(current.node.sha256, nodeHash);
  assert.equal(current.browser.sha256, 'shared-browser');
  assert.equal(compareModelRuntime({ ...current, cli: host.cli }, current).status, 'needs-retest');
});

test('[HAR-04] 实际源码扫描包含安装资源并保留原始摘要；文档/版本仅改变追溯信息', async t => {
  const root = await useTempDir(t);
  for (const directory of ['src', 'scripts', 'test', 'runtime-tests', 'live-tests', 'docs', 'assets', 'installer']) await mkdir(join(root, directory));
  const values = { ...files, 'docs/testing-protocol-inventory.json': '{}', 'docs/testing-scenarios.json': '{}',
    'docs/codex-compatibility-test-plan.md': 'plan', 'assets/AppIcon.ico': 'icon', 'installer/windows-installer.nsi': 'installer' };
  for (const [path, text] of Object.entries(values)) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), text); }
  const before = await sourceSnapshot({ root });
  await writeFile(join(root, 'package.json'), values['package.json'].replace('1.0.0', '1.0.1'));
  await writeFile(join(root, 'docs/testing-desktop-host.md'), 'new documentation');
  const after = await sourceSnapshot({ root });
  assert.notEqual(before.sha256, after.sha256);
  assert.equal(compareTestEvidence(before, after, { scope: 'backend', runtimeTarget: 'windows-native' }).status, 'reusable');
  await writeFile(join(root, 'installer/windows-installer.nsi'), 'new installer');
  assert.equal(compareTestEvidence(after, await sourceSnapshot({ root }), { scope: 'lifecycle', runtimeTarget: 'windows-native' }).status, 'needs-retest');
});

test('[HAR-04] 实际影响CLI只列计划，旧报告待审核并原样保留，不启动模型程序', async t => {
  const directory = await useTempDir(t);
  const reportPath = join(directory, 'report.json');
  const original = JSON.stringify({ backendStatus: 'passed', snapshot: { sha256: 'legacy' } });
  await writeFile(reportPath, original);
  const { stdout } = await promisify(execFile)(process.execPath,
    ['scripts/test-impact-cli.mjs', `--baseline=${reportPath}`], { cwd: ROOT,
      env: { ...process.env, CODEX_TEST_CLI: join(directory, 'must-not-launch'), CODEX_QUOTA_DATA_DIR: directory }, timeout: 10000 });
  const result = JSON.parse(stdout);
  assert.equal(result.status, 'review-required');
  assert.equal(result.executesTests, false);
  assert.equal(result.usesModelTokens, false);
  assert.equal(result.restartsCodex, false);
  assert.equal(await readFile(reportPath, 'utf8'), original);
});

test('[HAR-04] 实际影响CLI用现代报告列出18个不受影响位置，不因发布元数据改变要求行为重测', async t => {
  const directory = await useTempDir(t);
  const current = await sourceSnapshot();
  const packageFile = current.files.find(file => file.path === 'package.json');
  packageFile.rawSha256 = 'older-release-bytes';
  const reportPath = join(directory, 'report.json');
  await writeFile(reportPath, JSON.stringify({ snapshot: current }));
  const { stdout } = await promisify(execFile)(process.execPath,
    ['scripts/test-impact-cli.mjs', `--baseline=${reportPath}`], { cwd: ROOT,
      env: { ...process.env, CODEX_TEST_CLI: join(directory, 'must-not-launch') }, timeout: 10000 });
  const result = JSON.parse(stdout);
  assert.equal(result.affectedComponents.length, 0);
  assert.equal(result.unaffectedComponents.length, 18);
  assert.equal(result.packageVerificationRequired, true);
});
