import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  CodexRuntimeManager,
  SETTINGS_VERSION,
  normalizeSettings,
} from "../src/codex-runtime/manager.mjs";
import {
  installCodexRuntime,
  probeCodexAppServer,
  readCodexRuntimeVersion,
  validateArchiveEntries,
  verifyCodexRuntime,
  verifyManagedCodexRuntime,
} from "../src/codex-runtime/install.mjs";
import {
  codexReleaseCandidate,
  compareCodexVersions,
  fetchCodexReleases,
  parseCodexVersion,
  supportsMcpConnectionSharing,
} from "../src/codex-runtime/releases.mjs";
import { useTempDir } from "./helpers.mjs";

const execFileAsync = promisify(execFile);
const POSIX_RUNTIME_TEST = { skip: process.platform === "win32" };

async function confirmSelectedRuntime(manager, runtime = null) {
  await manager.confirmLaunch({
    runtime: runtime ?? await manager.getLaunchRuntime(),
    disposition: "selected",
  });
}

async function confirmFallbackRuntime(manager, runtime) {
  await manager.confirmLaunch({
    runtime,
    disposition: "runtime-fallback",
  });
}

function release(version = "0.166.0-alpha.6", arch = "aarch64") {
  const tag = `rust-v${version}`;
  const names = [
    `codex-${arch}-apple-darwin.tar.gz`,
    `codex-code-mode-host-${arch}-apple-darwin.tar.gz`,
  ];
  return {
    tag_name: tag,
    draft: false,
    prerelease: version.includes("-"),
    published_at: "2026-10-29T01:41:25Z",
    assets: names.map((name, index) => ({
      id: 42 + index,
      name,
      state: "uploaded",
      size: index === 0 ? 107_637_556 : 24_812_345,
      digest: `sha256:${index === 0 ? "a".repeat(64) : "b".repeat(64)}`,
      browser_download_url: `https://github.com/openai/codex/releases/download/${tag}/${name}`,
    })),
  };
}

test("Codex 版本比较遵循 SemVer 的 Alpha 数字段顺序", () => {
  assert.equal(parseCodexVersion("0.166.0-alpha.6").prerelease.join("."), "alpha.6");
  assert.equal(compareCodexVersions("0.166.0-alpha.6", "0.166.0-alpha.5"), 1);
  assert.equal(compareCodexVersions("0.166.0-alpha.10", "0.166.0-alpha.6"), 1);
  assert.equal(compareCodexVersions("0.166.0", "0.166.0-alpha.10"), 1);
  assert.equal(compareCodexVersions("0.165.0-alpha.1.2", "0.166.0-alpha.1"), -1);
  assert.equal(parseCodexVersion("01.2.3"), null);
  assert.equal(supportsMcpConnectionSharing("0.165.0-alpha.1.2"), false);
  assert.equal(supportsMcpConnectionSharing("0.166.0-alpha.1"), true);
  assert.equal(supportsMcpConnectionSharing("0.166.0-alpha.6"), true);
});

test("只接受 OpenAI 官方发布、当前架构、完整摘要的最新 Alpha", async () => {
  const older = release("0.166.0-alpha.5");
  const latest = release("0.166.0-alpha.10");
  assert.equal(codexReleaseCandidate([older, latest], { arch: "arm64" }).version,
    "0.166.0-alpha.10");
  assert.equal(codexReleaseCandidate([latest], { arch: "arm64" }).size,
    107_637_556 + 24_812_345);
  assert.equal(codexReleaseCandidate([release("0.166.0")], { arch: "arm64" }), null);
  assert.equal(codexReleaseCandidate([latest], { arch: "x64" }), null);
  const wrongOrigin = structuredClone(latest);
  wrongOrigin.assets[0].browser_download_url = "https://example.test/codex.tar.gz";
  assert.equal(codexReleaseCandidate([wrongOrigin], { arch: "arm64" }), null);
  const missingDigest = structuredClone(latest);
  missingDigest.assets[0].digest = null;
  assert.equal(codexReleaseCandidate([missingDigest], { arch: "arm64" }), null);
  const missingCodeModeHost = structuredClone(latest);
  missingCodeModeHost.assets.pop();
  assert.equal(codexReleaseCandidate([missingCodeModeHost], { arch: "arm64" }), null);

  let headers;
  const unchanged = await fetchCodexReleases({ etag: "cached", fetchImpl: async (_url, options) => {
    headers = options.headers;
    return new Response(null, { status: 304 });
  } });
  assert.equal(unchanged.unchanged, true);
  assert.equal(headers["If-None-Match"], "cached");
});

