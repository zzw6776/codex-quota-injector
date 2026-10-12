import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function endDevConsoleOnFormalTakeover({ mode, requestMode, logRoot, platform = process.platform }) {
  if (platform !== 'darwin' || mode !== 'dev' || requestMode !== 'formal') return false;
  const path = join(logRoot, 'active-dev-console');
  try { await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  // Replace the existing ownership token, rather than deleting it: older
  // observers also treat a changed token as a successful handoff, but report
  // a missing file as an error. Each observer stops only its own Shell.
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `formal-${randomUUID()}`, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return true;
}
