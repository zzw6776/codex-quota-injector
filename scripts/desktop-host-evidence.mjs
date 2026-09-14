import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { findOfficialAppServerUrl } from "../live-tests/web-search-contract.mjs";
import { defaultAccountDataDir } from "../src/platform.mjs";

export const DESKTOP_HOST_REPORT_VERSION = 7;

export function desktopBatch(profile) {
  if (profile === "official") return "B1-official";
  if (profile === "deepseek") return "B2-deepseek";
  throw new Error(`桌面验收不支持供应商 ${profile}`);
}

export function backendComponentId(profile, runtimeTarget) {
  return `${desktopBatch(profile)}-backend/${runtimeTarget}`;
}

export function desktopComponentId(profile, runtimeTarget) {
  return `${desktopBatch(profile)}-desktop/${runtimeTarget}`;
}

export function combineBStatuses(backendStatus, desktopStatus) {
  const values = [backendStatus, desktopStatus];
  if (values.includes("failed")) return "failed";
  if (values.includes("blocked")) return "blocked";
  return values.every((status) => status === "passed") ? "passed" : "incomplete";
}

export function isDesktopSessionTerminal(status) {
  return ["passed", "failed", "stale", "blocked"].includes(status);
}

export function parseDesktopRollout(content, {
  marker,
  profile,
  customModels = [],
  path = null,
} = {}) {
  const records = String(content ?? "").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  let session = {};
  let currentModel = null;
  let startIndex = -1;
  let model = null;
  let turnId = null;
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.type === "session_meta") {
      session = {
        threadId: record.payload?.id ?? record.payload?.session_id ?? null,
        modelProvider: record.payload?.model_provider ?? null,
        cliVersion: record.payload?.cli_version ?? null,
        cwd: record.payload?.cwd ?? null,
      };
    }
    if (record.type === "turn_context") {
      currentModel = record.payload?.model ?? currentModel;
      turnId = record.payload?.turn_id ?? turnId;
    }
    if (startIndex < 0 && JSON.stringify(record).includes(marker)) {
      startIndex = index;
      model = currentModel;
    }
  }
  if (startIndex < 0) return null;

  const calls = [];
  const outputs = new Map();
  currentModel = model;
  for (const [offset, record] of records.slice(startIndex).entries()) {
    const recordIndex = startIndex + offset;
    if (record.type === "turn_context") {
      currentModel = record.payload?.model ?? currentModel;
      turnId = record.payload?.turn_id ?? turnId;
    }
    const payload = record.payload ?? {};
    if (record.type === "response_item" && ["function_call", "custom_tool_call"].includes(payload.type)) {
      calls.push({
        id: payload.call_id ?? payload.id ?? null,
        name: payload.namespace
          ? `${String(payload.namespace)}__${String(payload.name ?? "")}`
          : String(payload.name ?? ""),
        input: stringifyPayload(payload.input ?? payload.arguments ?? ""),
        recordIndex,
      });
    }
    if (record.type === "response_item" && ["function_call_output", "custom_tool_call_output"].includes(payload.type)) {
      outputs.set(payload.call_id ?? payload.id ?? "", {
        text: stringifyPayload(payload.output ?? payload.result ?? ""),
        recordIndex,
      });
    }
  }

  const execMarker = `EXEC_${marker}`;
  const failureMarker = `FAIL_${marker}`;
  const execCall = calls.find((call) => isExecCall(call) && call.input.includes(execMarker));
  const failureAttempts = calls.filter((call) =>
    isExecCall(call) && call.input.includes(failureMarker));
  const failureCall = failureAttempts.find((call) => {
    const output = outputs.get(call.id)?.text ?? "";
    return output.includes(failureMarker) && hasExitCode(output, 23);
  }) ?? failureAttempts[0];
  const execOutput = execCall ? outputs.get(execCall.id)?.text ?? "" : "";
  const failureOutputRecord = failureCall ? outputs.get(failureCall.id) : null;
  const failureOutput = failureOutputRecord?.text ?? "";
  const continuedAfterFailure = Boolean(failureOutputRecord && calls.some((call) =>
    call.recordIndex > failureOutputRecord.recordIndex &&
    (isCodexAppCall(call) || isWebCall(call) || isComputerUseCall(call))));
  const currentThreadId = session.threadId ?? threadIdFromPath(path);
  const codexAppListCall = calls.find(isCodexAppListThreadsCall);
  const codexAppListOutput = codexAppListCall ? outputs.get(codexAppListCall.id) : null;
  const codexAppReadAttempts = calls.filter((call) => isCodexAppReadThreadCall(call) &&
    (!codexAppListOutput || call.recordIndex > codexAppListOutput.recordIndex));
  const matchingCodexAppReadCall = codexAppReadAttempts.find((call) =>
    currentThreadId && call.input.includes(currentThreadId));
  const codexAppReadCall = matchingCodexAppReadCall ?? codexAppReadAttempts[0];
  const codexAppReadOutput = codexAppReadCall ? outputs.get(codexAppReadCall.id)?.text ?? "" : "";
  const codexAppReadEvidence = inspectCodexAppReadOutput(codexAppReadOutput, {
    marker,
    threadId: currentThreadId,
  });
  const codexAppListSucceeded = Boolean(codexAppListCall && codexAppListOutput &&
    isSuccessfulCodexAppOutput(codexAppListOutput.text));
  const codexAppReadSucceeded = Boolean(matchingCodexAppReadCall && currentThreadId &&
    isSuccessfulCodexAppOutput(codexAppReadOutput) && codexAppReadEvidence.threadMatched);
  const codexAppListProjectsCall = calls.find(isCodexAppListProjectsCall);
  const codexAppListProjectsOutput = codexAppListProjectsCall
    ? outputs.get(codexAppListProjectsCall.id)?.text ?? ""
    : "";
  const codexAppGetUsageLimitsCall = calls.find(isCodexAppGetUsageLimitsCall);
  const codexAppGetUsageLimitsOutput = codexAppGetUsageLimitsCall
    ? outputs.get(codexAppGetUsageLimitsCall.id)?.text ?? ""
    : "";
  const webCalls = calls.filter(isWebCall);
  const webSearchCall = webCalls.find((call) => hasWebOperation(call.input, "search_query"));
  const webOpenCall = webCalls.find((call) => hasWebOperation(call.input, "open") &&
    (!webSearchCall || call.recordIndex > webSearchCall.recordIndex));
  const webFindCall = webCalls.find((call) => hasWebOperation(call.input, "find") &&
    (!webOpenCall || call.recordIndex > webOpenCall.recordIndex));
  const webResultOutputs = [webOpenCall, webFindCall]
    .map((call) => call ? outputs.get(call.id)?.text ?? "" : "").join("\n");
  const computerCalls = calls.filter(isComputerUseCall);
  const successfulComputerCalls = computerCalls.filter((call) =>
    isSuccessfulComputerUseOutput(outputs.get(call.id)?.text));
  const computerInputCalls = computerCalls.filter(isComputerInputCall);
  const computerSubmitCalls = computerCalls.filter(isComputerSubmitCall);
  const computerScreenshotCalls = computerCalls.filter(isComputerScreenshotCall);
  const computerUseFailure = computerCalls
    .map((call) => classifyComputerUseFailure(outputs.get(call.id)?.text))
    .find(Boolean) ?? null;
  const modelMatches = matchesProfileModel(profile, currentModel, customModels);
  const taskComplete = records.slice(startIndex).findLast((record) =>
    record.type === "event_msg" && record.payload?.type === "task_complete");
  const turnCompleted = Boolean(taskComplete);
  const taskError = normalizeTaskError(taskComplete?.payload?.error);

  return {
    path,
    threadId: session.threadId ?? threadIdFromPath(path),
    turnId,
    model: currentModel,
    modelProvider: session.modelProvider,
    cliVersion: session.cliVersion,
    cwd: session.cwd,
    markerFound: true,
    modelMatches,
    computerUseFailure,
    turnCompleted,
    taskError,
    callIds: {
      functionsExecSuccess: execCall?.id ?? null,
      functionsExecFailure: failureCall?.id ?? null,
      codexAppListThreads: codexAppListCall?.id ?? null,
      codexAppReadThread: codexAppReadCall?.id ?? null,
      codexAppListProjects: codexAppListProjectsCall?.id ?? null,
      codexAppGetUsageLimits: codexAppGetUsageLimitsCall?.id ?? null,
      webRun: webCalls.map((call) => call.id).filter(Boolean),
      computerUse: computerCalls.map((call) => call.id).filter(Boolean),
      computerInput: computerInputCalls.map((call) => call.id).filter(Boolean),
      computerSubmit: computerSubmitCalls.map((call) => call.id).filter(Boolean),
      computerScreenshot: computerScreenshotCalls.map((call) => call.id).filter(Boolean),
    },
    checks: {
      functionsExec: Boolean(execCall && execOutput.includes(execMarker)),
      functionsExecFailure: Boolean(failureCall && failureOutput.includes(failureMarker) &&
        hasExitCode(failureOutput, 23) && continuedAfterFailure),
      codexAppListThreads: codexAppListSucceeded,
      codexAppReadThread: codexAppListSucceeded && codexAppReadSucceeded,
      codexAppReadContent: codexAppReadEvidence.hasMessageItems,
      codexAppReadMarker: codexAppReadEvidence.markerInMessageItems,
      codexAppListProjects: Boolean(codexAppListProjectsCall &&
        isSuccessfulCodexAppOutput(codexAppListProjectsOutput)),
      codexAppGetUsageLimits: Boolean(codexAppGetUsageLimitsCall &&
        isSuccessfulCodexAppOutput(codexAppGetUsageLimitsOutput)),
      webSearch: Boolean(webSearchCall),
      webOpen: Boolean(webSearchCall && webOpenCall),
      webFind: Boolean(webOpenCall && webFindCall),
      webResult: hasOfficialCodexSource(webResultOutputs) && /thread\/fork/i.test(webResultOutputs),
      computerUse: successfulComputerCalls.length > 0,
      computerInput: computerInputCalls.some((call) => successfulComputerCalls.includes(call)),
      computerSubmit: computerSubmitCalls.some((call) => successfulComputerCalls.includes(call)),
      computerScreenshot: computerScreenshotCalls.some((call) => successfulComputerCalls.includes(call)),
    },
  };
}