test("[platform:macos-native] 运行时验证同时检查版本与真实 app-server 初始化握手",
  POSIX_RUNTIME_TEST, async t => {
  const directory = await useTempDir(t, "codex-runtime-probe-");
  const executable = join(directory, "codex");
  const codeModeHost = join(directory, "codex-code-mode-host");
  await writeFile(executable, `#!/usr/bin/env node
import { createInterface } from "node:readline";
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.166.0-alpha.6\\n");
} else if (process.argv.includes("app-server")) {
  for await (const line of createInterface({ input: process.stdin })) {
    const message = JSON.parse(line);
    if (message.method === "initialize") process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: "fixture" } }) + "\\n");
  }
}
`, { mode: 0o755 });
  await writeFile(codeModeHost, "host", { mode: 0o755 });
  await chmod(executable, 0o755);
  await chmod(codeModeHost, 0o755);
  assert.equal(await readCodexRuntimeVersion(executable), "0.166.0-alpha.6");
  assert.deepEqual(await verifyCodexRuntime(executable, {
    expectedVersion: "0.166.0-alpha.6",
  }), {
    executable,
    version: "0.166.0-alpha.6",
    size: (await readFile(executable)).length,
  });
  await probeCodexAppServer(executable);
  const managed = await verifyManagedCodexRuntime(executable, {
    expectedVersion: "0.166.0-alpha.6",
    verifyArchitecture: async () => {},
  });
  assert.equal(managed.codeModeHost.executable, codeModeHost);
  await chmod(codeModeHost, 0o600);
  await assert.rejects(verifyManagedCodexRuntime(executable, {
    expectedVersion: "0.166.0-alpha.6",
    verifyArchitecture: async () => {},
  }), /code-mode host 不可执行/);
  await chmod(codeModeHost, 0o755);
  await assert.rejects(verifyCodexRuntime(executable, {
    expectedVersion: "0.166.0-alpha.5",
  }), /版本不匹配/);
});

test("压缩包路径遍历在解包前被拒绝", () => {
  assert.deepEqual(validateArchiveEntries("codex-aarch64-apple-darwin\n"), [
    "codex-aarch64-apple-darwin",
  ]);
  for (const listing of ["../codex\n", "/tmp/codex\n", "safe/../../codex\n", "safe\\codex\n"]) {
    assert.throws(() => validateArchiveEntries(listing), /不安全路径/);
  }
});

test("[platform:macos-native] 受管 Alpha 同时安装 CLI 与 code-mode host，并替换旧的不完整目录",
  POSIX_RUNTIME_TEST, async t => {
  const directory = await useTempDir(t, "codex-runtime-bundle-");
  const root = join(directory, "runtimes");
  const version = "0.166.0-alpha.6";
  const incomplete = join(root, version);
  await mkdir(incomplete, { recursive: true });
  await writeFile(join(incomplete, "codex"), "old", { mode: 0o755 });

  const definitions = [
    ["codex", "codex-aarch64-apple-darwin.tar.gz"],
    ["codex-code-mode-host", "codex-code-mode-host-aarch64-apple-darwin.tar.gz"],
  ];
  const archives = new Map();
  const components = {};
  for (const [targetName, archiveName] of definitions) {
    const source = join(directory, `source-${targetName}`);
    await mkdir(source);
    const archiveExecutableName = archiveName.replace(/\.tar\.gz$/, "");
    await writeFile(join(source, archiveExecutableName), targetName, { mode: 0o755 });
    const archive = join(directory, archiveName);
    await execFileAsync("/usr/bin/tar", ["-czf", archive, "-C", source, archiveExecutableName]);
    const size = (await stat(archive)).size;
    archives.set(archiveName, archive);
    components[targetName === "codex" ? "codex" : "codeModeHost"] = {
      assetId: targetName === "codex" ? 42 : 43,
      name: archiveName,
      size,
      sha256: targetName === "codex" ? "a".repeat(64) : "b".repeat(64),
      url: `https://example.test/${archiveName}`,
    };
  }
  const progress = [];
  const result = await installCodexRuntime({
    version,
    tag: `rust-v${version}`,
    components,
  }, {
    root,
    arch: "arm64",
    download: async (component, target, { onProgress }) => {
      await copyFile(archives.get(component.name), target);
      onProgress(component.size, component.size);
    },
    verifyArchitecture: async () => {},
    verifyRuntime: async (executable) => ({
      executable,
      version,
      size: (await stat(executable)).size,
    }),
    onProgress: (received, total) => progress.push([received, total]),
  });

  assert.equal(await readFile(join(root, version, "codex"), "utf8"), "codex");
  assert.equal(await readFile(join(root, version, "codex-code-mode-host"), "utf8"),
    "codex-code-mode-host");
  assert.equal(result.codeModeHost.executable, join(root, version, "codex-code-mode-host"));
  const metadata = JSON.parse(await readFile(join(root, version, "metadata.json"), "utf8"));
  assert.equal(metadata.components.codex.executableSize, 5);
  assert.equal(metadata.components.codeModeHost.executableSize, 20);
  assert.deepEqual(progress.at(-1), [
    components.codex.size + components.codeModeHost.size,
    components.codex.size + components.codeModeHost.size,
  ]);
  assert.equal((await readdir(root)).some((entry) => entry.includes(".invalid-")), false);
});

