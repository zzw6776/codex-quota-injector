#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ROOT, sourceSnapshot } from './test-support.mjs';
import { changedEvidenceFiles, evidenceFile, impactPlan, testImpactForPath } from './test-impact.mjs';

const args = process.argv.slice(2);
if (args.length > 1 || args.some(arg => !/^--(?:base|baseline)=.+/.test(arg))) throw Error('使用 --base=<Git提交> 或 --baseline=<测试报告>，不执行测试');
let changes;
if (args[0]?.startsWith('--baseline=')) {
  const report = JSON.parse(await readFile(args[0].slice('--baseline='.length), 'utf8'));
  const baseline = report.snapshot ?? report.sourceSnapshot ?? report.metadata?.sourceSnapshot ?? report;
  changes = changedEvidenceFiles(baseline, await sourceSnapshot());
  if (!changes) {
    console.log(JSON.stringify({ status: 'review-required', reason: '旧报告没有文件输入清单；应审核差异，不自动要求全面重测',
      executesTests: false, usesModelTokens: false, restartsCodex: false }, null, 2));
    process.exit(0);
  }
} else {
  const exec = promisify(execFile);
  const git = async arguments_ => (await exec('git', arguments_, { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 })).stdout;
  const base = (await git(['rev-parse', '--verify', `${args[0]?.slice('--base='.length) ?? 'HEAD'}^{commit}`])).trim();
  const paths = new Set([...(await git(['diff', '--name-only', '-z', base, '--'])).split('\0'),
    ...(await git(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0')].filter(Boolean));
  changes = [];
  for (const path of [...paths].sort()) {
    let metadataOnly = false;
    if (['package.json', 'package-lock.json'].includes(path)) {
      const before = await git(['show', `${base}:${path}`]).catch(() => null);
      const after = await readFile(join(ROOT, path)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      metadataOnly = before !== null && after !== null && evidenceFile(path, before).sha256 === evidenceFile(path, after).sha256;
    }
    changes.push({ path, metadataOnly, ...testImpactForPath(path), ...(metadataOnly
      ? { scopes: [], reason: '仅发布版本或等价JSON格式变化' } : {}) });
  }
}
console.log(JSON.stringify(impactPlan(changes), null, 2));
