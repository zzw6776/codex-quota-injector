import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import packageJson from "../package.json" with { type: "json" };
import { CdpClient, findCodexTarget } from "../src/cdp-client.mjs";
import { inspectLifecycleHost, publicLifecycleHost } from "../src/lifecycle-host.mjs";
import { RELAY_PROTOCOL_VERSION } from "../src/relay-contract.mjs";
import { WIDGET_RUNTIME_VERSION } from "../src/widget.mjs";
import { liveProfiles } from "../live-tests/runtime.mjs";
import {
  currentRuntimeTarget,
  resolveRuntimeSelection,
  runtimeTargetLabel,
  runtimeTargetsForPlatform,
  WSL_NATIVE,
} from "./test-runtime-targets.mjs";
import { requireFreeResult, RESULTS, ROOT, sourceSnapshot, writeReport } from "./test-support.mjs";
import {
  DESKTOP_HOST_REPORT_VERSION,
  backendComponentId,
  combineBStatuses,
  desktopBatch,
  desktopComponentId,
  desktopHostProgressHtml,
  desktopHostPrompt,
  evaluateDesktopHostEvidence,
  findDesktopRolloutEvidence,
  findRequestToolInventoryEvidence,
  isDesktopSessionTerminal,
  parseDesktopRollout,
} from "./desktop-host-evidence.mjs";
import {
  prepareWindowsComputerUseFixture,
  readWindowsComputerUseFixture,
} from "./test-computer-use-windows.mjs";
export {
  findWindowsNodeExecutable,
  isWslRuntime,
  toWindowsPath,
} from "./windows-test-host.mjs";

const execFileAsync = promisify(execFile);
const DESKTOP_RESULTS = join(RESULTS, "desktop-host");
const DEFAULT_TIMEOUT_MS = 20 * 60_000;

// Browser Use opens this fixture over loopback HTTP because agent-driven file://
// navigation is rejected before the page loads. The hosted version records
// submissions and downloads independently instead of trusting the model reply.
export function desktopFixture({ artifactHref, evidenceEndpoint } = {}) {
  const marker = `BHOST_${randomBytes(8).toString("hex")}`;
  const artifact = `ARTIFACT_${marker}\n`;
  const download = artifactHref ?? `data:text/plain;charset=utf-8,${encodeURIComponent(artifact)}`;
  const persist = evidenceEndpoint
    ? `const response=await fetch(${JSON.stringify(evidenceEndpoint)},{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({value})});if(!response.ok){document.querySelector("#result").textContent="服务端拒绝";return}`
    : "";
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Codex 本地宿主回归</title>
    <style>body{font:18px system-ui;max-width:780px;margin:50px auto;padding:20px}input{width:100%;padding:12px;font:inherit;box-sizing:border-box}button{margin-top:20px;padding:12px 25px;font:inherit}code,pre{display:block;padding:20px;background:#eef1f7;white-space:pre-wrap;overflow-wrap:anywhere}</style>
    <h1>桌面工具回归材料</h1><p>读取下面的随机标记，输入并发送一次。</p><code id="marker">${marker}</code>
    <form id="form"><label for="value">测试标记</label><input id="value" autocomplete="off"><button id="submit">发送</button></form>
    <p id="result" role="status"></p><a id="download" href="${download}" download="codex-fixture.txt">下载测试产物</a>
    <h2>可独立读取的操作记录</h2><pre id="evidence">{"submissions":[]}</pre>
    <script>const marker=${JSON.stringify(marker)};const state={submissions:[]};document.querySelector("#form").onsubmit=async e=>{e.preventDefault();const value=document.querySelector("#value").value;if(value!==marker){document.querySelector("#result").textContent="标记不匹配";return}${persist};state.submissions.push({value,at:new Date().toISOString()});document.querySelector("#evidence").textContent=JSON.stringify(state);document.querySelector("#result").textContent="已收到"};</script></html>`;
  return { marker, artifact, html, dataUrl: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` };
}