export function evaluateDesktopHostEvidence({
  profile,
  marker,
  runtimeBinding,
  rollout,
  toolInventory = null,
  upstreamAttributions = {},
  triggerMode = "direct",
  httpEvidence = {},
  nativeComputerUseEvidence = null,
  computerUseKind = "loopback-http",
  sourceCurrent = true,
} = {}) {
  const normalizedHttpEvidence = httpEvidence ?? {};
  const submissions = Array.isArray(normalizedHttpEvidence.submissions)
    ? normalizedHttpEvidence.submissions
    : [];
  const invalidSubmissions = Number(normalizedHttpEvidence.invalidSubmissions ?? 0);
  const nativeSubmissions = Array.isArray(nativeComputerUseEvidence?.submissions)
    ? nativeComputerUseEvidence.submissions
    : [];
  const nativeComputerUsePassed = nativeComputerUseEvidence?.schemaVersion === 1 &&
    nativeComputerUseEvidence?.launchCount === 1 &&
    nativeSubmissions.length === 1 && nativeSubmissions[0]?.value === marker;
  const computerUsePassed = computerUseKind === "windows-native"
    ? nativeComputerUsePassed
    : invalidSubmissions === 0 && submissions.length === 1 && submissions[0]?.value === marker;
  const wslComputerUseBlockedUpstream = runtimeBinding?.expected?.runtimeTarget === "wsl-native" &&
    rollout?.computerUseFailure === "sandbox-cwd-not-local-file-uri";
  const computerScreenshotUpstream = verifiedComputerScreenshotUpstreamAttribution(
    upstreamAttributions?.["computer-screenshot"],
    {
      runtimeTarget: runtimeBinding?.expected?.runtimeTarget,
      failure: rollout?.computerUseFailure,
    },
  );
  const readThreadPassed = rollout?.checks?.codexAppReadThread === true &&
    rollout?.checks?.codexAppReadContent === true;
  const readThreadUpstream = verifiedReadThreadUpstreamAttribution(
    upstreamAttributions?.["codex-app-read-thread"],
  );
  const standaloneWebRun = toolInventory?.offers?.webRun;
  const hostedWebSearch = toolInventory?.offers?.hostedWebSearch;
  const webOffered = profile === "deepseek"
    ? standaloneWebRun
    : standaloneWebRun === true || hostedWebSearch === true
      ? true
      : standaloneWebRun === false && hostedWebSearch === false
        ? false
        : null;
  const webUnavailableStatus = profile === "deepseek" ? "unsupported" : "failed";
  const checks = [
    check("source", "源码摘要保持一致", sourceCurrent),
    check("runtime", "桌面版本、中继协议与运行环境", runtimeBinding?.status === "passed"),
    check("model", profile === "deepseek" ? "任务实际使用 DeepSeek" : "任务实际使用 Codex 官方模型",
      rollout?.modelMatches === true),
    check("model-turn", "目标模型任务正常结束",
      rollout?.turnCompleted === true && !rollout?.taskError),
    check("functions-exec", "functions.exec 成功命令与真实输出", rollout?.checks?.functionsExec === true),
    check("functions-exec-failure", "functions.exec 失败退出码及任务续接",
      rollout?.checks?.functionsExecFailure === true),
    check("codex-app-list-threads", "codex_app list_threads 返回当前任务",
      rollout?.checks?.codexAppListThreads === true),
    capabilityCheck("codex-app-read-thread", "codex_app read_thread 读取当前任务且完成回合内容完整",
      readThreadPassed, readThreadUpstream ? "blocked-upstream" : null),
    check("codex-app-list-projects", "codex_app list_projects 返回项目目录",
      rollout?.checks?.codexAppListProjects === true),
    check("codex-app-get-usage-limits", "codex_app get_usage_limits 返回账号用量",
      rollout?.checks?.codexAppGetUsageLimits === true),
    capabilityCheck("web-search", "web.run search", rollout?.checks?.webSearch === true,
      webOffered === false ? webUnavailableStatus : null),
    capabilityCheck("web-open", "web.run open", rollout?.checks?.webOpen === true,
      webOffered === false ? webUnavailableStatus : null),
    capabilityCheck("web-find", "web.run find 及官方正文",
      rollout?.checks?.webFind === true && rollout?.checks?.webResult === true,
      webOffered === false ? webUnavailableStatus : null),
    capabilityCheck("computer-use", "computer use 打开、输入并单次提交",
      rollout?.checks?.computerUse === true && rollout?.checks?.computerInput === true &&
      rollout?.checks?.computerSubmit === true && computerUsePassed,
      wslComputerUseBlockedUpstream ? "blocked-upstream" : null),
    capabilityCheck("computer-screenshot", "computer use 截图",
      rollout?.checks?.computerScreenshot === true,
      wslComputerUseBlockedUpstream || computerScreenshotUpstream
        ? "blocked-upstream"
        : null),
    ...(computerUseKind === "windows-native" ? [] : [
      check("download", "浏览器下载测试产物",
        Number(normalizedHttpEvidence.artifactRequests ?? 0) >= 1),
    ]),
  ];
  let status = checks.every((item) => item.status === "passed") ? "passed" : "incomplete";
  const invalidComputerUse = computerUseKind === "windows-native"
    ? Number(nativeComputerUseEvidence?.launchCount ?? 0) > 1 || nativeSubmissions.length > 1 ||
      nativeSubmissions.some((submission) => submission?.value !== marker)
    : invalidSubmissions > 0 || submissions.length > 1;
  const hardFailure = !sourceCurrent || runtimeBinding?.status === "failed" || invalidComputerUse ||
    (rollout && (rollout.modelMatches === false || rollout.taskError));
  if (hardFailure) status = "failed";
  const completed = rollout?.modelMatches === true && rollout.turnCompleted;
  if (!hardFailure && completed) {
    for (const item of checks) {
      if (item.status !== "not-run") continue;
      item.status = checkWasAttempted(item.id, rollout) ? "failed" : "not-executed";
    }
    if (checks.some((item) => item.status === "failed")) status = "failed";
    else if (checks.some((item) => ["blocked-upstream", "unsupported", "not-executed"].includes(item.status))) {
      status = "blocked";
    }
    else status = "passed";
  }
  const unavailable = checks.filter((item) =>
    ["blocked-upstream", "unsupported", "not-executed"].includes(item.status));
  return {
    status,
    checks,
    upstreamReason: [
      readThreadUpstream?.reason,
      wslComputerUseBlockedUpstream
        ? "WSL 官方 Computer Use 在执行 JavaScript 前拒绝非本地 Windows file URI：sandboxCwd is not a local file URI"
        : null,
      computerScreenshotUpstream?.reason,
    ].filter(Boolean).join("；") || null,
    blockedReason: status === "blocked"
      ? `目标模型任务已结束，能力不可用或未执行：${unavailable.map((item) => `${item.label}(${item.status})`).join("、")}`
      : null,
  };
}