test("管理器持久化选择、标记待重启，并在所选文件失效时回退上次可用版本", async t => {
  const dataDir = await useTempDir(t, "codex-runtime-manager-");
  const bundled = join(dataDir, "bundled-codex");
  const custom = join(dataDir, "custom-codex");
  const customNext = join(dataDir, "custom-next-codex");
  await Promise.all([
    writeFile(bundled, "bundled"),
    writeFile(custom, "custom"),
    writeFile(customNext, "custom-next"),
  ]);
  const versions = new Map([
    [bundled, "0.165.0-alpha.1.2"],
    [custom, "0.166.0-alpha.6"],
    [customNext, "0.167.0-alpha.1"],
  ]);
  const verifications = [];
  const options = {
    platform: "darwin",
    arch: "arm64",
    dataDir,
    resolveBundled: async () => bundled,
    readVersion: async path => {
      const version = versions.get(path);
      if (!version) throw new Error("fixture missing");
      return version;
    },
    verifyRuntime: async (path, verification = {}) => {
      verifications.push(verification);
      return { executable: path, version: await options.readVersion(path), size: 1 };
    },
  };
  options.verifyManagedRuntime = options.verifyRuntime;
  const manager = new CodexRuntimeManager(options);
  t.after(() => manager.close());
  await manager.initialize();
  await confirmSelectedRuntime(manager);
  assert.equal(manager.getViewModel().active.version, "0.165.0-alpha.1.2");
  await assert.rejects(manager.setMcpConnectionSharing(true), /不支持 MCP 连接共享/);
  await manager.select({ mode: "custom", path: custom });
  assert.equal(manager.getViewModel().pendingRestart, true);
  assert.equal(manager.getViewModel().selected.version, "0.166.0-alpha.6");
  assert.deepEqual(manager.getViewModel().mcpConnectionSharing, {
    compatible: true,
    enabled: false,
    selected: false,
    active: false,
  });
  await manager.setMcpConnectionSharing(true);
  assert.deepEqual(verifications.at(-1).appServerArguments, [
    "app-server",
    "-c",
    "features.mcp_connection_sharing=true",
  ]);
  await manager.select({ mode: "custom", path: customNext });
  assert.deepEqual(verifications.at(-1).appServerArguments, [
    "app-server",
    "-c",
    "features.mcp_connection_sharing=true",
  ]);
  const selectedLaunch = await manager.getLaunchRuntime();
  assert.equal(selectedLaunch.mcpConnectionSharing, true);
  assert.equal(manager.getViewModel().pendingRestart, true);
  await confirmSelectedRuntime(manager, selectedLaunch);
  assert.equal(manager.getViewModel().pendingRestart, false);
  assert.equal(manager.getViewModel().mcpConnectionSharing.active, true);
  await manager.setMcpConnectionSharing(false);
  assert.equal(manager.getViewModel().pendingRestart, true);
  assert.equal((await manager.getLaunchRuntime()).mcpConnectionSharing, false);
  await confirmSelectedRuntime(manager);
  assert.equal(manager.getViewModel().mcpConnectionSharing.active, false);

  versions.delete(customNext);
  const restored = new CodexRuntimeManager(options);
  t.after(() => restored.close());
  await restored.initialize();
  const launch = await restored.getLaunchRuntime();
  assert.equal(launch.mode, "bundled");
  assert.equal(launch.fallback, true);
  assert.equal(launch.mcpConnectionSharing, false);
  assert.match(restored.getViewModel().error, /已回退到桌面内置版本/);
  await confirmFallbackRuntime(restored, launch);
  const restoredSettings = JSON.parse(
    await readFile(join(dataDir, "codex-runtime-settings.json"), "utf8"),
  );
  assert.equal(restoredSettings.mode, "bundled",
    "备用后端启动成功后应一次性提交实际选择");
  assert.equal(restored.getViewModel().fallback, null);
  assert.equal(restored.getViewModel().active.mode, "bundled");
});