export async function startDesktopFixtureServer({ onEvidence } = {}) {
  const fixture = desktopFixture({ artifactHref: "/artifact", evidenceEndpoint: "/submission" });
  const evidence = { pageRequests: 0, submissions: [], invalidSubmissions: 0, artifactRequests: 0 };
  const notify = () => Promise.resolve(onEvidence?.(structuredClone(evidence))).catch(() => undefined);
  const server = createServer((request, response) => {
    void handleFixtureRequest(request, response, { fixture, evidence, notify }).catch((error) => {
      if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(`Internal Error: ${error.message}`);
    });
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolveListen();
    });
  });
  const url = `http://127.0.0.1:${server.address().port}/`;
  let closed = false;
  return {
    fixture,
    url,
    submitUrl: new URL("submission", url).href,
    artifactUrl: new URL("artifact", url).href,
    evidenceUrl: new URL("evidence", url).href,
    server,
    getEvidence: () => structuredClone(evidence),
    evidence: () => structuredClone(evidence),
    async close() {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    },
  };
}

async function handleFixtureRequest(request, response, { fixture, evidence, notify }) {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
  if (request.method === "GET" && pathname === "/") {
    evidence.pageRequests++;
    void notify();
    response.writeHead(200, {
      ...headers,
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'",
    });
    response.end(fixture.html);
    return;
  }
  if (request.method === "GET" && pathname === "/artifact") {
    evidence.artifactRequests++;
    void notify();
    response.writeHead(200, {
      ...headers,
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": 'attachment; filename="codex-fixture.txt"',
    });
    response.end(fixture.artifact);
    return;
  }
  if (request.method === "GET" && pathname === "/evidence") {
    response.writeHead(200, { ...headers, "content-type": "application/json; charset=utf-8" });
    response.end(`${JSON.stringify(evidence)}\n`);
    return;
  }
  if (request.method === "POST" && pathname === "/submission") {
    const body = await readRequestBody(request, 4_096);
    let value = "";
    try { value = String(JSON.parse(body).value ?? ""); } catch {}
    if (value !== fixture.marker) {
      evidence.invalidSubmissions++;
      void notify();
      response.writeHead(400, { ...headers, "content-type": "application/json" });
      response.end('{"ok":false}');
      return;
    }
    evidence.submissions.push({ value, at: new Date().toISOString() });
    void notify();
    response.writeHead(200, { ...headers, "content-type": "application/json" });
    response.end('{"ok":true}');
    return;
  }
  if (pathname === "/submission") {
    response.writeHead(405, { ...headers, allow: "POST" });
    response.end("Method Not Allowed");
    return;
  }
  if (!["GET", "POST"].includes(request.method ?? "")) {
    response.writeHead(405, { ...headers, allow: "GET, POST" });
    response.end("Method Not Allowed");
    return;
  }
  response.writeHead(404, headers);
  response.end("Not Found");
}

export function verifyDesktopFixtureEvidence({ marker, evidence }) {
  if (!marker || !evidence || !Array.isArray(evidence.submissions)) {
    throw new Error("桌面宿主证据格式无效");
  }
  if (!Number.isInteger(evidence.pageRequests) || evidence.pageRequests < 1) {
    throw new Error("没有观察到实际页面请求");
  }
  if (evidence.submissions.length !== 1) {
    throw new Error(`预期恰好一次提交，实际 ${evidence.submissions.length} 次`);
  }
  if (evidence.submissions[0]?.value !== marker) {
    throw new Error("提交值与本轮随机标记不一致");
  }
  if (Number(evidence.invalidSubmissions ?? 0) !== 0) {
    throw new Error(`观察到 ${evidence.invalidSubmissions} 次错误提交`);
  }
  if (evidence.artifactRequests !== 1) {
    throw new Error(`预期恰好一次产物请求，实际 ${evidence.artifactRequests} 次`);
  }
  return {
    pageRequests: evidence.pageRequests,
    submissionCount: evidence.submissions.length,
    artifactRequests: evidence.artifactRequests,
  };
}