function verifiedComputerScreenshotUpstreamAttribution(attribution, {
  runtimeTarget,
  failure,
} = {}) {
  const control = attribution?.controls?.officialNoRelay;
  const relayControl = attribution?.controls?.productionRelay;
  if (runtimeTarget !== "windows-native" || failure !== "windows-capture-interface-unsupported" ||
    attribution?.status !== "blocked-upstream" ||
    attribution?.layer !== "official-windows-computer-use-screenshot" ||
    typeof attribution?.reason !== "string" || !attribution.reason.trim() ||
    control?.relayRemoved !== true || control?.runtimeTarget !== "windows-native" ||
    control?.failure !== failure || relayControl?.runtimeTarget !== "windows-native" ||
    relayControl?.failure !== failure) return null;
  return attribution;
}

function verifiedReadThreadUpstreamAttribution(attribution) {
  if (attribution?.status !== "blocked-upstream" ||
    attribution?.layer !== "official-codex-desktop-read-thread-wrapper" ||
    typeof attribution?.reason !== "string" || !attribution.reason.trim()) return null;
  const official = attribution?.controls?.officialNoRelay?.completedItemCounts;
  const relay = attribution?.controls?.productionRelay?.completedItemCounts;
  const desktop = attribution?.controls?.desktopReadThread?.completedItemCounts;
  if (![official, relay, desktop].every((counts) => Array.isArray(counts) && counts.length > 0) ||
    JSON.stringify(official) !== JSON.stringify(relay) ||
    official.some((count) => !Number.isInteger(count) || count <= 0) ||
    desktop.length !== official.length || desktop.some((count) => count !== 0)) return null;
  return attribution;
}

