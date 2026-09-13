import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { findOfficialAppServerUrl } from "../live-tests/web-search-contract.mjs";
import { defaultAccountDataDir } from "../src/platform.mjs";

export const DESKTOP_HOST_REPORT_VERSION = 4;

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
  const failureCall = calls.find((call) => isExecCall(call) && call.input.includes(failureMarker));
  const execOutput = execCall ? outputs.get(execCall.id)?.text ?? "" : "";
  const failureOutputRecord = failureCall ? outputs.get(failureCall.id) : null;
  const failureOutput = failureOutputRecord?.text ?? "";
  const continuedAfterFailure = Boolean(failureOutputRecord && calls.some((call) =>
    call.recordIndex > failureOutputRecord.recordIndex &&
    (isCodexAppCall(call) || isWebCall(call) || isComputerUseCall(call) ||
      isUserInputCall(call))));
  const currentThreadId = session.threadId ?? threadIdFromPath(path);
  const codexAppListCall = calls.find(isCodexAppListThreadsCall);
  const codexAppListOutput = codexAppListCall ? outputs.get(codexAppListCall.id) : null;
  const codexAppReadCall = calls.find((call) => isCodexAppReadThreadCall(call) &&
    (!codexAppListOutput || call.recordIndex > codexAppListOutput.recordIndex));
  const codexAppReadOutput = codexAppReadCall ? outputs.get(codexAppReadCall.id)?.text ?? "" : "";
  const codexAppListSucceeded = Boolean(codexAppListCall && codexAppListOutput &&
    currentThreadId && codexAppListOutput.text.includes(currentThreadId));
  const codexAppReadSucceeded = Boolean(codexAppReadCall && currentThreadId &&
    codexAppReadCall.input.includes(currentThreadId) &&
    isSuccessfulCodexAppOutput(codexAppReadOutput));
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
  const computerInputs = computerCalls.map((call) => call.input).join("\n");
  const userInputCall = calls.find(isUserInputCall);
  const userInputOutput = userInputCall ? outputs.get(userInputCall.id) : null;
  const successfulToolUserInput = Boolean(userInputOutput &&
    isSuccessfulUserInputOutput(userInputOutput.text));
  const directUserInput = records.slice((userInputOutput?.recordIndex ?? startIndex) + 1)
    .map((record, offset) => ({ record, recordIndex: (userInputOutput?.recordIndex ?? startIndex) + 1 + offset }))
    .find(({ record }) => isDirectUserInputRecord(record));
  const userInputRecordIndex = successfulToolUserInput
    ? userInputOutput.recordIndex
    : directUserInput?.recordIndex ?? null;
  const continuedAfterUserInput = Number.isInteger(userInputRecordIndex) &&
    records.slice(userInputRecordIndex + 1).some((record) =>
      record.type === "response_item" && record.payload?.type === "message" &&
      record.payload?.role === "assistant");
  const modelMatches = matchesProfileModel(profile, currentModel, customModels);
  const turnCompleted = records.slice(startIndex).some((record) =>
    record.type === "event_msg" && record.payload?.type === "task_complete");

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
    turnCompleted,
    callIds: {
      functionsExecSuccess: execCall?.id ?? null,
      functionsExecFailure: failureCall?.id ?? null,
      codexAppListThreads: codexAppListCall?.id ?? null,
      codexAppReadThread: codexAppReadCall?.id ?? null,
      codexAppListProjects: codexAppListProjectsCall?.id ?? null,
      codexAppGetUsageLimits: codexAppGetUsageLimitsCall?.id ?? null,
      webRun: webCalls.map((call) => call.id).filter(Boolean),
      computerUse: computerCalls.map((call) => call.id).filter(Boolean),
      userInput: userInputCall?.id ?? null,
    },
    userInputMode: successfulToolUserInput ? "tool" : directUserInput ? "direct-follow-up" : null,
    checks: {
      functionsExec: Boolean(execCall && execOutput.includes(execMarker)),
      functionsExecFailure: Boolean(failureCall && failureOutput.includes(failureMarker) &&
        hasExitCode(failureOutput, 23) && continuedAfterFailure),
      codexAppListThreads: codexAppListSucceeded,
      codexAppReadThread: codexAppListSucceeded && codexAppReadSucceeded,
      codexAppReadMarker: codexAppReadOutput.includes(marker),
      codexAppListProjects: Boolean(codexAppListProjectsCall &&
        isSuccessfulCodexAppOutput(codexAppListProjectsOutput)),
      codexAppGetUsageLimits: Boolean(codexAppGetUsageLimitsCall &&
        isSuccessfulCodexAppOutput(codexAppGetUsageLimitsOutput)),
      webSearch: Boolean(webSearchCall),
      webOpen: Boolean(webSearchCall && webOpenCall),
      webFind: Boolean(webOpenCall && webFindCall),
      webResult: hasOfficialCodexSource(webResultOutputs) && /thread\/fork/i.test(webResultOutputs),
      computerUse: computerCalls.length > 0,
      computerScreenshot: /(?:screenshot|captureScreenshot|emitImage)/i.test(computerInputs),
      userInput: Boolean((successfulToolUserInput || directUserInput) && continuedAfterUserInput),
    },
  };
}