async function readRequestBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("请求正文过大");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.fixtureOnly) {
    await runFixtureOnly();
    return;
  }
  if (options.statusRunId) {
    await printDesktopStatus(options.statusRunId, options.rolloutPath);
    return;
  }
  if (!options.profile) throw new Error("必须指定 --profile=official 或 --profile=deepseek");
  if (!options.plan && !options.confirmTokenUse) {
    throw new Error("桌面任务会产生对应模型用量；请先查看计划并取得该 B 批本次授权，再追加 --confirm-token-use");
  }
  const runtimeTarget = await selectedRuntime(options.runtime, {
    allowUnsupportedCurrent: options.plan,
  });
  const plan = await desktopPlan(options.profile, runtimeTarget, options.triggerMode);
  if (options.plan) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  await runDesktopSession({ ...options, ...plan, runtimeTarget });
}

async function runFixtureOnly() {
  const hosted = await startDesktopFixtureServer();
  const pagePath = join(RESULTS, "desktop-host-page.html");
  const manifestPath = join(RESULTS, "desktop-host-fixture.json");
  await mkdir(RESULTS, { recursive: true });
  await writeFile(pagePath, hosted.fixture.html);
  await writeReport(manifestPath, {
    marker: hosted.fixture.marker,
    artifact: hosted.fixture.artifact,
    pagePath,
    url: hosted.url,
    createdAt: new Date().toISOString(),
  });
  console.log(JSON.stringify({
    pagePath,
    manifestPath,
    url: hosted.url,
    instruction: "仅提供免费本机材料，不执行 B 桌面验收；按 Ctrl-C 停止回环服务。",
  }, null, 2));
  await new Promise((resolveStop) => {
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      await hosted.close();
      resolveStop();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function desktopPlan(profile, runtimeTarget, triggerMode = "direct") {
  const snapshot = await sourceSnapshot();
  return {
    reportVersion: DESKTOP_HOST_REPORT_VERSION,
    batch: desktopBatch(profile),
    component: desktopComponentId(profile, runtimeTarget),
    backendComponent: backendComponentId(profile, runtimeTarget),
    profile,
    triggerMode,
    expectedModel: profile === "deepseek" ? "deepseek-v4-flash" : "Codex 官方模型",
    platform: process.platform,
    arch: process.arch,
    runtimeTarget,
    runtimeLabel: runtimeTargetLabel(runtimeTarget),
    projectVersion: packageJson.version,
    expectedRelayProtocol: RELAY_PROTOCOL_VERSION,
    expectedWidgetRuntime: WIDGET_RUNTIME_VERSION,
    sourceSnapshot: snapshot,
    changesDesktopRuntime: false,
    actions: [
      "核对真实桌面版本、中继协议、Widget 和当前运行环境",
      "绑定含随机标记的真实桌面任务 rollout 与实际模型",
      "实际 functions.exec 成功输出和失败续接",
      "实际 codex_app 四个常用只读入口读取任务、项目与用量",
      "实际 web.run search/open/find",
      process.platform === "win32"
        ? "实际 computer use 操作 Windows 原生非浏览器应用并留下单次启动、提交和截图证据"
        : "实际 computer use 打开、输入、单次提交、截图和下载",
      "记录模型请求实际收到的脱敏工具清单，并区分不支持、未执行和执行失败",
    ],
    note: "后台 B 与桌面入口报告分别保存；两者属于同一源码、平台、运行环境和供应商且都通过时，B 总状态才是 passed。",
  };
}

async function runDesktopSession(plan) {
  const free = await requireFreeResult({ runtimeTarget: plan.runtimeTarget });
  const backend = await requireBackendReport(plan, free.snapshot.sha256);
  const runtimeBinding = await inspectDesktopRuntime(plan);
  const upstreamAttributions = await readDesktopUpstreamAttributions(plan.runtimeTarget);
  const customModels = (await liveProfiles()).filter((profile) => profile.id !== "official")
    .map((profile) => profile.model).filter(Boolean);
  const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const runDirectory = join(DESKTOP_RESULTS, runId);
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  let report;
  const nativeFixture = process.platform === "win32"
    ? await prepareWindowsComputerUseFixture({
        resultDirectory: DESKTOP_RESULTS,
        runId,
        marker: `BHOST_${randomBytes(8).toString("hex")}`,
      })
    : null;
  const hosted = nativeFixture ? null : await startDesktopFixtureServer({
    onEvidence: (httpEvidence) => {
      if (!report) return;
      report.httpEvidence = httpEvidence;
    },
  });
  const marker = nativeFixture?.marker ?? hosted.fixture.marker;
  report = {
    ...plan,
    runId,
    startedAt: new Date().toISOString(),
    status: runtimeBinding.status === "passed" ? "running" : "blocked",
    desktopHostStatus: runtimeBinding.status === "passed" ? "not-run" : "blocked",
    overallStatus: combineBStatuses(
      backend.report.backendStatus,
      runtimeBinding.status === "passed" ? "not-run" : "blocked",
    ),
    backend: {
      path: backend.path,
      status: backend.report.backendStatus,
      component: backendComponentId(plan.profile, plan.runtimeTarget),
    },
    runtimeBinding,
    upstreamAttributions,
    customModels,
    fixture: nativeFixture
      ? {
          kind: "windows-native",
          marker,
          executablePath: nativeFixture.executablePath,
          evidencePath: nativeFixture.evidencePath,
          manifestPath: nativeFixture.manifestPath,
        }
      : { kind: "loopback-http", url: hosted.url, marker },
    httpEvidence: hosted?.getEvidence() ?? null,
    nativeComputerUseEvidence: null,
  };
  report.prompt = desktopHostPrompt({
    profile: plan.profile,
    marker,
    fixtureUrl: hosted?.url,
    nativeExecutablePath: nativeFixture?.executablePath,
    runId,
    root: ROOT,
    triggerMode: plan.triggerMode,
  });
  report.reportPath = join(runDirectory, "report.json");
  report.progressPath = join(runDirectory, "progress.html");
  try {
    await persistDesktopReport(report);
    await updateBackendReport(backend.path, report);
    await writeReport(join(DESKTOP_RESULTS, `latest-${plan.profile}-${plan.runtimeTarget}.json`), {
      runId,
      reportPath: report.reportPath,
      progressPath: report.progressPath,
    });
  } catch (error) {
    await hosted?.close().catch(() => undefined);
    throw error;
  }
  if (!plan.noOpen) {
    try {
      await openProgressPage(report.progressPath);
    } catch (error) {
      report.status = "blocked";
      report.desktopHostStatus = "blocked";
      report.overallStatus = "blocked";
      report.error = `无法打开桌面验收报告页：${error.message}`;
      report.finishedAt = new Date().toISOString();
      try {
        await persistDesktopReport(report);
        await updateBackendReport(backend.path, report);
      } finally {
        await hosted?.close();
      }
      throw error;
    }
  }
  console.log(JSON.stringify({
    runId,
    batch: report.batch,
    component: report.component,
    reportPath: report.reportPath,
    progressPath: report.progressPath,
    fixture: report.fixture,
    status: report.status,
    prompt: report.prompt,
  }, null, 2));
  if (report.status === "blocked") {
    report.finishedAt = new Date().toISOString();
    try {
      await persistDesktopReport(report);
      await updateBackendReport(backend.path, report);
    } finally {
      await hosted?.close();
    }
    process.exitCode = 1;
    return;
  }

  let completed = false;
  let activeRefresh = null;
  let terminalOverride = null;
  let resolveFinished;
  const finished = new Promise((resolveFinishedPromise) => { resolveFinished = resolveFinishedPromise; });
  const refresh = () => {
    if (activeRefresh || completed) return activeRefresh;
    activeRefresh = (async () => {
      try {
        await refreshDesktopReport(report, { backend, rolloutPath: plan.rolloutPath });
        if (isDesktopSessionTerminal(report.status)) {
          completed = true;
          resolveFinished();
        }
      } catch (error) {
        report.status = "failed";
        report.desktopHostStatus = "failed";
        report.overallStatus = "failed";
        report.error = `桌面证据刷新失败：${error.message}`;
        completed = true;
        resolveFinished();
      } finally {
        activeRefresh = null;
      }
    })();
    return activeRefresh;
  };
  const interval = setInterval(() => void refresh(), 2_000);
  const timeout = setTimeout(() => {
    if (completed) return;
    terminalOverride = {
      status: "blocked",
      error: `桌面验收在 ${Math.round(plan.timeoutMs / 60_000)} 分钟内未完成`,
    };
    completed = true;
    resolveFinished();
  }, plan.timeoutMs);
  const stop = () => {
    if (completed) return;
    terminalOverride = { status: "incomplete", error: "桌面验收被中断，已保留当前证据" };
    completed = true;
    resolveFinished();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await finished;
  clearInterval(interval);
  clearTimeout(timeout);
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  if (activeRefresh) await activeRefresh;
  if (terminalOverride) Object.assign(report, terminalOverride);
  try {
    await refreshDesktopReport(report, { backend, rolloutPath: plan.rolloutPath, preserveTerminal: true });
    report.finishedAt = new Date().toISOString();
    await persistDesktopReport(report);
    await updateBackendReport(backend.path, report);
  } catch (error) {
    report.status = "failed";
    report.desktopHostStatus = "failed";
    report.overallStatus = "failed";
    report.error = [report.error, `桌面报告收尾失败：${error.message}`].filter(Boolean).join("；");
    report.finishedAt = new Date().toISOString();
    await persistDesktopReport(report).catch(() => undefined);
    await updateBackendReport(backend.path, report).catch(() => undefined);
  } finally {
    await hosted?.close();
  }
  console.log(`桌面入口报告：${report.reportPath}；${report.component}: ${report.status}；${report.batch}: ${report.overallStatus}`);
  if (report.status !== "passed") process.exitCode = 1;
}

async function readDesktopUpstreamAttributions(runtimeTarget) {
  const path = join(DESKTOP_RESULTS, `upstream-attributions-${runtimeTarget}.json`);
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error(`桌面上游归因文件不可读：${path}：${error.message}`);
  }
}

async function refreshDesktopReport(report, { backend, rolloutPath, preserveTerminal = false } = {}) {
  const snapshot = await sourceSnapshot();
  const sourceCurrent = snapshot.sha256 === report.sourceSnapshot.sha256;
  report.runtimeBinding = await inspectDesktopRuntime(report);
  const explicitWslPath = typeof rolloutPath === "string" && rolloutPath.startsWith("wsl:")
    ? rolloutPath.slice("wsl:".length)
    : null;
  let rollout = explicitWslPath ? null : await findDesktopRolloutEvidence({
      marker: report.fixture.marker,
      profile: report.profile,
      customModels: report.customModels ?? [],
      startedAt: Date.parse(report.startedAt),
      explicitPath: rolloutPath,
    });
  if (!rollout && process.platform === "win32" && report.runtimeTarget === WSL_NATIVE) {
    rollout = await findWslRolloutEvidence(
      report.fixture.marker,
      report.profile,
      report.customModels ?? [],
      explicitWslPath,
    );
  }
  const toolInventory = rollout ? await findRequestToolInventoryEvidence({
    threadId: rollout.threadId,
    model: rollout.model,
    startedAt: Date.parse(report.startedAt),
  }) : null;
  if (report.fixture.kind === "windows-native") {
    const native = await readWindowsComputerUseFixture(report.fixture);
    report.nativeComputerUseEvidence = native?.evidence ?? null;
  }
  report.rollout = rollout ? publicRolloutEvidence(rollout) : null;
  report.toolInventory = toolInventory;
  report.evaluation = evaluateDesktopHostEvidence({
    profile: report.profile,
    marker: report.fixture.marker,
    runtimeBinding: report.runtimeBinding,
    rollout,
    toolInventory,
    upstreamAttributions: report.upstreamAttributions,
    triggerMode: report.triggerMode,
    httpEvidence: report.httpEvidence,
    nativeComputerUseEvidence: report.nativeComputerUseEvidence,
    computerUseKind: report.fixture.kind,
    sourceCurrent,
  });
  const previous = report.status;
  report.status = report.evaluation.status;
  if (!sourceCurrent) report.status = "stale";
  if (preserveTerminal && ["blocked", "incomplete"].includes(previous) && report.status !== "passed") {
    report.status = previous;
  }
  report.desktopHostStatus = report.status === "stale" ? "failed" : report.status;
  report.overallStatus = combineBStatuses(backend.report.backendStatus, report.desktopHostStatus);
  report.updatedAt = new Date().toISOString();
  await persistDesktopReport(report);
  await updateBackendReport(backend.path, report);
}

async function requireBackendReport(plan, sourceSha256) {
  const path = join(RESULTS, `live-${plan.profile}-${plan.runtimeTarget}.json`);
  const report = JSON.parse(await readFile(path, "utf8").catch(() => {
    throw new Error(`缺少 ${plan.backendComponent} 报告；请先运行对应 B 批后台测试`);
  }));
  if (report.profileFilter !== plan.profile || report.runtimeTarget !== plan.runtimeTarget ||
    report.platform !== process.platform || report.arch !== process.arch ||
    report.snapshot?.sha256 !== sourceSha256 || report.backendStatus !== "passed") {
    throw new Error(`${plan.backendComponent} 未通过、已过期或不属于当前平台/运行环境`);
  }
  return { path, report };
}

async function inspectDesktopRuntime(plan) {
  return retryDesktopRuntimeInspection(() => inspectDesktopRuntimeOnce(plan));
}

export async function retryDesktopRuntimeInspection(inspect, {
  attempts = 6,
  intervalMs = 2_000,
  wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)),
} = {}) {
  let result = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    result = await inspect();
    if (result?.status === "passed") return result;
    if (attempt + 1 < attempts) await wait(intervalMs);
  }
  return result;
}

