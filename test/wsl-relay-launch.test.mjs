import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { relayLaunchEnvironment } from '../src/codex-bridge.mjs';
import { isRelayStateCurrent } from '../src/platform.mjs';
import { useTempDir, waitFor } from './helpers.mjs';

const primaryMarker = 'CODEX_QUOTA_PRIMARY_APP_SERVER';
const exec = promisify(execFile);
const relayPath = 'D:\\source with spaces\\build\\codex-quota-relay-wsl-0.1.279';

test('[platform:windows-native][platform:wsl-native] WSL 主 Relay 标记转发保留其他变量与路径标志', () => {
  const environment = { WSLENV: 'APPDATA/p:HTTP_PROXY:LOCALAPPDATA/p' };
  assert.deepEqual(relayLaunchEnvironment(relayPath, { platform: 'win32', environment }), {
    CODEX_CLI_PATH: relayPath,
    WSLENV: `APPDATA/p:HTTP_PROXY:LOCALAPPDATA/p:${primaryMarker}/u`,
  });
  assert.equal(environment.WSLENV, 'APPDATA/p:HTTP_PROXY:LOCALAPPDATA/p');
});

test('[platform:windows-native][platform:wsl-native] WSL 主标记不能被旧反向转发标志或重复声明阻断', () => {
  for (const WSLENV of ['', `${primaryMarker}/w`, `APPDATA/p:${primaryMarker}/w:${primaryMarker.toLowerCase()}/wp`]) {
    const result = relayLaunchEnvironment(relayPath, { platform: 'win32', environment: { WSLENV } });
    assert.equal(result.WSLENV, WSLENV.startsWith('APPDATA') ? `APPDATA/p:${primaryMarker}/u` : `${primaryMarker}/u`);
  }
});

test('[platform:windows-native][platform:macos-native] Windows PE Relay 和 macOS 不新增 WSL 转发', () => {
  for (const [path, platform] of [['D:\\relay.exe', 'win32'], ['/Applications/relay', 'darwin']]) {
    assert.deepEqual(relayLaunchEnvironment(path, { platform, environment: { WSLENV: 'APPDATA/p' } }), { CODEX_CLI_PATH: path });
  }
});

async function nativeFixture(t) {
  const relay = process.env.CODEX_TEST_WSL_RELAY_EXECUTABLE;
  if (!relay) { t.skip('需显式提供当前源码构建的原生 ELF Relay'); return null; }
  await exec('wsl.exe', ['-e', 'true'], { timeout: 10000 });
  const directory = await useTempDir(t, 'wsl-relay-launch-');
  const statePath = join(directory, 'relay-state.json');
  const configPath = join(directory, 'relay-config.json');
  const settingsPath = join(directory, 'models.json');
  await writeFile(settingsPath, '{"platforms":[]}');
  const env = {
    ...process.env,
    ...relayLaunchEnvironment(relayPath, { environment: { WSLENV: 'HOME/p:CODEX_HOME/p:LOCALAPPDATA/p:CODEX_QUOTA_RELAY_CONFIG/p' } }),
    [primaryMarker]: '1',
    CODEX_QUOTA_RELAY_CONFIG: configPath,
    HOME: directory,
    CODEX_HOME: directory,
    LOCALAPPDATA: directory,
  };
  const linuxPath = async path => (await exec('wsl.exe', ['-e', 'wslpath', '-u', path])).stdout.trim();
  const launch = (executable, args, environment = env) => {
    const child = spawn('wsl.exe', ['-e', executable, ...args], { env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const completion = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => resolve(code));
    });
    t.after(async () => {
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 3000);
      try { await completion; } finally { clearTimeout(timer); }
    });
    return { child, completion, stdout: () => stdout, stderr: () => stderr };
  };
  const writeConfig = upstream => writeFile(configPath, JSON.stringify({
    upstreamExecutable: upstream, extraModelSettingsPath: settingsPath,
    relayStatePath: statePath, generation: 'wsl-launch-regression',
  }));
  return { directory, relay, statePath, env, launch, linuxPath, writeConfig };
}

