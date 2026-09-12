// Rollout item lifecycles are the source of individual execution durations.
// Never parse an exec program to invent child calls or divide its wall time.
const projectionCache = new WeakMap();

export function simplifyToolExecutionRecord(record, currentTurnId) {
  // Self-contained: this exact function also runs in the rollout reader worker.
  const text = (value) => typeof value === "string" ? value.trim() : "";
  const compact = (value) => text(value).replace(/[\r\n\t]+/g, " ").slice(0, 120);
  const number = (value) => value != null && Number.isFinite(Number(value)) && Number(value) >= 0
    ? Number(value) : null;
  const filename = (value) => text(value).split(/[\\/]/).filter(Boolean).at(-1) || "文件";
  const commandLabel = (words) => {
    let index = 0;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] || "")) index += 1;
    const executable = words[index] || "";
    if (!executable) return "";
    const name = filename(executable);
    if (!/^[\w.-]+$/.test(name)) return "";
    const program = name.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
    if (program === "node") {
      const modes = [];
      const scripts = [];
      const valueOptions = ["-r", "--require", "--import", "--loader", "--experimental-loader", "--input-type",
        "--test-name-pattern", "--test-skip-pattern", "--test-reporter", "--test-reporter-destination",
        "--test-concurrency", "--conditions"];
      const switches = ["--no-warnings", "--enable-source-maps", "--experimental-strip-types", "--watch", "--inspect", "--inspect-brk"];
      for (index += 1; index < words.length; index += 1) {
        const value = words[index];
        // Eval/print source is an argument, not a filename or a child command.
        if (["-e", "--eval", "-p", "--print"].includes(value) || /^--(?:eval|print)=/.test(value)) {
          modes.push(value.split("=")[0]);
          break;
        }
        if (/^-[ep].+/.test(value)) { modes.push(value.slice(0, 2)); break; }
        if (["--check", "-c", "--test"].includes(value)) { modes.push(value); continue; }
        if (valueOptions.includes(value)) { index += 1; continue; }
        if (switches.includes(value) || /^--[^=]+=/.test(value)) continue;
        if (value === "--") continue;
        if (value.startsWith("-")) break;
        if (value && !/[\r\n$`]/.test(value)) scripts.push(filename(value));
        // After the entry script, remaining words are application arguments.
        if (!modes.includes("--test")) break;
      }
      return [name, ...modes, ...scripts].join(" ");
    }
    // Subcommands identify the operation, unlike options, paths and operands.
    // Unknown CLI grammars expose only the executable, never arbitrary args.
    const subcommands = {
      git: ["diff", "status", "show", "log", "branch", "rev-parse", "ls-files", "add", "commit", "fetch", "pull", "push", "restore", "switch", "checkout", "reset"],
      npm: ["test", "run", "install", "ci", "exec", "build", "start", "audit", "ls", "view", "version"],
      pnpm: ["test", "run", "install", "exec", "build", "start", "lint", "check"],
      yarn: ["test", "run", "install", "exec", "build", "start", "lint", "check"],
    };
    if (!subcommands[program]) return name;
    const optionsWithValue = program === "git"
      ? ["-C", "-c", "--git-dir", "--work-tree", "--namespace"]
      : ["--prefix", "--cwd", "--dir", "-C", "--filter"];
    index += 1;
    while (words[index]?.startsWith("-")) {
      const option = words[index++];
      if (option === "--") break;
      if (optionsWithValue.includes(option)) index += 1;
      else if (!option.includes("=") && !["--no-pager", "--bare", "--silent", "-s", "--offline"].includes(option)) return name;
    }
    const subcommand = words[index];
    if (!subcommands[program].includes(subcommand)) return name;
    const script = words[index + 1];
    return `${name} ${subcommand}${program !== "git" && subcommand === "run" &&
      /^[\w:@.-]+$/.test(script || "") ? ` ${script}` : ""}`;
  };
  const shellCommandLabels = (source) => {
    const labels = [];
    let words = [];
    let word = "";
    let quote = null;
    let redirectTarget = false;
    const flushWord = () => {
      if (word && !redirectTarget) words.push(word);
      if (word) redirectTarget = false;
      word = "";
    };
    const flushCommand = () => {
      flushWord();
      const label = commandLabel(words);
      if (label) labels.push(label);
      words = [];
    };
    // Only tokenize command boundaries. Quoted arguments stay opaque, and
    // heredoc bodies / shell expressions are never interpreted as commands.
    for (let index = 0; index < source.length; index += 1) {
      const char = source[index];
      if (char === "\\" && quote !== "'") {
        const next = source[++index];
        if (next && next !== "\n") word += next;
      } else if (quote) {
        if (char === quote) quote = null;
        else word += char;
      } else if (char === "'" || char === '"') {
        quote = char;
      } else if (char === "#" && !word) {
        while (index < source.length && source[index] !== "\n") index += 1;
        flushCommand();
      } else if ((char === "<" && source[index + 1] === "<") || char === "(" || char === "`") {
        // Stop at heredocs/embedded programs rather than display their
        // contents or pretend to fully parse a shell script.
        flushCommand();
        return labels;
      } else if (char === "<" || char === ">") {
        if (/^\d+$/.test(word)) word = "";
        flushWord();
        if (source[index + 1] === char) index += 1;
        if (source[index + 1] === "&") index += 1;
        redirectTarget = true;
      } else if (/[;&|\r\n]/.test(char)) {
        flushCommand();
      } else if (/\s/.test(char)) {
        flushWord();
      } else {
        word += char;
      }
    }
    flushCommand();
    return labels;
  };
  const p = record?.payload;
  if (!p) return null;
  const turnId = text(p.turn_id || p.internal_chat_message_metadata_passthrough?.turn_id || currentTurnId);
  if (!turnId) return null;
  const at = Date.parse(record.timestamp);
  const base = { turnId, threadId: text(p.thread_id) || null };
  if (record.type === "response_item") {
    // Classify protocol structures, not a list of tool names.
    if (["function_call", "custom_tool_call"].includes(p.type) && text(p.call_id)) {
      return { ...base, kind: "call", id: p.call_id, toolName: compact(p.name) || "工具调用",
        startedAt: Number.isFinite(at) ? at : null };
    }
    if (["function_call_output", "custom_tool_call_output"].includes(p.type) && text(p.call_id)) {
      return { ...base, kind: "result", id: p.call_id,
        completedAt: Number.isFinite(at) ? at : null };
    }
    return null;
  }
  if (record.type === "token_usage_record" && text(p.response_id)) {
    return { ...base, kind: "response", responseId: p.response_id };
  }
  if (record.type !== "event_msg" || p.type !== "item_completed") return null;
  const item = p.item;
  if (!item || !text(item.id)) return null;
  let toolName;
  let description;
  let detailList;
  const type = text(item.type).replaceAll("_", "").toLowerCase();
  switch (type) {
    case "commandexecution": {
      const source = text(item.source).replaceAll("_", "").toLowerCase();
      if (source === "usershell") return null;
      toolName = source === "unifiedexecinteraction" ? "write_stdin" : "exec_command";
      // Keep command identities only; do not persist shell arguments/output.
      const actions = item.parsed_cmd || item.commandActions || [];
      const commands = Array.isArray(actions) ? actions.map((action) => text(action.cmd)).filter(Boolean) : [];
      let labels = commands.flatMap(shellCommandLabels);
      if (commands.length === 0) {
        const argv = item.command;
        if (Array.isArray(argv)) {
          const shell = filename(argv[0]).replace(/\.exe$/i, "").toLowerCase();
          const shellOption = ["sh", "bash", "zsh", "dash", "ksh"].includes(shell)
            ? argv.findIndex((arg, index) => index > 0 && /^-[a-z]*c[a-z]*$/.test(arg)) : -1;
          labels = shellOption >= 0 ? shellCommandLabels(text(argv[shellOption + 1])) : [commandLabel(argv)];
        } else if (typeof argv === "string") {
          labels = shellCommandLabels(argv);
        }
      }
      const entries = labels.filter(Boolean).map((label) => label.replace(/[\r\n\t]+/g, " "));
      if (entries.length) detailList = { kind: "commands", items: entries };
      description = entries.length ? `${entries.length} 条命令` : "命令未记录";
      break;
    }
    case "filechange": {
      toolName = "apply_patch";
      const paths = Array.isArray(item.changes)
        ? item.changes.map((change) => change.path) : Object.keys(item.changes || {});
      const entries = paths.filter((path) => text(path)).map((path) => filename(path).replace(/[\r\n\t]+/g, " "));
      if (entries.length) detailList = { kind: "files", items: entries };
      description = entries.length ? `${entries.length} 个文件` : "文件未记录";
      break;
    }
    case "imageview":
      toolName = "view_image";
      description = `查看 ${filename(item.path)}`;
      break;
    case "mcptoolcall":
      toolName = text(item.tool) || "MCP 工具";
      description = text(item.server) ? `MCP · ${item.server}` : "MCP 调用";
      break;
    case "dynamictoolcall":
      toolName = [text(item.namespace), text(item.tool)].filter(Boolean).join(".") || "动态工具";
      description = "工具调用";
      break;
    case "functioncalloutput":
      toolName = [text(item.namespace), text(item.name)].filter(Boolean).join(".") || "工具调用";
      description = "工具调用";
      break;
    case "collabagenttoolcall":
      toolName = text(item.tool) || "智能体工具";
      description = "智能体协作";
      break;
    case "sleep":
      toolName = "sleep";
      description = "等待";
      break;
    case "imagegeneration":
      toolName = "image_generation";
      description = "生成图片";
      break;
    case "extension":
      toolName = text(item.kind) || "扩展工具";
      description = ({ search: "搜索网页", openPage: "打开网页", findInPage: "查找页面内容" })[item.action?.type]
        || "扩展调用";
      break;
    case "websearch":
      toolName = "web_search";
      description = "搜索网页";
      break;
    default:
      // Message/reasoning/compaction events are not executions. Unknown schema
      // remains unavailable instead of guessing a tool from its name/content.
      return null;
  }
  const startedAt = number(p.started_at_ms);
  const completedAt = number(p.completed_at_ms);
  const reportedDuration = number(item.durationMs) ??
    (number(item.duration?.secs) != null
      ? number(item.duration.secs) * 1_000 + (number(item.duration.nanos) ?? 0) / 1_000_000
      : null);
  return { ...base, kind: "item", id: item.id, toolName: compact(toolName),
    description: compact(description), startedAt, completedAt,
    ...(detailList ? { detailList } : {}),
    durationMs: reportedDuration ?? (startedAt != null && completedAt != null && completedAt >= startedAt
      ? completedAt - startedAt : null),
    status: compact(item.status) || "completed" };
}