export function desktopRuntimeInfrastructureReady(readiness = {}) {
  return readiness.codexRunning === true &&
    readiness.debugReady === true &&
    readiness.singleInjector === true &&
    readiness.relayReady === true &&
    readiness.protocolMatches === true;
}

async function inspectDesktopRuntimeOnce(plan) {
  const expected = {
    projectVersion: plan.projectVersion,
    relayProtocol: plan.expectedRelayProtocol,
    widgetRuntime: plan.expectedWidgetRuntime,
    runtimeTarget: plan.runtimeTarget,
  };
  try {
    const host = await inspectLifecycleHost({ expectedProtocol: plan.expectedRelayProtocol });
    const widget = await inspectWidget();
    const runtimeMatches = plan.runtimeTarget === "macos-native" ||
      (plan.runtimeTarget === WSL_NATIVE ? host.relay.wslNative : !host.relay.wslNative);
    const versionPattern = new RegExp(`(?:^|\\s)v${escapeRegex(plan.projectVersion)}(?:\\.dev)?(?:$|\\s)`);
    const versionMatches = versionPattern.test(widget.footerText ?? "");
    const passed = desktopRuntimeInfrastructureReady(host.readiness) && runtimeMatches &&
      widget.runtimeVersion === plan.expectedWidgetRuntime && versionMatches;
    return {
      status: passed ? "passed" : "failed",
      expected,
      actual: {
        host: publicLifecycleHost(host),
        widget,
        runtimeMatches,
        versionMatches,
      },
    };
  } catch (error) {
    return { status: "failed", expected, error: error.message };
  }
}