test("读取已经验证的启动版本不会重复启动 app-server 探测", async t => {
  const dataDir = await useTempDir(t, "codex-runtime-cached-selection-");
  const bundled = join(dataDir, "bundled-codex");
  const custom = join(dataDir, "custom-codex");
  await Promise.all([
    writeFile(bundled, "bundled"),
    writeFile(custom, "custom"),
  ]);
  const versions = new Map([
    [bundled, "0.165.0-alpha.1.2"],
    [custom, "0.166.0-alpha.6"],
  ]);
  let verifications = 0;
  const manager = new CodexRuntimeManager({
    platform: "darwin",
    arch: "arm64",
    dataDir,
    resolveBundled: async () => bundled,
    readVersion: async path => versions.get(path),
    verifyRuntime: async path => {
      verifications++;
      return { executable: path, version: versions.get(path), size: 1 };
    },
  });
  t.after(() => manager.close());

  await manager.initialize();
  await manager.select({ mode: "custom", path: custom });
  assert.equal(verifications, 1, "选择自定义后端时应执行一次完整验证");

  const first = await manager.getLaunchRuntime();
  const second = await manager.getLaunchRuntime();
  assert.equal(first.executable, custom);
  assert.equal(second.executable, custom);
  assert.equal(verifications, 1, "读取启动配置不得再次启动 app-server 探测");

  const previousRuntimeId = second.runtimeId;
  versions.set(custom, "0.167.0-alpha.1");
  await writeFile(custom, "custom-updated");
  const updated = await manager.getLaunchRuntime();
  assert.equal(updated.version, "0.167.0-alpha.1",
    "同一路径的外部 CLI 更新后必须重新读取真实版本");
  assert.notEqual(updated.runtimeId, previousRuntimeId);
  assert.equal(verifications, 2, "文件身份变化后只执行一次完整验证");
  await manager.getLaunchRuntime();
  assert.equal(verifications, 2, "新快照验证完成后应继续复用，不得重复探测");
});

test("设置升级保留 MCP 共享开关并初始化桌面版本验证基线", () => {
  const settings = normalizeSettings({
    version: 2,
    mode: "alpha",
    alphaVersion: "0.166.0-alpha.6",
    customPath: null,
    mcpConnectionSharingEnabled: true,
    lastKnownGood: null,
  });
  assert.equal(settings.version, SETTINGS_VERSION);
  assert.equal(settings.mcpConnectionSharingEnabled, true);
  assert.equal(settings.bundledVersionAtLastLaunch, null);
});

test("设置写入失败不会污染待启动运行时状态", async t => {
  const dataDir = await useTempDir(t, "codex-runtime-settings-transaction-");
  const bundled = join(dataDir, "bundled-codex");
  await writeFile(bundled, "bundled");
  const manager = new CodexRuntimeManager({
    platform: "darwin",
    arch: "arm64",
    dataDir,
    resolveBundled: async () => bundled,
    readVersion: async () => "0.166.0-alpha.6",
    verifyRuntime: async path => ({
      executable: path,
      version: "0.166.0-alpha.6",
      size: 1,
    }),
  });
  t.after(() => manager.close());
  await manager.initialize();
  manager.persistSettings = async () => {
    throw new Error("fixture settings write failure");
  };

  await assert.rejects(manager.setMcpConnectionSharing(true), /settings write failure/);
  assert.equal((await manager.getLaunchRuntime()).mcpConnectionSharing, false);
  assert.equal(manager.getViewModel().mcpConnectionSharing.enabled, false);
  assert.equal(manager.getViewModel().status, "failed");
});

test("模型功能降级只确认实际内置运行时，不覆盖用户选择的外部后端", async t => {
  const dataDir = await useTempDir(t, "codex-runtime-degraded-launch-");
  const bundled = join(dataDir, "bundled-codex");
  const custom = join(dataDir, "custom-codex");
  await Promise.all([
    writeFile(bundled, "bundled"),
    writeFile(custom, "custom"),
  ]);
  const versions = new Map([
    [bundled, "0.165.0-alpha.1.2"],
    [custom, "0.166.0-alpha.6"],
  ]);
  const manager = new CodexRuntimeManager({
    platform: "darwin",
    arch: "arm64",
    dataDir,
    resolveBundled: async () => bundled,
    readVersion: async path => versions.get(path),
    verifyRuntime: async path => ({
      executable: path,
      version: versions.get(path),
      size: 1,
    }),
  });
  t.after(() => manager.close());
  await manager.initialize();
  await manager.confirmLaunch({
    runtime: await manager.getLaunchRuntime(),
    disposition: "selected",
  });
  await manager.select({ mode: "custom", path: custom });

  const requested = await manager.getLaunchRuntime();
  const actual = await manager.getOfficialFallbackRuntime(requested);
  await manager.confirmLaunch({
    runtime: actual,
    disposition: "degraded-official",
  });

  const view = manager.getViewModel();
  const settings = JSON.parse(
    await readFile(join(dataDir, "codex-runtime-settings.json"), "utf8"),
  );
  assert.equal(view.active.mode, "bundled");
  assert.equal(view.selected.mode, "custom");
  assert.equal(view.selected.executable, custom);
  assert.equal(view.pendingRestart, true);
  assert.equal(settings.mode, "custom");
  assert.equal(settings.customPath, custom);
  assert.equal(settings.lastKnownGood.mode, "bundled");
});

test("桌面内置 CLI 文件身份变化后要求重启而不是复用旧进程", async t => {
  const dataDir = await useTempDir(t, "codex-runtime-bundled-identity-");
  const bundled = join(dataDir, "bundled-codex");
  await writeFile(bundled, "bundled-v1");
  let version = "0.166.0";
  const options = {
    platform: "darwin",
    arch: "arm64",
    dataDir,
    resolveBundled: async () => bundled,
    readVersion: async () => version,
  };
  const initial = new CodexRuntimeManager(options);
  await initial.initialize();
  await confirmSelectedRuntime(initial);
  initial.close();

  version = "0.167.0";
  await writeFile(bundled, "bundled-v2-expanded");
  const updated = new CodexRuntimeManager(options);
  t.after(() => updated.close());
  await updated.initialize();
  const launch = await updated.getLaunchRuntime();
  assert.equal(launch.version, "0.167.0");
  assert.equal(launch.forceRestart, true);
});