export function createToolExecutionLedger() {
  return { calls: [], items: [], responseIds: [] };
}

export function normalizeToolExecutionDetailList(value) {
  if (!["commands", "files"].includes(value?.kind) || !Array.isArray(value.items)) return null;
  const items = value.items.filter((item) => typeof item === "string" && item.trim())
    .map((item) => item.replace(/[\r\n\t]+/g, " ").trim());
  // Keep the complete structured list, including repeated command/file names.
  // Clipping a joined description would make the expanded list irrecoverable.
  return items.length ? { kind: value.kind, items } : null;
}

export function recordToolExecution(ledger, record) {
  projectionCache.delete(ledger);
  if (record.kind === "call") {
    if (!ledger.calls.some((call) => call.id === record.id)) {
      ledger.calls.push({ ...record, responseId: null, completedAt: null });
    }
  } else if (record.kind === "result") {
    const call = ledger.calls.find((value) => value.id === record.id);
    if (call) call.completedAt = record.completedAt;
  } else if (record.kind === "response") {
    if (ledger.responseIds.includes(record.responseId)) return;
    ledger.responseIds.push(record.responseId);
    // Codex appends response items, then its exact usage ledger, before tool
    // results. Bind only that still-open batch, never an older closed call.
    for (const call of ledger.calls) {
      if (!call.responseId && call.completedAt == null) call.responseId = record.responseId;
    }
  } else if (record.kind === "item") {
    const existing = ledger.items.findIndex((item) => item.id === record.id);
    if (existing < 0) ledger.items.push(record);
    else ledger.items[existing] = record;
  }
}