async function inspectWidget() {
  const target = await findCodexTarget(9_229).catch(() => null);
  if (!target) return { runtimeVersion: null, footerText: null };
  const client = new CdpClient(target.webSocketDebuggerUrl);
  try {
    await client.connect();
    return await client.evaluate(`(${readDesktopWidgetState.toString()})(window)`);
  } finally {
    client.close();
  }
}

export function readDesktopWidgetState(scope) {
  const root = scope.document.getElementById("codex-quota-injector-root");
  return {
    runtimeVersion: scope.__codexQuotaWidget?.version ?? null,
    footerText: root?.shadowRoot?.querySelector(".panel-version-text")?.textContent?.trim() ?? null,
  };
}

async function updateBackendReport(path, desktopReport) {
  const backend = JSON.parse(await readFile(path, "utf8"));
  if (backend.snapshot?.sha256 !== desktopReport.sourceSnapshot.sha256 ||
    backend.profileFilter !== desktopReport.profile || backend.runtimeTarget !== desktopReport.runtimeTarget) return;
  backend.desktopHostStatus = desktopReport.desktopHostStatus;
  backend.desktopHostReport = desktopReport.reportPath;
  backend.overallStatus = combineBStatuses(backend.backendStatus, backend.desktopHostStatus);
  backend.status = backend.overallStatus;
  const desktop = backend.components?.find((component) => component.kind === "desktop-entry");
  if (desktop) {
    desktop.status = backend.desktopHostStatus;
    desktop.reportPath = desktopReport.reportPath;
  }
  await writeReport(path, backend);
}