test("桌面内置 CLI 更新后重新验证所选 Alpha，验证失败时回退新版内置 CLI", async t => {
  const dataDir = await useTempDir(t, "codex-runtime-desktop-update-");
  const bundled = join(dataDir, "bundled-codex");
  const version = "0.166.0-alpha.6";
  const directory = join(dataDir, "codex-runtimes", version);
  const executable = join(directory, "codex");
  const codeModeHost = join(directory, "codex-code-mode-host");
  await mkdir(directory, { recursive: true });
  await writeFile(bundled, "bundled");
  await writeFile(executable, "managed", { mode: 0o755 });
  await writeFile(codeModeHost, "host", { mode: 0o755 });
  await writeFile(join(directory, "metadata.json"), JSON.stringify({
    version,
    components: {
      codex: { executableSize: 7 },
      codeModeHost: { executableSize: 4 },
    },
  }));

  let bundledVersion = "0.165.0-alpha.1.2";
  let rejectManaged = false;
  let managedVerifications = 0;
  const options = {
    platform: "darwin",
    arch: "arm64",
    dataDir,
    resolveBundled: async () => bundled,
    readVersion: async path => path === bundled ? bundledVersion : version,
    verifyRuntime: async path => ({
      executable: path,
      version: path === bundled ? bundledVersion : version,
      size: 7,
    }),
    verifyManagedRuntime: async path => {
      managedVerifications += 1;
      if (rejectManaged) throw new Error("fixture incompatible app-server");
      return {
        executable: path,
        version,
        size: 7,
        codeModeHost: { executable: codeModeHost, size: 4 },
      };
    },
  };

  const initial = new CodexRuntimeManager(options);
  await initial.initialize();
  await initial.select({ mode: "alpha", version });
  await confirmSelectedRuntime(initial);
  initial.close();
  assert.equal(
    JSON.parse(await readFile(join(dataDir, "codex-runtime-settings.json"))).bundledVersionAtLastLaunch,
    "0.165.0-alpha.1.2",
  );

  bundledVersion = "0.167.0";
  const afterUpdate = new CodexRuntimeManager(options);
  await afterUpdate.initialize();
  t.after(() => afterUpdate.close());
  assert.equal(afterUpdate.getViewModel().selected.version, version);
  assert.deepEqual(afterUpdate.getViewModel().bundledUpdate, {
    previousVersion: "0.165.0-alpha.1.2",
    currentVersion: "0.167.0",
    selectedVersion: version,
    status: "revalidated",
  });
  assert.equal(managedVerifications, 2);
  await confirmSelectedRuntime(afterUpdate);
  afterUpdate.close();

  bundledVersion = "0.168.0";
  rejectManaged = true;
  const incompatible = new CodexRuntimeManager(options);
  await incompatible.initialize();
  t.after(() => incompatible.close());
  assert.equal(incompatible.getViewModel().selected.mode, "bundled");
  assert.equal(incompatible.getViewModel().selected.version, "0.168.0");
  assert.equal(incompatible.getViewModel().fallback.using.version, "0.168.0");
  assert.deepEqual(incompatible.getViewModel().bundledUpdate, {
    previousVersion: "0.167.0",
    currentVersion: "0.168.0",
    selectedVersion: "0.168.0",
    status: "fallback",
  });
});