export function normalizeToolExecutionLedger(value) {
  const ledger = createToolExecutionLedger();
  if (!value || typeof value !== "object") return ledger;
  const number = (value) => value != null && Number.isFinite(Number(value)) && Number(value) >= 0
    ? Number(value) : null;
  const text = (value) => typeof value === "string" ? value.slice(0, 120) : "";
  ledger.responseIds = Array.isArray(value.responseIds)
    ? [...new Set(value.responseIds.filter((id) => typeof id === "string" && id))] : [];
  for (const key of ["calls", "items"]) {
    const seen = new Set();
    ledger[key] = (Array.isArray(value[key]) ? value[key] : []).flatMap((entry) => {
      if (!text(entry?.id) || seen.has(entry.id)) return [];
      seen.add(entry.id);
      const detailList = key === "items" ? normalizeToolExecutionDetailList(entry.detailList) : null;
      return [{ id: text(entry.id), toolName: text(entry.toolName),
        startedAt: number(entry.startedAt), completedAt: number(entry.completedAt),
        ...(key === "calls" ? { responseId: text(entry.responseId) || null } : {
          description: text(entry.description), durationMs: number(entry.durationMs), status: text(entry.status),
          ...(detailList ? { detailList } : {}),
        }) }];
    });
  }
  return ledger;
}

