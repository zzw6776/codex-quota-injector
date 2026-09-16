import { copyFile, mkdir, readdir, rename, stat, unlink, writeFile, cp, rm } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import { WINDOWS_CODEX_CACHE_DIR, WINDOWS_CODEX_CACHE_FILE, WINDOWS_CODEX_CACHE_MANIFEST, readJsonFile, isFileWithSize, WINDOWS_CODEX_APP_CACHE_MANIFEST } from "./contract.mjs";
import { defaultAccountDataDir, windowsCodexAppCacheRoot } from "./directories.mjs";

async function materializeWindowsCodexCli(source) {
  const dataDir = defaultAccountDataDir();
  const sourceDir = dirname(source);
  const helperEntries = (await readdir(sourceDir, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const sourceFiles = [
    { sourcePath: source, targetName: WINDOWS_CODEX_CACHE_FILE },
    ...helperEntries
      .filter((entry) =>
        entry.isFile() &&
        /^codex.*\.exe$/i.test(entry.name) &&
        entry.name.toLowerCase() !== "codex.exe"
      )
      .map((entry) => ({
        sourcePath: join(sourceDir, entry.name),
        targetName: entry.name,
      })),
  ];
  const sourceRecords = [];
  for (const file of sourceFiles) {
    const info = await stat(file.sourcePath);
    sourceRecords.push({
      ...file,
      size: info.size,
      mtimeMs: info.mtimeMs,
    });
  }

  const mainSource = sourceRecords[0];
  const cacheKey = `${mainSource.size}-${Math.trunc(mainSource.mtimeMs)}`;
  const cacheDir = join(dataDir, WINDOWS_CODEX_CACHE_DIR, cacheKey);
  const target = join(cacheDir, WINDOWS_CODEX_CACHE_FILE);
  const manifestPath = join(cacheDir, WINDOWS_CODEX_CACHE_MANIFEST);
  const manifest = await readJsonFile(manifestPath);
  const expectedFiles = sourceRecords.map(({ targetName, size, mtimeMs }) => ({
    targetName,
    size,
    mtimeMs,
  }));
  const manifestMatches = manifest?.version === 2 &&
    manifest.sourcePath === source &&
    JSON.stringify(manifest.files) === JSON.stringify(expectedFiles);
  if (manifestMatches && await Promise.all(sourceRecords.map(({ targetName, size }) =>
    isFileWithSize(join(cacheDir, targetName), size)
  )).then((values) => values.every(Boolean))) {
    return target;
  }

  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const temporaryPaths = [];
  try {
    for (const file of sourceRecords) {
      const temporaryPath = join(
        cacheDir,
        `.${file.targetName}.${process.pid}.${Date.now()}.tmp`,
      );
      temporaryPaths.push(temporaryPath);
      await copyFile(file.sourcePath, temporaryPath);
      await unlink(join(cacheDir, file.targetName)).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      await rename(temporaryPath, join(cacheDir, file.targetName));
    }
    await writeFile(manifestPath, `${JSON.stringify({
      version: 2,
      sourcePath: source,
      files: expectedFiles,
    })}\n`, { encoding: "utf8", mode: 0o600 });
    return target;
  } catch (error) {
    await Promise.all(temporaryPaths.map((path) => unlink(path).catch(() => undefined)));
    throw new Error(`无法准备 Windows Codex CLI 及旁车组件：${error.message}`);
  }
}

async function materializeWindowsStoreCodexExecutable(source) {
  const sourceInfo = await stat(source);
  const sourceDirectory = dirname(source);
  const targetName = basename(source);
  const cacheKey = `${sourceInfo.size}-${Math.trunc(sourceInfo.mtimeMs)}`;
  const cacheDirectory = join(windowsCodexAppCacheRoot(), cacheKey);
  const target = join(cacheDirectory, targetName);
  const manifestPath = join(cacheDirectory, WINDOWS_CODEX_APP_CACHE_MANIFEST);
  const expectedManifest = {
    version: 1,
    sourcePath: source,
    sourceSize: sourceInfo.size,
    sourceMtimeMs: sourceInfo.mtimeMs,
    targetName,
  };
  const manifest = await readJsonFile(manifestPath);
  if (JSON.stringify(manifest) === JSON.stringify(expectedManifest) &&
    await isFileWithSize(target, sourceInfo.size)) {
    return target;
  }

  await mkdir(dirname(cacheDirectory), { recursive: true, mode: 0o700 });
  const temporaryDirectory = `${cacheDirectory}.${process.pid}.${Date.now()}.tmp`;
  try {
    await cp(sourceDirectory, temporaryDirectory, {
      recursive: true,
      force: true,
      preserveTimestamps: true,
    });
    await writeFile(
      join(temporaryDirectory, WINDOWS_CODEX_APP_CACHE_MANIFEST),
      `${JSON.stringify(expectedManifest)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporaryDirectory, cacheDirectory);
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    if (await isFileWithSize(target, sourceInfo.size)) return target;
    throw new Error(`无法准备 Windows Store Codex 启动副本：${error.message}`);
  }

  if (await isFileWithSize(target, sourceInfo.size)) return target;
  throw new Error(`Windows Store Codex 启动副本无效：${target}`);
}

export { materializeWindowsCodexCli, materializeWindowsStoreCodexExecutable };