test("桌面更新后实际启动失败会跳过旧外部后端并回退新版内置 CLI", async t => {
  const dataDir = await useTempDir(t, "codex-runtime-launch-fallback-");
  const bundled = join(dataDir, "bundled-codex");
  const oldCustom = join(dataDir, "old-custom-codex");
  const nextCustom = join(dataDir, "next-custom-codex");
  await Promise.all([
    writeFile(bundled, "bundled"),
    writeFile(oldCustom, "old-custom"),
    writeFile(nextCustom, "next-custom"),
  ]);
  let bundledVersion = "0.167.0";
  const versions = new Map([
    [oldCustom, "0.166.0-alpha.5"],
    [nextCustom, "0.166.0-alpha.6"],
  ]);
  const options = {
    platform: "darwin",
    arch: "arm64",
    dataDir,
    resolveBundled: async () => bundled,
    readVersion: async path => path === bundled ? bundledVersion : versions.get(path),
    verifyRuntime: async path => ({
      executable: path,
      version: path === bundled ? bundledVersion : versions.get(path),
      size: 1,
    }),
  };
  const initial = new CodexRuntimeManager(options);
  await initial.initialize();
  await initial.select({ mode: "custom", path: oldCustom });
  await confirmSelectedRuntime(initial);
  await initial.select({ mode: "custom", path: nextCustom });
  initial.close();

  bundledVersion = "0.168.0";
  const manager = new CodexRuntimeManager(options);
  t.after(() => manager.close());
  await manager.initialize();
  assert.deepEqual(manager.getViewModel().bundledUpdate, {
    previousVersion: "0.167.0",
    currentVersion: "0.168.0",
    selectedVersion: "0.166.0-alpha.6",
    status: "revalidated",
  });
  const failed = await manager.getLaunchRuntime();
  const fallback = await manager.rollbackAfterLaunchFailure(
    failed,
    new Error("fixture launch failure"),
  );
  assert.equal(fallback.mode, "bundled");
  assert.equal(fallback.version, "0.168.0");
  assert.equal(manager.getViewModel().bundledUpdate.status, "fallback");
  assert.equal(manager.getViewModel().bundledUpdate.selectedVersion, "0.168.0");
  assert.equal(
    JSON.parse(await readFile(join(dataDir, "codex-runtime-settings.json"))).mode,
    "custom",
  );
  await confirmFallbackRuntime(manager, fallback);
  assert.equal(manager.getViewModel().fallback, null);
  await manager.setMcpConnectionSharing(true);
  assert.equal(manager.getViewModel().mcpConnectionSharing.selected, true);
  assert.equal(manager.getViewModel().pendingRestart, true);
  const settings = JSON.parse(await readFile(join(dataDir, "codex-runtime-settings.json")));
  assert.equal(settings.mode, "bundled");
  assert.equal(settings.bundledVersionAtLastLaunch, "0.168.0");
});

test("桌面更新后的初始化验证失败不会回退旧外部后端", async t => {
  const dataDir = await useTempDir(t, "codex-runtime-validation-fallback-");
  const bundled = join(dataDir, "bundled-codex");
  const oldCustom = join(dataDir, "old-custom-codex");
  const nextCustom = join(dataDir, "next-custom-codex");
  await Promise.all([
    writeFile(bundled, "bundled"),
    writeFile(oldCustom, "old-custom"),
    writeFile(nextCustom, "next-custom"),
  ]);
  let bundledVersion = "0.167.0";
  let rejectNext = false;
  const versions = new Map([
    [oldCustom, "0.166.0-alpha.5"],
    [nextCustom, "0.166.0-alpha.6"],
  ]);
  const options = {
    platform: "darwin",
    arch: "arm64",
    dataDir,
    resolveBundled: async () => bundled,
    readVersion: async path => path === bundled ? bundledVersion : versions.get(path),
    verifyRuntime: async path => {
      if (rejectNext && path === nextCustom) throw new Error("fixture incompatible app-server");
      return {
        executable: path,
        version: path === bundled ? bundledVersion : versions.get(path),
        size: 1,
      };
    },
  };
  const initial = new CodexRuntimeManager(options);
  await initial.initialize();
  await initial.select({ mode: "custom", path: oldCustom });
  await confirmSelectedRuntime(initial);
  await initial.select({ mode: "custom", path: nextCustom });
  initial.close();

  bundledVersion = "0.168.0";
  rejectNext = true;
  const manager = new CodexRuntimeManager(options);
  t.after(() => manager.close());
  await manager.initialize();
  assert.equal(manager.getViewModel().selected.mode, "bundled");
  assert.equal(manager.getViewModel().selected.version, "0.168.0");
  assert.equal(manager.getViewModel().fallback.using.mode, "bundled");
});

test("未发生桌面更新时启动失败仍优先回退上次可用后端", async t => {
  const dataDir = await useTempDir(t, "codex-runtime-last-known-good-");
  const bundled = join(dataDir, "bundled-codex");
  const oldCustom = join(dataDir, "old-custom-codex");
  const nextCustom = join(dataDir, "next-custom-codex");
  await Promise.all([
    writeFile(bundled, "bundled"),
    writeFile(oldCustom, "old-custom"),
    writeFile(nextCustom, "next-custom"),
  ]);
  const versions = new Map([
    [bundled, "0.168.0"],
    [oldCustom, "0.166.0-alpha.5"],
    [nextCustom, "0.166.0-alpha.6"],
  ]);
  const verifications = [];
  const options = {
    platform: "darwin",
    arch: "arm64",
    dataDir,
    resolveBundled: async () => bundled,
    readVersion: async path => versions.get(path),
    verifyRuntime: async (path, verification = {}) => {
      verifications.push(verification);
      return { executable: path, version: versions.get(path), size: 1 };
    },
  };
  const manager = new CodexRuntimeManager(options);
  t.after(() => manager.close());
  await manager.initialize();
  await confirmSelectedRuntime(manager);
  await manager.setMcpConnectionSharing(true);
  await manager.select({ mode: "custom", path: oldCustom });
  await confirmSelectedRuntime(manager);
  await manager.setMcpConnectionSharing(false);
  await manager.select({ mode: "custom", path: nextCustom });
  const failed = await manager.getLaunchRuntime();
  const fallback = await manager.rollbackAfterLaunchFailure(
    failed,
    new Error("fixture launch failure"),
  );
  assert.equal(fallback.mode, "custom");
  assert.equal(fallback.executable, oldCustom);
  assert.equal(fallback.mcpConnectionSharing, true);
  assert.deepEqual(verifications.at(-1).appServerArguments, [
    "app-server",
    "-c",
    "features.mcp_connection_sharing=true",
  ]);
  await confirmFallbackRuntime(manager, fallback);
  assert.equal(manager.getViewModel().fallback, null);
  await manager.setMcpConnectionSharing(false);
  assert.equal(manager.getViewModel().mcpConnectionSharing.enabled, false);
  assert.equal(manager.getViewModel().mcpConnectionSharing.selected, false);
  assert.equal(manager.getViewModel().mcpConnectionSharing.active, true);
  assert.equal(manager.getViewModel().pendingRestart, true);
});

