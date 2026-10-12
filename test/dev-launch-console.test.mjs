import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { useTempDir, waitFor } from './helpers.mjs';
import { testImpactForPath } from '../scripts/test-impact.mjs';
import { claimConsole } from '../scripts/macos-dev-console-owner.mjs';
import { endDevConsoleOnFormalTakeover } from '../src/macos-dev-console.mjs';
import { acquireSingleInstance, closeSingleInstance, readSingleInstanceStatus } from '../src/single-instance.mjs';

const root = join(import.meta.dirname, '..');
const exec = promisify(execFile);
const psQuote = value => `'${value.replaceAll("'", "''")}'`;

test('开发启动入口变更只影响对应平台开发契约，不使真实模型或正式启停报告失效', () => {
  for (const path of ['启动开发版.command', 'scripts/start-injector-macos.sh',
    'scripts/macos-dev-environment.sh', 'scripts/macos-dev-console-owner.mjs']) {
    const impact = testImpactForPath(path);
    assert.deepEqual(impact.scopes, ['free']);
    assert.deepEqual(impact.runtimes, ['macos-native']);
  }
  for (const path of ['启动开发版.cmd', 'scripts/start-injector-windows.ps1',
    'scripts/windows-dev-dependencies.ps1', 'scripts/dev-launch-console.ps1', 'scripts/dev-launch-log-reader.ps1']) {
    const impact = testImpactForPath(path);
    assert.deepEqual(impact.scopes, ['free']);
    assert.deepEqual(impact.runtimes, ['windows-native', 'wsl-native']);
  }
  assert.deepEqual(testImpactForPath('src/macos-dev-console.mjs').scopes, ['free', 'lifecycle']);
  assert.deepEqual(testImpactForPath('src/macos-dev-console.mjs').runtimes, ['macos-native']);
});

function observe(t, executable, args, options = {}) {
  const child = spawn(executable, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve(code));
  });
  t.after(async () => { if (child.exitCode === null) { child.stdin.end('\n'); child.kill(); } await done; });
  return { child, done, output: () => output };
}

