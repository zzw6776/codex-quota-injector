import { watch } from 'node:fs';
import { readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export async function claimConsole(logRoot, { onReplaced, onError } = {}) {
  const name = 'active-dev-console';
  const path = join(logRoot, name);
  const token = randomUUID();
  const temporary = `${path}.${token}.tmp`;
  let registered = false, closed = false, tail = Promise.resolve();
  const close = () => { if (closed) return; closed = true; watcher.close(); };
  const check = () => {
    tail = tail.then(async () => {
      if (!registered || closed) return;
      if (await readFile(path, 'utf8') !== token) { close(); onReplaced(); }
    }).catch(error => { close(); onError(error); });
  };
  // Observe atomic replacements. Each helper stops only its own console;
  // no foreign PID or injector process is terminated.
  const watcher = watch(logRoot, (_event, file) => { if (!file || String(file) === name) check(); });
  watcher.on('error', error => { close(); onError(error); });
  try {
    await writeFile(temporary, token, { mode: 0o600 });
    await rename(temporary, path);
    registered = true;
    check();
  } catch (error) { close(); throw error; }
  finally { await rm(temporary, { force: true }); }
  return { close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  const parent = process.ppid;
  const signalParent = signal => { if (parent > 1 && process.ppid === parent) process.kill(parent, signal); };
  try {
    const owner = await claimConsole(process.argv[2], {
      onReplaced() {
        console.log('Development log viewing has been handed off or ended.');
        signalParent('SIGUSR1');
      },
      onError(error) {
        console.error(`Development log ownership failed: ${error.message}`);
        signalParent('SIGUSR2');
      },
    });
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => owner.close());
  } catch (error) {
    console.error(`Development log ownership failed: ${error.message}`);
    signalParent('SIGUSR2'); process.exitCode = 1;
  }
}