test("自动回退再次失败时撤销临时候选并保留原后端设置", async t => {
  const dataDir = await useTempDir(t, "codex-runtime-double-failure-");
  const bundled = join(dataDir, "bundled-codex");
  const oldCustom = join(dataDir, "old-custom-codex");
  const nextCustom = join(dataDir, "next-custom-codex");
  await Promise.all([
    writeFile(bundled, "bundled"),
    writeFile(oldCustom, "old-custom"),
    writeFile(nextCustom, "next-custom"),
  ]);
  const versions = new Map([
    [bundled, "0.165.0-alpha.1.2"],
    [oldCustom, "0.166.0-alpha.5"],
    [nextCustom, "0.166.0-alpha.6"],
  ]);
  const manager = new CodexRuntimeManager({
    platform: "darwin",
    arch: "arm64",
    dataDir,
    resolveBundled: async () => bundled,
    readVersion: async path => versions.get(path),
    verifyRuntime: async path => ({
      executable: path,
      version: versions.get(path),
      size: 1,
    }),
  });
  t.after(() => manager.close());
  await manager.initialize();
  await manager.select({ mode: "custom", path: oldCustom });
  await confirmSelectedRuntime(manager);
  await manager.select({ mode: "custom", path: nextCustom });

  const settingsPath = join(dataDir, "codex-runtime-settings.json");
  const failed = await manager.getLaunchRuntime();
  const fallback = await manager.rollbackAfterLaunchFailure(
    failed,
    new Error("fixture selected launch failure"),
  );
  assert.equal(fallback.executable, oldCustom);
  assert.equal((await manager.getLaunchRuntime()).executable, oldCustom);
  assert.equal(JSON.parse(await readFile(settingsPath)).customPath, nextCustom);

  assert.equal(
    manager.cancelFallbackAttempt(new Error("fixture fallback launch failure")),
    true,
  );
  assert.match(manager.getViewModel().error, /已保留原设置/);
  assert.equal((await manager.getLaunchRuntime()).executable, nextCustom);
  assert.equal(JSON.parse(await readFile(settingsPath)).customPath, nextCustom);
});

test("启动器和注入器共用同一套受管后端回退流程", async t => {
  const manager = new CodexRuntimeManager({ platform: "linux" });
  t.after(() => manager.close());
  const requested = { codexRuntime: { managed: true, version: "0.166.0-alpha.6" } };
  const fallbackOptions = {
    codexRuntime: { managed: true, version: "0.166.0-alpha.5" },
    preparationError: "fixture model catalog unavailable",
  };
  let attempts = 0;
  manager.rollbackAfterLaunchFailure = async () => ({ version: "0.166.0-alpha.5" });

  const launched = await manager.launchWithFallback(requested, {
    prepare: async () => fallbackOptions,
    launch: async (options) => {
      attempts++;
      if (attempts === 1) {
        const error = new Error("fixture relay not ready");
        error.codexReadiness = {
          relayRequired: true,
          debugReady: true,
          relayStateReady: false,
        };
        throw error;
      }
      return options.codexRuntime.version;
    },
  });

  assert.equal(attempts, 2);
  assert.equal(launched.options, fallbackOptions);
  assert.equal(launched.result, "0.166.0-alpha.5");
});

test("管理器忽略缺少 code-mode host 的旧受管目录", async t => {
  const dataDir = await useTempDir(t, "codex-runtime-incomplete-");
  const bundled = join(dataDir, "bundled");
  const directory = join(dataDir, "codex-runtimes", "0.166.0-alpha.6");
  await mkdir(directory, { recursive: true });
  await writeFile(bundled, "bundled");
  await writeFile(join(directory, "codex"), "managed", { mode: 0o755 });
  await writeFile(join(directory, "metadata.json"), JSON.stringify({
    version: "0.166.0-alpha.6",
    executableSize: 7,
  }));
  const manager = new CodexRuntimeManager({
    platform: "darwin",
    arch: "arm64",
    dataDir,
    resolveBundled: async () => bundled,
    readVersion: async () => "0.165.0-alpha.1.2",
  });
  t.after(() => manager.close());
  await manager.initialize();
  assert.deepEqual(manager.getViewModel().installed, []);
  assert.equal((await manager.getLaunchRuntime()).mode, "bundled");
});