export function projectToolExecutions(ledger, responseId) {
  if (!responseId || !ledger?.calls?.length) return null;
  let projections = projectionCache.get(ledger);
  if (projections) return projections.get(responseId) ?? null;
  projections = new Map();
  const parentsByResponse = new Map();
  const parentById = new Map();
  const executionEnds = new Map();
  for (const call of ledger.calls) {
    parentById.set(call.id, call);
    if (!call.responseId) continue;
    const parents = parentsByResponse.get(call.responseId) ?? [];
    parents.push(call);
    parentsByResponse.set(call.responseId, parents);
    projections.set(call.responseId, { calls: [], durationMs: null, complete: false });
  }
  const covered = new Set();
  for (const item of ledger.items) {
    const exact = parentById.get(item.id);
    const candidates = exact ? [exact] : ledger.calls.filter((call) =>
      call.startedAt != null && item.startedAt != null && item.startedAt >= call.startedAt &&
      // An open parent is not a finished execution window yet. Waiting for its
      // result avoids attaching later work to an interrupted/yielded call.
      call.completedAt != null && item.startedAt <= call.completedAt);
    const owner = candidates[0]?.responseId;
    if (!owner || candidates.some((call) => call.responseId !== owner)) continue;
    for (const call of candidates) covered.add(call.id);
    if (item.completedAt != null) {
      executionEnds.set(owner, Math.max(executionEnds.get(owner) ?? 0, item.completedAt));
    }
    const detailList = normalizeToolExecutionDetailList(item.detailList);
    projections.get(owner).calls.push({ id: item.id, toolName: item.toolName,
      description: item.description || "", startedAt: item.startedAt ?? null,
      ...(detailList ? { detailList } : {}),
      durationMs: item.durationMs ?? null, status: item.status || "", measured: true });
  }
  for (const [id, parents] of parentsByResponse) {
    const projection = projections.get(id);
    for (const parent of parents) {
      if (covered.has(parent.id)) continue;
      projection.calls.push({ id: parent.id, toolName: parent.toolName, description: "单项明细未记录",
        startedAt: parent.startedAt, durationMs: null, measured: false });
    }
    projection.calls.sort((left, right) => (left.startedAt ?? Infinity) - (right.startedAt ?? Infinity));
    const complete = parents.every((call) => call.startedAt != null && call.completedAt != null &&
      call.completedAt >= call.startedAt);
    // Wall span includes orchestration/dispatch, not the sum of parallel tools.
    // A yielded command can finish after exec has already returned a session
    // ID. Keep its actual completion in the group's span, not just the yield.
    projection.durationMs = complete ? Math.max(executionEnds.get(id) ?? 0, ...parents.map((call) => call.completedAt)) -
      Math.min(...parents.map((call) => call.startedAt)) : null;
    projection.complete = projection.calls.every((call) => call.measured);
  }
  projectionCache.set(ledger, projections);
  return projections.get(responseId) ?? null;
}