if (process.platform === 'win32') {
  test('Windows 准备命令执行中即输出 stdout/stderr，结束后保留真实失败码', async t => {
    const directory = await useTempDir(t, 'dev-process-stream-');
    const fixture = join(directory, 'slow command.mjs');
    await writeFile(fixture, "console.log('LIVE-BEFORE-EXIT'); setTimeout(() => { console.error('FINAL-STDERR'); process.exit(7); }, 1500);\n");
    const command = `. ${psQuote(join(root, 'scripts', 'windows-dev-dependencies.ps1'))}; ` +
      `$script:WindowsDevProcessOutputHandler = { param($text) Write-Host -NoNewline $text }; ` +
      `$result = Invoke-WindowsProcess -Executable ${psQuote(process.execPath)} -Arguments @(${psQuote(fixture)}); ` +
      `Write-Host "ACTUAL-EXIT=$($result.ExitCode)"; exit $result.ExitCode`;
    const run = observe(t, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command]);
    await waitFor(() => run.output().includes('LIVE-BEFORE-EXIT'), { timeoutMs: 15000 });
    assert.equal(run.child.exitCode, null);
    assert.doesNotMatch(run.output(), /FINAL-STDERR/);
    assert.equal(await run.done, 7);
    assert.match(run.output(), /FINAL-STDERR/);
    assert.match(run.output(), /ACTUAL-EXIT=7/);
  });

  test('Windows 启动日志按增量读取、保留分段 UTF-8，并能读取截断后的日志', async t => {
    const directory = await useTempDir(t, 'dev-log-reader-');
    const path = join(directory, 'log.txt');
    const helper = join(root, 'scripts', 'dev-launch-log-reader.ps1');
    const script = `. ${psQuote(helper)}
$cursor = New-DevLogCursor ${psQuote(path)}
Read-DevLogCursor $cursor
$bytes = [Text.Encoding]::UTF8.GetBytes("中文")
[IO.File]::WriteAllBytes(${psQuote(path)}, $bytes[0..1])
Read-DevLogCursor $cursor
$file = [IO.File]::Open(${psQuote(path)}, 'Append', 'Write', 'ReadWrite')
$file.Write($bytes, 2, $bytes.Length - 2); $file.Dispose()
Read-DevLogCursor $cursor
Read-DevLogCursor $cursor
[IO.File]::WriteAllText(${psQuote(path)}, "X", (New-Object Text.UTF8Encoding $false))
Read-DevLogCursor $cursor`;
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
    assert.equal(stdout, '中文X');
  });

  for (const code of [0, 7]) test(`Windows 隔离启动器退出 ${code}：完整留证并${code ? '返回失败' : '持续跟踪运行日志'}`, async t => {
    const directory = await useTempDir(t, 'dev-console-');
    const bootstrap = join(directory, 'fake bootstrap.ps1');
    const runtime = join(directory, 'injector.log');
    await writeFile(runtime, 'OLD-LAUNCH\n');
    await writeFile(bootstrap, `param([switch]$Console)\nWrite-Host 'BOOT-EARLY'\nStart-Sleep -Milliseconds 400\nAdd-Content -LiteralPath ${psQuote(runtime)} -Value 'RUNTIME-READY'\n[Console]::Error.WriteLine('BOOT-FINAL-ERROR')\nexit ${code}\n`);
    const run = observe(t, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      join(root, 'scripts', 'dev-launch-console.ps1'), '-BootstrapPath', bootstrap, '-LogRoot', directory]);
    await waitFor(() => run.output().includes('BOOT-EARLY'), { timeoutMs: 15000 });
    if (code) assert.equal(await run.done, code);
    else {
      await waitFor(() => run.output().includes('Startup preparation finished'), { timeoutMs: 15000 });
      await appendFile(runtime, 'RUNTIME-AFTER-BOOTSTRAP\n');
      await waitFor(() => run.output().includes('RUNTIME-AFTER-BOOTSTRAP'), { timeoutMs: 15000 });
      assert.equal(run.child.exitCode, null);
    }
    assert.match(run.output(), /RUNTIME-READY/);
    assert.match(run.output(), /BOOT-FINAL-ERROR/);
    assert.doesNotMatch(run.output(), /OLD-LAUNCH/);
  });

  test('Windows 真实 CMD 失败后执行 pause 并保留原始退出码', async t => {
    const directory = await useTempDir(t, 'dev-cmd-');
    await mkdir(join(directory, 'scripts'));
    const command = join(directory, 'start.cmd');
    await copyFile(join(root, '启动开发版.cmd'), command);
    await writeFile(join(directory, 'scripts', 'dev-launch-console.ps1'), "Write-Host 'COMPLETE-FAILURE'; exit 9\n");
    const run = observe(t, 'cmd.exe', ['/d', '/c', command]);
    await waitFor(() => run.output().includes('Development launcher exited with code 9'), { timeoutMs: 15000 });
    assert.equal(run.child.exitCode, null);
    run.child.stdin.end('\n');
    assert.equal(await run.done, 9);
    assert.match(run.output(), /COMPLETE-FAILURE/);
  });
}