if (process.platform === 'win32') {
  test('[platform:wsl-native] Windows→原生 WSL Relay 发布真实 PID，辅助往返及退出保留主状态', async t => {
    const fixture = await nativeFixture(t);
    if (!fixture) return;
    const { directory, relay, statePath, env, launch, linuxPath, writeConfig } = fixture;
    const upstream = join(directory, 'upstream.mjs');
    await writeFile(upstream, `import {createInterface} from 'node:readline';
console.log(JSON.stringify({method:'fixture/ready',params:{primary:process.env.${primaryMarker}??null}}));
for await(const line of createInterface({input:process.stdin})) {
 const request=JSON.parse(line); console.log(JSON.stringify({id:request.id,result:{echo:request.params}}));
}`);
    await writeConfig('/usr/local/bin/node');
    // A stale Windows state with the same generation reproduces the actual
    // failed transition; the new Linux owner must replace it.
    await writeFile(statePath, JSON.stringify({ version: 2, pid: 2147483647, generation: 'wsl-launch-regression', processStartedAt: 1 }));
    const args = [await linuxPath(upstream), 'app-server'];
    const fixtureEnv = { ...env, CODEX_QUOTA_WSL_UPSTREAM_CODEX_CLI: '/usr/local/bin/node',
      WSLENV: `${env.WSLENV}:CODEX_QUOTA_WSL_UPSTREAM_CODEX_CLI/u` };
    const primary = launch(relay, args, fixtureEnv);
    await waitFor(() => primary.stdout().includes('fixture/ready'), { timeoutMs: 15000 });
    assert.match(primary.stdout(), /"primary":null/, '官方上游及其辅助进程不能继承主标记');
    const owner = JSON.parse(await readFile(statePath, 'utf8'));
    assert.notEqual(owner.pid, 2147483647);
    assert.ok(owner.bootId);
    assert.ok(Number.isSafeInteger(owner.processStartTicks));
    assert.equal(await isRelayStateCurrent(statePath, 'wsl-launch-regression', { wslNative: true }), true);
    const before = await readFile(statePath, 'utf8');
    const auxiliaryEnv = { ...fixtureEnv };
    delete auxiliaryEnv[primaryMarker];
    const auxiliary = launch(relay, args, auxiliaryEnv);
    await waitFor(() => auxiliary.stdout().includes('fixture/ready'), { timeoutMs: 15000 });
    auxiliary.child.stdin.write('{"id":1,"method":"fixture/echo","params":"auxiliary"}\n');
    await waitFor(() => auxiliary.stdout().includes('"echo":"auxiliary"'), { timeoutMs: 15000 });
    assert.equal(await readFile(statePath, 'utf8'), before);
    auxiliary.child.stdin.end();
    assert.equal(await auxiliary.completion, 0, auxiliary.stderr());
    assert.equal(await readFile(statePath, 'utf8'), before);
    primary.child.stdin.write('{"id":2,"method":"fixture/echo","params":"primary-still-works"}\n');
    await waitFor(() => primary.stdout().includes('primary-still-works'), { timeoutMs: 15000 });
    primary.child.stdin.end();
    assert.equal(await primary.completion, 0, primary.stderr());
    await assert.rejects(access(statePath), { code: 'ENOENT' });
  });

  test('[platform:wsl-native] 同版本官方 app-server 无 Relay 与修复后原生 Relay 均完成初始化', async t => {
    const fixture = await nativeFixture(t);
    if (!fixture) return;
    const officialCli = process.env.CODEX_TEST_WSL_OFFICIAL_CLI;
    assert.ok(officialCli, '必须绑定本机已确认的官方 CLI 具体路径');
    const { relay, statePath, env, launch, writeConfig } = fixture;
    const { stdout: version } = await exec('wsl.exe', ['-e', officialCli, '--version']);
    assert.match(version, /codex-cli /);
    await writeConfig(officialCli);
    const directEnv = { ...env };
    delete directEnv[primaryMarker];
    delete directEnv.CODEX_QUOTA_RELAY_CONFIG;
    const relayEnv = { ...env, CODEX_QUOTA_WSL_UPSTREAM_CODEX_CLI: officialCli,
      WSLENV: `${env.WSLENV}:CODEX_QUOTA_WSL_UPSTREAM_CODEX_CLI/u` };
    for (const [executable, environment] of [[officialCli, directEnv], [relay, relayEnv]]) {
      const run = launch(executable, ['app-server'], environment);
      run.child.stdin.write('{"id":1,"method":"initialize","params":{"clientInfo":{"name":"wsl-launch-regression","version":"1"},"capabilities":{"experimentalApi":true}}}\n');
      await waitFor(() => run.stdout().includes('"id":1'), { timeoutMs: 15000 });
      const response = run.stdout().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).find(message => message.id === 1);
      assert.ok(response.result, run.stderr());
      assert.equal(response.error, undefined);
      if (executable === relay) assert.equal(await isRelayStateCurrent(statePath, 'wsl-launch-regression', { wslNative: true }), true);
      run.child.stdin.end();
      assert.equal(await run.completion, 0, run.stderr());
    }
  });
}