export function evaluateDesktopHostEvidence({
  profile,
  marker,
  runtimeBinding,
  rollout,
  toolInventory = null,
  triggerMode = "direct",
  httpEvidence = {},
  sourceCurrent = true,
} = {}) {
  const submissions = Array.isArray(httpEvidence.submissions) ? httpEvidence.submissions : [];
  const invalidSubmissions = Number(httpEvidence.invalidSubmissions ?? 0);
  const readThreadPassed = rollout?.checks?.codexAppReadThread === true &&
    (triggerMode === "delegated" || rollout?.checks?.codexAppReadMarker === true);
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
    check("functions-exec", "functions.exec 成功命令与真实输出", rollout?.checks?.functionsExec === true),
    check("functions-exec-failure", "functions.exec 失败退出码及任务续接",
      rollout?.checks?.functionsExecFailure === true),
    check("codex-app-list-threads", "codex_app list_threads 返回当前任务",
      rollout?.checks?.codexAppListThreads === true),
    check("codex-app-read-thread", triggerMode === "delegated"
      ? "codex_app read_thread 成功读取当前任务"
      : "codex_app read_thread 读取当前任务标记", readThreadPassed),
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
    check("computer-use", "computer use 打开、输入并单次提交",
      rollout?.checks?.computerUse === true && invalidSubmissions === 0 &&
      submissions.length === 1 && submissions[0]?.value === marker),
    check("computer-screenshot", "computer use 截图", rollout?.checks?.computerScreenshot === true),
    check("download", "浏览器下载测试产物", Number(httpEvidence.artifactRequests ?? 0) >= 1),
    check("user-input", "用户补充输入回到当前任务", rollout?.checks?.userInput === true),
  ];
  let status = checks.every((item) => item.status === "passed") ? "passed" : "incomplete";
  const hardFailure = !sourceCurrent || runtimeBinding?.status === "failed" || invalidSubmissions > 0 ||
    submissions.length > 1 || (rollout && rollout.modelMatches === false);
  if (hardFailure) status = "failed";
  const completed = rollout?.modelMatches === true && rollout.turnCompleted &&
    rollout?.checks?.userInput === true;
  if (!hardFailure && completed) {
    for (const item of checks) {
      if (item.status !== "not-run") continue;
      item.status = checkWasAttempted(item.id, rollout) ? "failed" : "not-executed";
    }
    if (checks.some((item) => item.status === "failed")) status = "failed";
    else if (checks.some((item) => ["unsupported", "not-executed"].includes(item.status))) status = "blocked";
    else status = "passed";
  }
  const unavailable = checks.filter((item) => ["unsupported", "not-executed"].includes(item.status));
  return {
    status,
    checks,
    blockedReason: status === "blocked"
      ? `目标模型任务已结束，能力不可用或未执行：${unavailable.map((item) => `${item.label}(${item.status})`).join("、")}`
      : null,
  };
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