export function parseRequestToolInventory(content, {
  threadId,
  model = null,
  startedAt = 0,
} = {}) {
  if (!threadId) return null;
  const threshold = Math.max(0, Number(startedAt) - 5 * 60_000);
  const events = String(content ?? "").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  }).filter((event) => event.type === "request-tool-inventory" &&
    event.threadId === threadId && (!model || event.model === model) &&
    Number(event.recordedAt ?? 0) >= threshold);
  if (!events.length) return null;
  const tools = new Map();
  for (const event of events) {
    for (const tool of Array.isArray(event.tools) ? event.tools : []) {
      const item = {
        type: nonEmptyString(tool?.type),
        name: nonEmptyString(tool?.name),
        namespace: nonEmptyString(tool?.namespace),
        serverLabel: nonEmptyString(tool?.serverLabel),
      };
      const key = JSON.stringify(item);
      if (Object.values(item).some(Boolean) && !tools.has(key)) tools.set(key, item);
    }
  }
  const inventory = [...tools.values()];
  return {
    source: "model-request",
    eventCount: events.length,
    firstObservedAt: Math.min(...events.map((event) => Number(event.recordedAt ?? 0))),
    lastObservedAt: Math.max(...events.map((event) => Number(event.recordedAt ?? 0))),
    tools: inventory,
    offers: {
      webRun: inventory.some(isStandaloneWebRunTool),
      hostedWebSearch: inventory.some(isHostedWebSearchTool),
    },
  };
}

