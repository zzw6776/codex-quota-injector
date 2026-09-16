import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { useTempDir, waitFor } from './helpers.mjs';
import { testImpactForPath } from '../scripts/test-impact.mjs';

const root = join(import.meta.dirname, '..');
const exec = promisify(execFile);
const psQuote = value => `'${value.replaceAll("'", "''")}'`;

test('开发启动入口变更只影响对应平台开发契约，不使真实模型或正式启停报告失效', () => {
  for (const path of ['启动开发版.command', 'scripts/start-injector-macos.sh']) {
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
  for (const code of [0, 7]) test(`command Shell 隔离启动器退出 ${code}：${code ? '保留完整错误' : '复用后继续日志输出'}`, async t => {
    const directory = await useTempDir(t, 'dev-command-');
    await mkdir(join(directory, 'scripts'));
    await copyFile(join(root, '启动开发版.command'), join(directory, 'start.command'));
    const logRoot = join(directory, 'Library', 'Logs', 'Codex Quota Injector');
    await mkdir(logRoot, { recursive: true });
    const runtime = join(logRoot, 'injector.log');
    await writeFile(join(directory, 'scripts', 'start-injector-macos.sh'), `#!/bin/bash\necho BOOT-EARLY\necho BOOT-FINAL-ERROR >&2\nexit ${code}\n`);
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
    const names = await readdir(logRoot);
    assert.match(await readFile(join(logRoot, names.find(n => n.startsWith('dev-launch-'))), 'utf8'), /BOOT-FINAL-ERROR/);
  });
}
