import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import { downloadUpdate } from "../app-update/download.mjs";
import { parseCodexVersion } from "./releases.mjs";

const execFileAsync = promisify(execFile);
const MAX_DIAGNOSTIC_LENGTH = 16 * 1024;
const MAX_RESPONSE_LENGTH = 1024 * 1024;

function cleanProbeEnvironment(environment = process.env) {
  const cleaned = { ...environment };
  for (const key of Object.keys(cleaned)) {
    if (key === "CODEX_CLI_PATH" || key.startsWith("CODEX_QUOTA_") ||
      key.startsWith("CODEX_APP_SERVER_")) delete cleaned[key];
  }
  return cleaned;
}

async function readCodexRuntimeVersion(executable, { execFileImpl = execFileAsync } = {}) {
  const { stdout, stderr } = await execFileImpl(executable, ["--version"], {
    env: cleanProbeEnvironment(),
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  const output = `${stdout ?? ""}\n${stderr ?? ""}`;
  const version = /(?:^|\s)codex-cli\s+([^\s]+)/i.exec(output)?.[1] ?? null;
  if (!parseCodexVersion(version)) throw new Error("可执行文件未返回有效的 codex-cli 版本");
  return version;
}

async function readCodexRuntimeFingerprint(executable, {
  realpathImpl = realpath,
  statImpl = stat,
} = {}) {
  const path = resolve(String(executable ?? ""));
  const [canonicalPath, info] = await Promise.all([
    realpathImpl(path),
    statImpl(path, { bigint: true }),
  ]);
  if (!info.isFile()) throw new Error(`Codex 后端不是普通文件：${path}`);
  const mtimeNs = typeof info.mtimeNs === "bigint"
    ? info.mtimeNs
    : BigInt(Math.round(Number(info.mtimeMs) * 1_000_000));
  return {
    realpath: canonicalPath,
    dev: String(info.dev),
    ino: String(info.ino),
    size: String(info.size),
    mtimeNs: String(mtimeNs),
  };
}

async function probeCodexAppServer(executable, {
  spawnImpl = spawn,
  timeoutMs = 15_000,
  environment = process.env,
  appServerArguments = ["app-server"],
} = {}) {
  const probeHome = await mkdtemp(join(tmpdir(), "codex-runtime-probe-"));
  let child;
  try {
    child = spawnImpl(executable, appServerArguments, {
      env: { ...cleanProbeEnvironment(environment), CODEX_HOME: probeHome },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    await rm(probeHome, { recursive: true, force: true });
    throw error;
  }
  let responseBuffer = "";
  let diagnostics = "";
  let initialized = false;
  const closed = new Promise((resolveClose) => {
    child.once("close", (code, signal) => resolveClose({ code, signal }));
  });
  const initializedResponse = new Promise((resolveInitialize, rejectInitialize) => {
    const timer = setTimeout(() => {
      rejectInitialize(new Error("Codex app-server 初始化握手超时"));
    }, timeoutMs);
    timer.unref?.();
    const fail = (error) => {
      clearTimeout(timer);
      rejectInitialize(error);
    };
    child.once("error", (error) => fail(
      new Error(`无法启动 Codex app-server：${error.code ?? error.message}`),
    ));
    child.once("close", (code, signal) => {
      if (!initialized) fail(new Error(
        `Codex app-server 在初始化前退出（${code ?? signal ?? "unknown"}）${diagnostics ? `：${diagnostics}` : ""}`,
      ));
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      responseBuffer += chunk;
      if (responseBuffer.length > MAX_RESPONSE_LENGTH) {
        fail(new Error("Codex app-server 初始化响应过大"));
        return;
      }
      let newline;
      while ((newline = responseBuffer.indexOf("\n")) >= 0) {
        const line = responseBuffer.slice(0, newline).trim();
        responseBuffer = responseBuffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message?.id !== 1) continue;
        if (message.error) {
          fail(new Error(`Codex app-server 初始化失败：${message.error.message ?? "未知错误"}`));
          return;
        }
        if (!Object.hasOwn(message, "result")) continue;
        initialized = true;
        clearTimeout(timer);
        resolveInitialize(message.result);
        return;
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      diagnostics = `${diagnostics}${chunk}`.slice(-MAX_DIAGNOSTIC_LENGTH).trim();
    });
    child.stdin.once("error", (error) => {
      if (!initialized) fail(new Error(`Codex app-server 通信失败：${error.message}`));
    });
  });

  try {
    child.stdin.write(`${JSON.stringify({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "codex_quota_runtime_probe", version: "1" },
        capabilities: { experimentalApi: true },
      },
    })}\n`);
    await initializedResponse;
    child.stdin.end();
    const graceful = await Promise.race([
      closed.then(() => true),
      new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), 1_500)),
    ]);
    if (!graceful) child.kill("SIGKILL");
    await closed;
  } catch (error) {
    child.stdin.destroy();
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
    await closed.catch(() => undefined);
    throw error;
  } finally {
    await rm(probeHome, { recursive: true, force: true });
  }
}

async function verifyCodexRuntime(executable, {
  expectedVersion = null,
  readVersion = readCodexRuntimeVersion,
  probe = probeCodexAppServer,
  appServerArguments = ["app-server"],
} = {}) {
  const path = resolve(String(executable ?? ""));
  const info = await stat(path).catch((error) => {
    if (error?.code === "ENOENT") throw new Error(`Codex 后端不存在：${path}`);
    throw error;
  });
  if (!info.isFile()) throw new Error(`Codex 后端不是普通文件：${path}`);
  await access(path, fsConstants.X_OK).catch(() => {
    throw new Error(`Codex 后端不可执行：${path}`);
  });
  const version = await readVersion(path);
  if (expectedVersion && version !== expectedVersion) {
    throw new Error(`Codex 后端版本不匹配：期望 ${expectedVersion}，实际 ${version}`);
  }
  await probe(path, { appServerArguments });
  return { executable: path, version, size: info.size };
}

async function verifyCodeModeHost(executable) {
  const path = join(dirname(resolve(String(executable ?? ""))), "codex-code-mode-host");
  const info = await stat(path).catch((error) => {
    if (error?.code === "ENOENT") throw new Error(`Codex code-mode host 不存在：${path}`);
    throw error;
  });
  if (!info.isFile()) throw new Error(`Codex code-mode host 不是普通文件：${path}`);
  await access(path, fsConstants.X_OK).catch(() => {
    throw new Error(`Codex code-mode host 不可执行：${path}`);
  });
  return { executable: path, size: info.size };
}

async function verifyManagedCodexRuntime(executable, {
  arch = process.arch,
  verifyArchitecture = verifyMacArchitecture,
  ...options
} = {}) {
  const verified = await verifyCodexRuntime(executable, options);
  const codeModeHost = await verifyCodeModeHost(verified.executable);
  await verifyArchitecture(codeModeHost.executable, arch);
  return { ...verified, codeModeHost };
}

function validateArchiveEntries(output) {
  const entries = String(output ?? "").split(/\r?\n/).filter(Boolean);
  if (!entries.length) throw new Error("Codex 发布包为空");
  for (const entry of entries) {
    if (entry.includes("\0") || entry.includes("\\") || isAbsolute(entry) ||
      entry.startsWith("-")) {
      throw new Error("Codex 发布包包含不安全路径");
    }
    const parts = entry.replace(/^\.\//, "").split("/").filter(Boolean);
    if (!parts.length || parts.includes("..")) throw new Error("Codex 发布包包含不安全路径");
  }
  return entries;
}

async function verifyMacArchitecture(executable, arch, { execFileImpl = execFileAsync } = {}) {
  const expected = arch === "arm64" ? "arm64" : arch === "x64" ? "x86_64" : null;
  if (!expected) throw new Error(`不支持的 macOS 架构：${arch}`);
  const { stdout } = await execFileImpl("/usr/bin/file", ["-b", executable], {
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  if (!String(stdout).includes(expected)) {
    throw new Error(`Codex 后端架构不匹配：期望 ${expected}`);
  }
}

async function installCodexRuntime(asset, {
  root,
  arch = process.arch,
  fetchImpl = fetch,
  onProgress = () => {},
  signal,
  download = downloadUpdate,
  execFileImpl = execFileAsync,
  verifyRuntime = verifyCodexRuntime,
  verifyArchitecture = verifyMacArchitecture,
} = {}) {
  if (!root) throw new Error("Codex 后端安装目录为空");
  if (!parseCodexVersion(asset?.version)) throw new Error("Codex 发布版本无效");
  const components = [
    ["codex", asset?.components?.codex, "codex"],
    ["codeModeHost", asset?.components?.codeModeHost, "codex-code-mode-host"],
  ];
  if (components.some(([, component]) => !component?.name || !component?.url ||
    !Number.isSafeInteger(component?.size) || component.size <= 0 ||
    !/^[a-f0-9]{64}$/.test(component?.sha256 ?? ""))) {
    throw new Error("Codex 发布组件不完整");
  }
  const totalSize = components.reduce((total, [, component]) => total + component.size, 0);
  const finalDirectory = join(root, asset.version);
  const finalExecutable = join(finalDirectory, "codex");
  let replaceExisting = false;
  try {
    const verified = await verifyRuntime(finalExecutable, { expectedVersion: asset.version });
    const codeModeHost = await verifyCodeModeHost(finalExecutable);
    await verifyArchitecture(codeModeHost.executable, arch, { execFileImpl });
    const metadata = await readRuntimeMetadata(finalDirectory);
    if (metadata?.version !== asset.version ||
      metadata?.components?.codex?.executableSize !== verified.size ||
      metadata?.components?.codeModeHost?.executableSize !== codeModeHost.size) {
      throw new Error("Codex 受管版本元数据不完整");
    }
    return { ...verified, codeModeHost, directory: finalDirectory, reused: true };
  } catch (error) {
    replaceExisting = await lstat(finalDirectory).then(() => true, (statError) => {
      if (statError?.code === "ENOENT") return false;
      throw statError;
    });
  }

  await mkdir(root, { recursive: true, mode: 0o700 });
  const work = join(root, `.install-${randomUUID()}`);
  const staging = join(root, `.staging-${randomUUID()}`);
  try {
    await mkdir(staging, { recursive: true, mode: 0o700 });
    let completed = 0;
    const installedComponents = {};
    for (const [key, component, targetName] of components) {
      const archive = join(work, component.name);
      const extracted = join(work, `extracted-${key}`);
      await mkdir(extracted, { recursive: true, mode: 0o700 });
      await download(component, archive, {
        fetchImpl,
        signal,
        onProgress: (received) => onProgress(completed + received, totalSize),
      });
      const listing = await execFileImpl("/usr/bin/tar", ["-tzf", archive], {
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      const entries = validateArchiveEntries(listing.stdout);
      const archiveExecutableName = basename(component.name, ".tar.gz");
      const targetEntry = entries.find((entry) => {
        const name = entry.replace(/\/$/, "").split("/").at(-1);
        return name === archiveExecutableName || name === targetName;
      });
      if (!targetEntry) throw new Error(`Codex 发布包中未找到 ${targetName}`);
      await execFileImpl("/usr/bin/tar", ["-xzf", archive, "-C", extracted, targetEntry], {
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      const source = resolve(extracted, targetEntry);
      if (!(await lstat(source)).isFile()) {
        throw new Error("Codex 发布包中的可执行文件不是普通文件");
      }
      const target = join(staging, targetName);
      await copyFile(source, target);
      await chmod(target, 0o755);
      await verifyArchitecture(target, arch, { execFileImpl });
      const info = await stat(target);
      installedComponents[key] = {
        assetId: component.assetId,
        assetName: component.name,
        sha256: component.sha256,
        executableSize: info.size,
      };
      completed += component.size;
      onProgress(completed, totalSize);
    }
    const executable = join(staging, "codex");
    const verified = await verifyRuntime(executable, { expectedVersion: asset.version });
    const codeModeHost = await verifyCodeModeHost(executable);
    await writeFile(join(staging, "metadata.json"), `${JSON.stringify({
      version: asset.version,
      tag: asset.tag,
      components: installedComponents,
      installedAt: new Date().toISOString(),
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    let damaged = null;
    if (replaceExisting) {
      damaged = `${finalDirectory}.invalid-${Date.now()}`;
      await rename(finalDirectory, damaged);
    }
    try {
      await rename(staging, finalDirectory);
    } catch (error) {
      if (damaged) await rename(damaged, finalDirectory).catch(() => undefined);
      throw error;
    }
    if (damaged) {
      await rm(damaged, { recursive: true, force: true }).catch((error) => {
        console.warn(`[codex-runtime] 新版本已生效，但旧损坏目录清理失败：${error.message}`);
      });
    }
    return {
      ...verified,
      executable: finalExecutable,
      codeModeHost: { ...codeModeHost, executable: join(finalDirectory, "codex-code-mode-host") },
      directory: finalDirectory,
      reused: false,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
    await rm(staging, { recursive: true, force: true });
  }
}

async function readRuntimeMetadata(directory) {
  try {
    return JSON.parse(await readFile(join(directory, "metadata.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export {
  cleanProbeEnvironment,
  installCodexRuntime,
  probeCodexAppServer,
  readCodexRuntimeFingerprint,
  readCodexRuntimeVersion,
  readRuntimeMetadata,
  validateArchiveEntries,
  verifyCodeModeHost,
  verifyCodexRuntime,
  verifyManagedCodexRuntime,
  verifyMacArchitecture,
};