async function persistDesktopReport(report) {
  await writeReport(report.reportPath, report);
  await writeFile(report.progressPath, desktopHostProgressHtml(report));
}

async function printDesktopStatus(runId, rolloutPath) {
  if (!/^[0-9]{14}-[a-f0-9]{8}$/.test(runId)) throw new Error("桌面验收 run ID 无效");
  const reportPath = join(DESKTOP_RESULTS, runId, "report.json");
  const report = JSON.parse(await readFile(reportPath, "utf8").catch(() => {
    throw new Error(`找不到桌面验收报告 ${runId}`);
  }));
  const backend = await requireBackendReport(report, report.sourceSnapshot.sha256);
  await refreshDesktopReport(report, { backend, rolloutPath, preserveTerminal: true });
  console.log(JSON.stringify({
    runId,
    batch: report.batch,
    component: report.component,
    status: report.status,
    overallStatus: report.overallStatus,
    model: report.rollout?.model ?? null,
    threadId: report.rollout?.threadId ?? null,
    checks: report.evaluation?.checks ?? [],
    reportPath,
    progressPath: report.progressPath,
  }, null, 2));
}

async function findWslRolloutEvidence(marker, profile, customModels, explicitPath = null) {
  if (!/^BHOST_[a-f0-9]{16}$/.test(marker)) return null;
  let paths = explicitPath ? [explicitPath] : null;
  if (!paths) {
    const command = `find "$HOME/.codex/sessions" "$HOME/.codex/archived_sessions" -type f -name 'rollout-*.jsonl' -mmin -180 -exec grep -lF -- '${marker}' {} + 2>/dev/null | head -20`;
    const { stdout } = await execFileAsync("wsl.exe", ["-e", "sh", "-lc", command], {
      windowsHide: true,
      maxBuffer: 256 * 1024,
    }).catch(() => ({ stdout: "" }));
    paths = String(stdout).split(/\r?\n/).filter(Boolean);
  }
  const evidence = [];
  for (const path of paths) {
    const result = await execFileAsync("wsl.exe", ["-e", "cat", "--", path], {
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    }).catch(() => null);
    if (!result?.stdout) continue;
    const parsed = parseDesktopRollout(result.stdout, {
      marker,
      profile,
      customModels,
      path: `wsl:${path}`,
    });
    if (parsed && (explicitPath || parsed.modelMatches)) evidence.push(parsed);
  }
  return evidence.sort((left, right) =>
    Number(right.modelMatches) - Number(left.modelMatches) ||
    Object.values(right.checks).filter(Boolean).length - Object.values(left.checks).filter(Boolean).length)[0] ?? null;
}