export async function findRequestToolInventoryEvidence({
  threadId,
  model = null,
  startedAt = 0,
  eventPath = join(defaultAccountDataDir(), "token-usage-events.jsonl"),
} = {}) {
  const content = await readFile(eventPath, "utf8").catch(() => null);
  return content ? parseRequestToolInventory(content, { threadId, model, startedAt }) : null;
}

export async function findDesktopRolloutEvidence({
  marker,
  profile,
  customModels = [],
  startedAt = 0,
  codexHome = resolveCodexHome(),
  explicitPath = null,
} = {}) {
  const candidates = explicitPath
    ? [explicitPath]
    : await collectRecentRollouts(codexHome, startedAt);
  const parsed = [];
  for (const path of candidates) {
    const content = await readFile(path, "utf8").catch(() => null);
    if (!content?.includes(marker)) continue;
    const evidence = parseDesktopRollout(content, { marker, profile, customModels, path });
    if (evidence && (explicitPath || evidence.modelMatches)) parsed.push(evidence);
  }
  return parsed.sort((left, right) => evidenceScore(right) - evidenceScore(left))[0] ?? null;
}

export function desktopHostPrompt({
  profile,
  marker,
  fixtureUrl,
  nativeExecutablePath,
  runId,
  root,
  triggerMode = "direct",
}) {
  const label = profile === "deepseek" ? "DeepSeek" : "Codex 官方模型";
  const execMarker = `EXEC_${marker}`;
  const failureMarker = `FAIL_${marker}`;
  return [
    `这是 ${label} 的真实桌面入口验收，验收编号 ${runId}，标记 ${marker}。`,
    `必须在当前这个桌面任务中完成，不创建另一个模型任务。`,
    `1. 用 functions.exec 在项目 ${root} 执行 node -e "process.stdout.write('${execMarker}')"，并读取真实输出和退出码 0。`,
    nativeExecutablePath
      ? `2. 再用 functions.exec 在同一段 PowerShell 脚本中执行 node -e "process.stderr.write('${failureMarker}');process.exit(23)"，下一行紧接 exit $LASTEXITCODE；确认随机标记和退出码 23 返回当前任务，然后继续后续步骤。`
      : `2. 再用 functions.exec 执行 node -e "process.stderr.write('${failureMarker}');process.exit(23)"；确认随机标记和退出码 23 返回当前任务，然后继续后续步骤。`,
    `3. 调用四个常用只读 codex_app 入口：先调用 list_threads 并确认正常返回；若发起者在本提示后附带当前任务 ID，必须用该 ID，否则从返回结果识别当前任务。再调用 read_thread 并确认返回的是当前任务；返回页中每个 completed 回合都必须同时含真实 userMessage 和 agentMessage，当前 inProgress 回合可以为空。本轮标记由 rollout 独立绑定，不要求 read_thread 重复返回尚未完成的当前输入。随后分别调用 list_projects 和 get_usage_limits 并确认正常返回。不能读取本地 rollout 代替。`,
    "4. 用实际 web.run 搜索 OpenAI 官方 Codex app-server 文档，open 命中页面，再 find `thread/fork`；不能用 shell 或普通 fetch 代替。",
    nativeExecutablePath
      ? `5. 用实际 computer use 启动 Windows 原生应用 ${nativeExecutablePath}。用本轮可执行文件路径和标题中可见的 ${marker} 前缀唯一定位窗口；Windows 可能截断标题，必须从辅助功能树读取并核对完整标记后才能输入。聚焦 Marker input，原样输入并只提交一次，同时对该窗口调用一次真实截图。正确提交后应用会自动关闭。不能使用浏览器、HTTP 页面、shell 输入或辅助驱动代替。`
      : `5. 用实际 computer use 打开 ${fixtureUrl}，读取页面标记，原样输入并只提交一次；随后截图并点击下载测试产物。`,
    `6. 正常结束任务。运行中的监视器会自动更新验收编号 ${runId} 的报告，不要编辑报告文件。`,
    "不要在回复中伪造通过；报告只采信 rollout、运行时状态和材料服务记录。",
  ].join("\n");
}