test("管理器仅在同版本正式目录验证通过后清理历史损坏目录", async t => {
  const dataDir = await useTempDir(t, "codex-runtime-invalid-cleanup-");
  const bundled = join(dataDir, "bundled");
  const version = "0.166.0-alpha.6";
  const directory = join(dataDir, "codex-runtimes", version);
  const invalid = join(dataDir, "codex-runtimes", `${version}.invalid-123456`);
  await Promise.all([
    mkdir(directory, { recursive: true }),
    mkdir(invalid, { recursive: true }),
    writeFile(bundled, "bundled"),
  ]);
  await writeFile(join(directory, "codex"), "managed", { mode: 0o755 });
  await writeFile(join(directory, "codex-code-mode-host"), "host", { mode: 0o755 });
  await writeFile(join(directory, "metadata.json"), JSON.stringify({
    version,
    components: {
      codex: { executableSize: 7 },
      codeModeHost: { executableSize: 4 },
    },
  }));
  await writeFile(join(invalid, "codex"), "old");
  const manager = new CodexRuntimeManager({
    platform: "darwin",
    arch: "arm64",
    dataDir,
    resolveBundled: async () => bundled,
    readVersion: async path => path === bundled ? "0.165.0-alpha.1.2" : version,
    verifyManagedRuntime: async path => ({
      executable: path,
      version,
      size: 7,
      codeModeHost: { executable: join(directory, "codex-code-mode-host"), size: 4 },
    }),
  });
  t.after(() => manager.close());
  await manager.initialize();
  assert.equal((await readdir(join(dataDir, "codex-runtimes"))).includes(
    `${version}.invalid-123456`,
  ), false);
});

test("最新 Alpha 下载完成后写入受管目录并只标记下次重启生效", async t => {
  const dataDir = await useTempDir(t, "codex-runtime-install-");
  const bundled = join(dataDir, "bundled");
  await writeFile(bundled, "bundled");
  const versions = new Map([[bundled, "0.166.0-alpha.1"]]);
  const managedVerifications = [];
  const manager = new CodexRuntimeManager({
    platform: "darwin",
    arch: "arm64",
    dataDir,
    resolveBundled: async () => bundled,
    readVersion: async path => versions.get(path) ?? "0.166.0-alpha.6",
    verifyRuntime: async (path, { expectedVersion } = {}) => ({
      executable: path,
      version: expectedVersion ?? versions.get(path),
      size: 7,
    }),
    verifyManagedRuntime: async (path, verification = {}) => {
      managedVerifications.push(verification);
      return {
        executable: path,
        version: verification.expectedVersion ?? versions.get(path),
        size: 7,
        codeModeHost: { executable: join(path, "..", "codex-code-mode-host"), size: 4 },
      };
    },
    fetchReleases: async () => ({ releases: [release()], etag: "fixture" }),
    installRuntime: async (asset, { root, onProgress }) => {
      const directory = join(root, asset.version);
      const executable = join(directory, "codex");
      const codeModeHost = join(directory, "codex-code-mode-host");
      await mkdir(directory, { recursive: true });
      await writeFile(executable, "managed", { mode: 0o755 });
      await writeFile(codeModeHost, "host", { mode: 0o755 });
      await writeFile(join(directory, "metadata.json"), JSON.stringify({
        version: asset.version,
        components: {
          codex: { executableSize: 7 },
          codeModeHost: { executableSize: 4 },
        },
        installedAt: "2026-10-29T00:00:00Z",
      }));
      onProgress(asset.size, asset.size);
      versions.set(executable, asset.version);
      return {
        executable,
        codeModeHost: { executable: codeModeHost, size: 4 },
        directory,
        version: asset.version,
        size: 7,
      };
    },
  });
  t.after(() => manager.close());
  await manager.initialize();
  await confirmSelectedRuntime(manager);
  await manager.setMcpConnectionSharing(true);
  await manager.installLatest();
  const view = manager.getViewModel();
  assert.equal(view.selected.version, "0.166.0-alpha.6");
  assert.equal(view.pendingRestart, true);
  assert.equal(view.operation, null);
  assert.equal(view.mcpConnectionSharing.compatible, true);
  assert.equal(view.mcpConnectionSharing.enabled, true);
  assert.deepEqual(managedVerifications.at(-1).appServerArguments, [
    "app-server",
    "-c",
    "features.mcp_connection_sharing=true",
  ]);
  assert.match(view.message, /重启 Codex 后生效/);
  assert.equal(JSON.parse(await readFile(join(dataDir, "codex-runtime-settings.json"))).mode, "alpha");
});