function publicRolloutEvidence(rollout) {
  return {
    path: rollout.path,
    threadId: rollout.threadId,
    turnId: rollout.turnId,
    model: rollout.model,
    modelProvider: rollout.modelProvider,
    cliVersion: rollout.cliVersion,
    cwd: rollout.cwd,
    modelMatches: rollout.modelMatches,
    computerUseFailure: rollout.computerUseFailure,
    callIds: rollout.callIds,
    checks: rollout.checks,
    turnCompleted: rollout.turnCompleted,
    taskError: rollout.taskError,
  };
}

export async function selectedRuntime(requested, {
  platform = process.platform,
  allowUnsupportedCurrent = false,
  currentTarget,
} = {}) {
  const value = requested ?? "current";
  const available = runtimeTargetsForPlatform(platform);
  if (!available.length && allowUnsupportedCurrent && value === "current") return "unsupported";
  const current = available.length
    ? currentTarget ?? await currentRuntimeTarget({ platform })
    : null;
  return resolveRuntimeSelection(value, {
    platform,
    currentTarget: current,
    allowAll: false,
  })[0];
}

function parseArguments(argumentsList) {
  const options = {
    profile: null,
    runtime: "current",
    plan: false,
    confirmTokenUse: false,
    statusRunId: null,
    rolloutPath: null,
    noOpen: false,
    fixtureOnly: false,
    triggerMode: "direct",
    timeoutMs: Number(process.env.CODEX_TEST_DESKTOP_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
  };
  for (const argument of argumentsList) {
    if (argument === "--plan") options.plan = true;
    else if (argument === "--confirm-token-use") options.confirmTokenUse = true;
    else if (argument === "--serve") options.fixtureOnly = true;
    else if (argument === "--no-open") options.noOpen = true;
    else if (argument.startsWith("--profile=")) options.profile = valueAfter(argument, "--profile");
    else if (argument.startsWith("--runtime=")) options.runtime = valueAfter(argument, "--runtime");
    else if (argument.startsWith("--trigger-mode=")) options.triggerMode = valueAfter(argument, "--trigger-mode");
    else if (argument.startsWith("--status=")) options.statusRunId = valueAfter(argument, "--status");
    else if (argument.startsWith("--rollout=")) {
      const path = valueAfter(argument, "--rollout");
      options.rolloutPath = path.startsWith("wsl:") ? path : resolve(path);
    }
    else throw new Error(`未知参数 ${argument}`);
  }
  if (options.profile && !["official", "deepseek"].includes(options.profile)) {
    throw new Error("--profile 只能是 official 或 deepseek");
  }
  if (!["direct", "delegated"].includes(options.triggerMode)) {
    throw new Error("--trigger-mode 只能是 direct 或 delegated");
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("CODEX_TEST_DESKTOP_TIMEOUT_MS 必须是正整数");
  }
  if (options.fixtureOnly && (options.profile || options.plan || options.confirmTokenUse || options.statusRunId)) {
    throw new Error("--serve 只保留为免费材料服务，不能与 B 桌面验收参数组合");
  }
  return options;
}

function valueAfter(argument, name) {
  const value = argument.slice(`${name}=`.length).trim();
  if (!value) throw new Error(`${name} 必须指定值`);
  return value;
}

async function openProgressPage(path) {
  if (process.platform === "darwin") {
    await execFileAsync("/usr/bin/open", ["-a", "Safari", path]);
    return;
  }
  if (process.platform === "win32") {
    const escaped = path.replaceAll("'", "''");
    await execFileAsync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
      `Start-Process -FilePath '${escaped}'`,
    ], { windowsHide: true });
    return;
  }
  throw new Error(`当前平台 ${process.platform}/${process.arch} 无法打开桌面验收报告页`);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