export function desktopHostProgressHtml(report) {
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
  const checks = (report.evaluation?.checks ?? []).map((item) =>
    `<tr><td>${escape(item.label)}</td><td class="${escape(item.status)}">${escape(item.status)}</td></tr>`).join("");
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="refresh" content="2">
  <title>${escape(report.batch)} 桌面入口验收</title><style>
  body{font:15px system-ui;max-width:980px;margin:34px auto;padding:0 22px;color:#202124;background:#f6f7fb}
  main{background:#fff;border:1px solid #ddd;border-radius:16px;padding:24px;box-shadow:0 8px 30px #0001}
  h1{margin-top:0}code,pre{background:#f0f2f7;border-radius:8px;padding:10px;white-space:pre-wrap;overflow-wrap:anywhere}
  table{width:100%;border-collapse:collapse}td{padding:9px;border-bottom:1px solid #eee}.passed{color:#17833d}.failed,.blocked,.stale{color:#c62828}.blocked-upstream,.unsupported,.not-executed,.not-run,.incomplete,.running{color:#9a6500}
  .meta{color:#666}.status{font-size:20px;font-weight:700}.footer{margin-top:18px;color:#777}</style><main>
  <h1>${escape(report.batch)} 桌面入口验收</h1><p class="status ${escape(report.status)}">${escape(report.status)}</p>
  <p class="meta">${escape(report.platform)}/${escape(report.arch)} · ${escape(report.runtimeTarget)} · v${escape(report.projectVersion)} · ${escape(report.sourceSnapshot?.sha256)}</p>
  <p class="meta">后台组件：${escape(report.backend?.status ?? "待核对")} · 最后刷新：${escape(report.updatedAt ?? report.startedAt ?? "尚未开始")}</p>
  <table>${checks || '<tr><td>等待初始化</td><td class="not-run">not-run</td></tr>'}</table>
  <h2>在目标模型任务中执行</h2><pre>${escape(report.prompt)}</pre>
  <p class="footer">本页每 2 秒重新加载，只展示脱敏报告；测试判定来自任务 rollout、Codex 运行时和本机材料服务。</p>
  </main></html>`;
}

function check(id, label, passed) {
  return { id, label, status: passed ? "passed" : "not-run" };
}

function capabilityCheck(id, label, passed, unavailableStatus) {
  return { id, label, status: passed ? "passed" : unavailableStatus ?? "not-run" };
}

function checkWasAttempted(id, rollout) {
  const callIds = rollout?.callIds ?? {};
  if (id === "functions-exec") return Boolean(callIds.functionsExecSuccess);
  if (id === "model-turn") return Boolean(rollout?.turnCompleted);
  if (id === "functions-exec-failure") return Boolean(callIds.functionsExecFailure);
  if (id === "codex-app-list-threads") return Boolean(callIds.codexAppListThreads);
  if (id === "codex-app-read-thread") return Boolean(callIds.codexAppReadThread);
  if (id === "codex-app-list-projects") return Boolean(callIds.codexAppListProjects);
  if (id === "codex-app-get-usage-limits") return Boolean(callIds.codexAppGetUsageLimits);
  if (["web-search", "web-open", "web-find"].includes(id)) return (callIds.webRun?.length ?? 0) > 0;
  if (["computer-use", "computer-screenshot", "download"].includes(id)) {
    if (id === "computer-screenshot") return (callIds.computerScreenshot?.length ?? 0) > 0;
    return (callIds.computerUse?.length ?? 0) > 0;
  }
  return false;
}

function isStandaloneWebRunTool(tool) {
  const value = [tool?.type, tool?.name, tool?.namespace, tool?.serverLabel]
    .filter(Boolean).join("__");
  return /web(?:__|\.)?run/i.test(value) ||
    tool?.type === "namespace" && tool?.name === "web";
}

function isHostedWebSearchTool(tool) {
  return /^web_search(?:_\d{4}_\d{2}_\d{2})?$/.test(String(tool?.type ?? ""));
}

function nonEmptyString(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function normalizeTaskError(value) {
  if (!value || typeof value !== "object") return null;
  const code = nonEmptyString(value.codex_error_info ?? value.code);
  const message = nonEmptyString(value.message);
  return code || message ? { code, message } : null;
}

function matchesProfileModel(profile, model, customModels) {
  const actual = String(model ?? "").trim();
  if (!actual) return false;
  if (profile === "deepseek") return actual === "deepseek-v4-flash";
  if (profile !== "official") return false;
  return !new Set(["deepseek-v4-flash", ...customModels].filter(Boolean)).has(actual);
}

function isExecCall(call) {
  return /(?:^|[_.])exec(?:$|[_.])/i.test(call.name) || call.name === "exec";
}

function isCodexAppCall(call) {
  return isCodexAppListThreadsCall(call) || isCodexAppReadThreadCall(call) ||
    isCodexAppListProjectsCall(call) || isCodexAppGetUsageLimitsCall(call);
}

function isCodexAppListThreadsCall(call) {
  return /mcp__codex_app__list_threads|codex_app(?:__|\.)list_threads/i
    .test(`${call.name}\n${call.input}`);
}

function isCodexAppReadThreadCall(call) {
  return /mcp__codex_app__read_thread|codex_app(?:__|\.)read_thread/i
    .test(`${call.name}\n${call.input}`);
}

function isCodexAppListProjectsCall(call) {
  return /mcp__codex_app__list_projects|codex_app(?:__|\.)list_projects/i
    .test(`${call.name}\n${call.input}`);
}

function isCodexAppGetUsageLimitsCall(call) {
  return /mcp__codex_app__get_usage_limits|codex_app(?:__|\.)get_usage_limits/i
    .test(`${call.name}\n${call.input}`);
}

function isSuccessfulCodexAppOutput(value) {
  const text = String(value ?? "").trim();
  return Boolean(text) && !/"isError"\s*:\s*true|tool call (?:failed|error)|工具调用失败/i.test(text);
}

function inspectCodexAppReadOutput(value, { marker, threadId } = {}) {
  const text = String(value ?? "");
  const documents = collectJsonDocuments(value);
  let threadMatched = false;
  let completedTurnCount = 0;
  let completedTurnsWithMessages = 0;
  let markerInMessageItems = false;
  for (const document of documents) {
    walkJson(document, (candidate) => {
      if (candidate?.thread?.id === threadId) threadMatched = true;
      if (!Array.isArray(candidate?.turns)) return;
      for (const turn of candidate.turns) {
        if (!Array.isArray(turn?.items)) continue;
        const messageItems = turn.items.filter((item) =>
          item?.type === "userMessage" || item?.type === "agentMessage");
        if (turn.status === "completed") {
          completedTurnCount += 1;
          if (messageItems.some((item) => item?.type === "userMessage") &&
            messageItems.some((item) => item?.type === "agentMessage")) {
            completedTurnsWithMessages += 1;
          }
        }
        if (messageItems.some((item) => stringifyPayload(item).includes(marker))) {
          markerInMessageItems = true;
        }
      }
    });
  }
  return {
    threadMatched: threadMatched || Boolean(threadId && text.includes(threadId)),
    hasMessageItems: completedTurnCount > 0 &&
      completedTurnsWithMessages === completedTurnCount,
    markerInMessageItems,
  };
}

function collectJsonDocuments(value) {
  const documents = [];
  const queue = [value];
  const seen = new Set();
  while (queue.length > 0 && documents.length < 32) {
    const candidate = queue.shift();
    if (candidate == null) continue;
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (!/^[{\[]/.test(trimmed)) continue;
      try { queue.push(JSON.parse(trimmed)); } catch {}
      continue;
    }
    if (typeof candidate !== "object" || seen.has(candidate)) continue;
    seen.add(candidate);
    documents.push(candidate);
    for (const nested of Object.values(candidate)) queue.push(nested);
  }
  return documents;
}

function walkJson(value, visit, seen = new Set()) {
  if (value == null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  visit(value);
  for (const nested of Object.values(value)) walkJson(nested, visit, seen);
}

function isWebCall(call) {
  return /web(?:__|\.)?run/i.test(call.name) || /tools\.web__run|web\.run\s*\(/i.test(call.input);
}

function isComputerUseCall(call) {
  const value = `${call.name}\n${call.input}`;
  return /(?:cua|computer.?use)/i.test(call.name) ||
    /(?:mcp__node_repl__js|\bjs\b)/i.test(call.name) &&
      /(?:@oai\/sky|\bsky\.|\bcua\.|createBrowserTab|getTab\(|getState\(|get_window_state\(|\.(?:get)?screenshot\(|getAXStateAndScreenshot\(|emitImage\()/i.test(call.input) ||
    /tools\.mcp__node_repl__js/i.test(value) &&
      /(?:@oai\/sky|\bsky\.|\bcua\.|createBrowserTab|get_window_state\()/i.test(value);
}

function isComputerInputCall(call) {
  return /(?:\bsky\.(?:type_text|set_value)\s*\(|\.typeText\s*\(|\.setValue\s*\()/i.test(call.input);
}

function isComputerSubmitCall(call) {
  return /(?:\bsky\.click\s*\(|\bsky\.press_key\s*\([\s\S]*(?:Return|Enter)|\.click\s*\()/i.test(call.input);
}

function isComputerScreenshotCall(call) {
  return /(?:include_screenshot\s*:\s*true|screenshot|captureScreenshot|emitImage)/i.test(call.input);
}

function isSuccessfulComputerUseOutput(output) {
  const value = String(output ?? "").trim();
  return Boolean(value) &&
    !/["']?isError["']?\s*:\s*true|tool call (?:failed|error)|Mcp error|Script (?:failed|error)|Computer Use has been stopped|SetIsBorderRequired failed|coordinate input geometry is unavailable/i.test(value);
}

function classifyComputerUseFailure(output) {
  const value = String(output ?? "");
  if (/sandboxCwd is not a local file URI/i.test(value)) {
    return "sandbox-cwd-not-local-file-uri";
  }
  if (/SetIsBorderRequired failed:[\s\S]*(?:0x80004002|不支持此接口)/i.test(value)) {
    return "windows-capture-interface-unsupported";
  }
  return null;
}

function hasWebOperation(input, operation) {
  return new RegExp(`(?:["']${operation}["']|\\b${operation}\\s*:)`).test(input);
}

function hasOfficialCodexSource(output) {
  return Boolean(findOfficialAppServerUrl(String(output ?? "")));
}

function hasExitCode(output, expected) {
  const value = String(output ?? "");
  return new RegExp(`(?:exit(?:_|\\s)?code|process exited with code|code)[^0-9-]{0,20}${expected}(?:\\D|$)`, "i").test(value) ||
    new RegExp(`(?:^|\\D)${expected}(?:\\D|$)`).test(value);
}

function stringifyPayload(value) {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value ?? ""); }
}

function threadIdFromPath(path) {
  return basename(String(path ?? "")).match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/i)?.[1] ?? null;
}

function evidenceScore(evidence) {
  return Number(evidence.modelMatches) * 100 + Object.values(evidence.checks ?? {}).filter(Boolean).length;
}

async function collectRecentRollouts(codexHome, startedAt) {
  const paths = [];
  const threshold = Math.max(0, Number(startedAt) - 5 * 60_000);
  for (const directory of [join(codexHome, "sessions"), join(codexHome, "archived_sessions")]) {
    await walk(directory, paths, threshold);
  }
  return paths;
}

async function walk(directory, paths, threshold) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path, paths, threshold);
    else if (/^rollout-.*\.jsonl$/.test(entry.name)) {
      const details = await stat(path).catch(() => null);
      if (details && details.mtimeMs >= threshold) paths.push(path);
    }
  }
}

function resolveCodexHome() {
  const configured = String(process.env.CODEX_HOME ?? "").trim().replace(/^['"]|['"]$/g, "");
  return configured || join(homedir(), ".codex");
}