export function desktopHostPrompt({ profile, marker, fixtureUrl, runId, root, triggerMode = "direct" }) {
  const label = profile === "deepseek" ? "DeepSeek" : "Codex 官方模型";
  const execMarker = `EXEC_${marker}`;
  const failureMarker = `FAIL_${marker}`;
  return [
    `这是 ${label} 的真实桌面入口验收，验收编号 ${runId}，标记 ${marker}。`,
    `必须在当前这个桌面任务中完成，不创建另一个模型任务。`,
    `1. 用 functions.exec 在项目 ${root} 执行 node -e "process.stdout.write('${execMarker}')"，并读取真实输出和退出码 0。`,
    `2. 再用 functions.exec 执行 node -e "process.stderr.write('${failureMarker}');process.exit(23)"；确认随机标记和退出码 23 返回当前任务，然后继续后续步骤。`,
    triggerMode === "delegated"
      ? `3. 调用四个常用只读 codex_app 入口：先用 list_threads 找到当前含标记 ${marker} 的任务，再用返回的当前任务 ID 调用 read_thread 并确认调用成功；跨任务委托模式不要求 read_thread 摘要重复返回当前活动输入，标记由 rollout 独立绑定。随后分别调用 list_projects 和 get_usage_limits 并确认正常返回。不能读取本地 rollout 代替。`
      : `3. 调用四个常用只读 codex_app 入口：先用 list_threads 找到当前含标记 ${marker} 的任务，再用返回的当前任务 ID 调用 read_thread 并确认真实输出含同一标记；随后分别调用 list_projects 和 get_usage_limits 并确认正常返回。不能读取本地 rollout 代替。`,
    "4. 用实际 web.run 搜索 OpenAI 官方 Codex app-server 文档，open 命中页面，再 find `thread/fork`；不能用 shell 或普通 fetch 代替。",
    `5. 用实际 computer use 打开 ${fixtureUrl}，读取页面标记，原样输入并只提交一次；随后截图并点击下载测试产物。`,
    "6. 用 request_user_input 询问是否继续本次桌面验收，收到答复后继续；若当前任务模式明确拒绝该工具，则直接询问用户并在下一轮收到答复后继续；审批允许/拒绝不属于测试项。",
    `7. 收到补充输入后正常结束任务。运行中的监视器会自动更新验收编号 ${runId} 的报告，不要编辑报告文件。`,
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
  table{width:100%;border-collapse:collapse}td{padding:9px;border-bottom:1px solid #eee}.passed{color:#17833d}.failed,.blocked,.stale{color:#c62828}.unsupported,.not-executed,.not-run,.incomplete,.running{color:#9a6500}
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
  if (id === "functions-exec-failure") return Boolean(callIds.functionsExecFailure);
  if (id === "codex-app-list-threads") return Boolean(callIds.codexAppListThreads);
  if (id === "codex-app-read-thread") return Boolean(callIds.codexAppReadThread);
  if (id === "codex-app-list-projects") return Boolean(callIds.codexAppListProjects);
  if (id === "codex-app-get-usage-limits") return Boolean(callIds.codexAppGetUsageLimits);
  if (["web-search", "web-open", "web-find"].includes(id)) return (callIds.webRun?.length ?? 0) > 0;
  if (["computer-use", "computer-screenshot", "download"].includes(id)) {
    return (callIds.computerUse?.length ?? 0) > 0;
  }
  if (id === "user-input") return Boolean(callIds.userInput || rollout?.userInputMode);
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

function isDirectUserInputRecord(record) {
  if (record?.type !== "response_item") return false;
  const payload = record.payload;
  if (payload?.type === "message" && payload.role === "user") return true;
  if (
    payload?.type !== "function_call_output"
    || String(payload.call_id ?? "").trim()
    || payload.name !== "send_message_to_thread"
    || payload.namespace !== "codex_app"
  ) {
    return false;
  }
  return /^\s*<codex_delegation>[\s\S]*<input>[\s\S]*<\/input>\s*<\/codex_delegation>\s*$/.test(
    String(payload.output ?? ""),
  );
}

function isWebCall(call) {
  return /web(?:__|\.)?run/i.test(call.name) || /tools\.web__run|web\.run\s*\(/i.test(call.input);
}

function isComputerUseCall(call) {
  return /(?:cua|computer.?use)/i.test(call.name) ||
    (call.name === "js" && /(?:\bcua\.|createBrowserTab|getTab\(|getState\(|\.(?:get)?screenshot\(|getAXStateAndScreenshot\(|emitImage\()/i.test(call.input));
}

function isUserInputCall(call) {
  return /request_user_input/i.test(call.name) || /tools\.request_user_input|request_user_input\s*\(/i.test(call.input);
}

function isSuccessfulUserInputOutput(output) {
  const value = String(output ?? "").trim();
  return Boolean(value) &&
    !/request_user_input[^\n]*(?:unavailable|not available|failed|error)/i.test(value) &&
    !/["']?isError["']?\s*:\s*true/i.test(value);
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
