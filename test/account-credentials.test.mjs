import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { useTempDir } from "./helpers.mjs";

test("[ACC-03] 钥匙串命令失败保留 auth.json，日志和严格模式错误均不携带凭据", async t => {
  const directory = await useTempDir(t);
  // 在独立进程加载模块前替换 execFile，绝不执行真实钥匙串命令。
  const script = [
    "import assert from 'node:assert/strict';",
    "import childProcess from 'node:child_process';",
    "import { syncBuiltinESMExports } from 'node:module';",
    "import { readFile } from 'node:fs/promises';",
    "import { join } from 'node:path';",
    "const calls = [];",
    "childProcess.execFile = (file, args, callback) => {",
    "  assert.equal(file, '/usr/bin/security');",
    "  calls.push(args);",
    "  callback(new Error('Command failed: ' + file + ' ' + args.join(' ')));",
    "};",
    "syncBuiltinESMExports();",
    "const { writeOfficialCredentials } = await import(" + JSON.stringify(new URL("../src/account-manager/credentials.mjs", import.meta.url).href) + ");",
    "const logs = [];",
    "console.error = (...args) => logs.push(args.join(' '));",
    "const account = { authMode: 'oauth', accountId: 'fixture-account', tokens: {",
    "  idToken: 'fixture-private-id', accessToken: 'fixture-private-access', refreshToken: 'fixture-private-refresh'",
    "} };",
    "await writeOfficialCredentials(process.argv[1], account, { syncKeychain: true });",
    "let strictError;",
    "try {",
    "  await writeOfficialCredentials(process.argv[1], account, { syncKeychain: true, strictKeychain: true });",
    "} catch (error) { strictError = { message: error.message, stack: error.stack }; }",
    "assert.equal(calls.length, 2);",
    "assert.ok(calls.every(args => args.at(-1).includes(account.tokens.accessToken)));",
    "const saved = JSON.parse(await readFile(join(process.argv[1], 'auth.json'), 'utf8'));",
    "assert.equal(saved.tokens.refresh_token, account.tokens.refreshToken);",
    "process.stdout.write(JSON.stringify({ logs, strictError }));",
  ].join("\n");
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, directory]);
  const result = JSON.parse(stdout);
  assert.equal(result.logs.length, 1);
  assert.match(result.logs[0], /auth\.json/);
  assert.match(result.strictError.message, /钥匙串/);
  assert.doesNotMatch(stdout, /fixture-private-|fixture-account/);
});