if (process.platform !== 'win32') {
  test('仅 macOS 开发实例被正式版接管时结束日志观察，不改变复用、其他平台和正式实例', async t => {
    const directory = await useTempDir(t, 'dev-console-takeover-');
    const missing = await endDevConsoleOnFormalTakeover({ mode:'dev',requestMode:'formal',platform:'darwin',logRoot:directory });
    assert.equal(missing, false);
    let replaced = false;
    const errors = [];
    const owner = await claimConsole(directory, { onReplaced:()=>{replaced=true;},onError:error=>errors.push(error) });
    t.after(()=>owner.close());
    const path = join(directory, 'active-dev-console');
    const original = await readFile(path, 'utf8');
    for (const [mode, requestMode, platform] of [['dev','dev','darwin'], ['formal','formal','darwin'], ['dev','formal','win32'], ['dev','formal','linux']]) {
      assert.equal(await endDevConsoleOnFormalTakeover({mode,requestMode,platform,logRoot:directory}), false);
      assert.equal(await readFile(path, 'utf8'), original);
    }
    assert.equal(replaced, false);
    assert.equal(await endDevConsoleOnFormalTakeover({mode:'dev',requestMode:'formal',platform:'darwin',logRoot:directory}), true);
    await waitFor(()=>replaced);
    assert.deepEqual(errors, []);
    assert.notEqual(await readFile(path, 'utf8'), original);
    assert.equal((await readdir(directory)).some(name=>name.endsWith('.tmp')), false);
  });

  test('正式单实例接管通知使开发 Shell 与 follower 退出，正式后台仍监听且新开发终端可再次打开', async t => {
    const directory = await useTempDir(t, 'dev-formal-console-');
    await mkdir(join(directory, 'scripts'));
    await copyFile(join(root, '启动开发版.command'), join(directory, 'start.command'));
    for (const name of ['macos-dev-environment.sh', 'macos-dev-console-owner.mjs']) {
      await copyFile(join(root, 'scripts', name), join(directory, 'scripts', name));
    }
    await writeFile(join(directory, 'scripts', 'start-injector-macos.sh'), '#!/bin/bash\necho ISOLATED-DEV-REUSED\nexit 0\n');
    const options = {env:{...process.env,HOME:directory}};
    const run = observe(t, 'bash', [join(directory, 'start.command')], options);
    const logRoot = join(directory, 'Library', 'Logs', 'Codex Quota Injector');
    await waitFor(()=>run.output().includes('Continuing to follow'), {timeoutMs:15000});
    await waitFor(()=>readFile(join(logRoot, 'active-dev-console'), 'utf8').then(Boolean).catch(()=>false));
    const consolePids = (await exec('pgrep', ['-P', String(run.child.pid)])).stdout.trim().split(/\s+/).map(Number);
    assert.equal(consolePids.length, 3, '必须实际包含协调器与两个日志 follower');
    const dev = await acquireSingleInstance({port:0,mode:'dev',version:'1.0.0',onTakeover:async request=>{
      await endDevConsoleOnFormalTakeover({mode:'dev',requestMode:request.mode,platform:'darwin',logRoot});
      await closeSingleInstance(dev);
    }});
    t.after(()=>closeSingleInstance(dev));
    const port = dev.address().port;
    const formal = await acquireSingleInstance({port,mode:'formal',version:'0.1.0',explicitStart:true,getStatus:()=>({phase:'ready'})});
    t.after(()=>closeSingleInstance(formal));
    assert.ok(formal?.listening, '旧正式版本也应接管开发版');
    assert.equal(await run.done, 0, '通知后 Shell 与所有 follower 的 stdio 应正常关闭');
    assert.doesNotMatch(run.output(), /Press Enter to close|Development launcher failed/);
    for (const pid of consolePids) assert.throws(()=>process.kill(pid,0), {code:'ESRCH'});
    assert.equal((await readSingleInstanceStatus({port})).mode, 'formal');
    const next = observe(t, 'bash', [join(directory, 'start.command')], options);
    await waitFor(()=>next.output().includes('Continuing to follow'), {timeoutMs:15000});
    await appendFile(join(logRoot, 'injector.log'), 'NEW-DEV-CONSOLE\n');
    await waitFor(()=>next.output().includes('NEW-DEV-CONSOLE'), {timeoutMs:15000});
    assert.equal(next.child.exitCode, null, '正式接管留下的归属标记不能阻止下次开发日志窗口');
    next.child.kill('SIGUSR1');
    assert.equal(await next.done, 0);
    assert.equal((await readSingleInstanceStatus({port})).mode, 'formal');
  });

  test('并发打开日志观察器最终只留一个归属；已关闭的登记不会阻挡下次打开', async t => {
    const directory = await useTempDir(t, 'dev-console-owners-');
    const replaced = new Set(), errors = [];
    const owners = await Promise.all([0, 1, 2].map(id => claimConsole(directory, {
      onReplaced: () => replaced.add(id), onError: error => errors.push(error),
    })));
    t.after(() => owners.forEach(owner => owner.close()));
    await waitFor(() => replaced.size === 2);
    assert.deepEqual(errors, []);
    owners.forEach(owner => owner.close());
    const next = await claimConsole(directory, {
      onReplaced: () => { throw new Error('新观察器不应退出'); }, onError: error => errors.push(error),
    });
    t.after(() => next.close());
    assert.deepEqual(errors, []);
  });

  for (const code of [0, 7]) test(`command Shell 隔离启动器退出 ${code}：${code ? '保留完整错误' : '复用后继续日志输出'}`, async t => {
    const directory = await useTempDir(t, 'dev-command-');
    await mkdir(join(directory, 'scripts'));
    await copyFile(join(root, '启动开发版.command'), join(directory, 'start.command'));
    for (const name of ['macos-dev-environment.sh', 'macos-dev-console-owner.mjs']) {
      await copyFile(join(root, 'scripts', name), join(directory, 'scripts', name));
    }
    const logRoot = join(directory, 'Library', 'Logs', 'Codex Quota Injector');
    await mkdir(logRoot, { recursive: true });
    const runtime = join(logRoot, 'injector.log');
    await writeFile(join(directory, 'scripts', 'start-injector-macos.sh'), `#!/bin/bash\necho BOOT-EARLY\necho EXTERNAL-START=$CODEX_QUOTA_DEV_EXTERNAL_START\necho BOOT-FINAL-ERROR >&2\nexit ${code}\n`);
    const run = observe(t, 'bash', [join(directory, 'start.command')], { env: { ...process.env, HOME: directory } });
    if (code) {
      await waitFor(() => run.output().includes('Press Enter to close'), { timeoutMs: 15000 });
      assert.equal(run.child.exitCode, null);
      run.child.stdin.end('\n');
      assert.equal(await run.done, code);
    } else {
      await waitFor(() => run.output().includes('Continuing to follow'), { timeoutMs: 15000 });
      await appendFile(runtime, 'RUNTIME-AFTER-BOOTSTRAP\n');
      await waitFor(() => run.output().includes('RUNTIME-AFTER-BOOTSTRAP'), { timeoutMs: 15000 });
      assert.equal(run.child.exitCode, null);
      run.child.stdin.end('\n');
    }
    await waitFor(() => run.output().includes('BOOT-FINAL-ERROR'), { timeoutMs: 15000 });
    assert.match(run.output(), /BOOT-EARLY/);
    assert.match(run.output(), /EXTERNAL-START=1/);
    const names = await readdir(logRoot);
    assert.match(await readFile(join(logRoot, names.find(n => n.startsWith('dev-launch-'))), 'utf8'), /BOOT-FINAL-ERROR/);
  });

  test('重复打开开发终端时旧观察器退出、最新终端继续日志，后台进程保持存活', async t => {
    const directory = await useTempDir(t, 'dev-console-handoff-');
    await mkdir(join(directory, 'scripts'));
    await copyFile(join(root, '启动开发版.command'), join(directory, 'start.command'));
    for (const name of ['macos-dev-environment.sh', 'macos-dev-console-owner.mjs']) {
      await copyFile(join(root, 'scripts', name), join(directory, 'scripts', name));
    }
    const pidPath = join(directory, 'backend.pid');
    const fake = join(directory, 'backend.mjs');
    await writeFile(fake, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(pidPath)},String(process.pid));console.log('BACKEND-READY');setInterval(()=>{},1000);`);
    await writeFile(join(directory, 'scripts', 'start-injector-macos.sh'), `#!/bin/bash\nif [[ -s '${pidPath}' ]]; then echo REUSED; exit 0; fi\nexec '${process.execPath}' '${fake}'\n`);
    const options = { env: { ...process.env, HOME: directory } };
    const first = observe(t, 'bash', [join(directory, 'start.command')], options);
    try { await waitFor(() => first.output().includes('BACKEND-READY'), { timeoutMs: 15000 }); }
    catch (error) { throw new Error(`${error.message}\n${first.output()}`); }
    const backendPid = Number(await readFile(pidPath, 'utf8'));
    t.after(() => { try { process.kill(backendPid); } catch {} });
    const second = observe(t, 'bash', [join(directory, 'start.command')], options);
    try { await waitFor(() => first.child.exitCode !== null, { timeoutMs: 15000 }); }
    catch (error) { throw new Error(`${error.message}\nFIRST:\n${first.output()}\nSECOND:\n${second.output()}`); }
    assert.equal(await first.done, 0);
    await waitFor(() => second.output().includes('Continuing to follow'), { timeoutMs: 15000 });
    process.kill(backendPid, 0);
    const third = observe(t, 'bash', [join(directory, 'start.command')], options);
    await waitFor(() => second.child.exitCode !== null, { timeoutMs: 15000 });
    assert.equal(await second.done, 0);
    await waitFor(() => third.output().includes('Continuing to follow'), { timeoutMs: 15000 });
    const runtime = join(directory, 'Library', 'Logs', 'Codex Quota Injector', 'injector.log');
    await appendFile(runtime, 'LATEST-CONSOLE-LOG\n');
    await waitFor(() => third.output().includes('LATEST-CONSOLE-LOG'), { timeoutMs: 15000 });
    assert.equal(third.child.exitCode, null);
    assert.equal(Number(await readFile(pidPath, 'utf8')), backendPid);
    process.kill(backendPid, 0);
    third.child.kill('SIGUSR1');
    assert.equal(await third.done, 0);
    process.kill(backendPid, 0);
  });
}
