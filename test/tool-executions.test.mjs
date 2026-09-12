import assert from "node:assert/strict";
import test from "node:test";
import {
  createToolExecutionLedger,
  normalizeToolExecutionLedger,
  projectToolExecutions,
  recordToolExecution,
  simplifyToolExecutionRecord,
} from "../src/tool-executions.mjs";

function add(ledger, kind, extra = {}) {
  recordToolExecution(ledger, { kind, ...extra });
}

test("exec 内同名调用逐项展开，单项采用原生时长，整组采用墙钟而非并行求和", () => {
  const ledger = createToolExecutionLedger();
  add(ledger, "call", { id: "outer", toolName: "exec", startedAt: 100 });
  add(ledger, "response", { responseId: "response-1" });
  add(ledger, "item", { id: "inner-1", toolName: "exec_command", startedAt: 150, durationMs: 6_317 });
  add(ledger, "item", { id: "inner-2", toolName: "exec_command", startedAt: 180, durationMs: 5_000 });
  // Results can arrive after another cache refresh; an open parent is not
  // prematurely labelled a complete invocation list.
  assert.equal(projectToolExecutions(ledger, "response-1").complete, false);
  add(ledger, "result", { id: "outer", completedAt: 6_600 });
  const result = projectToolExecutions(ledger, "response-1");
  assert.equal(result.durationMs, 6_500);
  assert.equal(result.complete, true);
  assert.deepEqual(result.calls.map((call) => [call.id, call.toolName, call.durationMs]), [
    ["inner-1", "exec_command", 6_317], ["inner-2", "exec_command", 5_000],
  ]);
  assert.deepEqual(projectToolExecutions(normalizeToolExecutionLedger(JSON.parse(JSON.stringify(ledger))), "response-1"), result);
  add(ledger, "item", { id: "inner-1", toolName: "exec_command", startedAt: 150, durationMs: 6_317 });
  add(ledger, "response", { responseId: "response-1" });
  assert.equal(projectToolExecutions(ledger, "response-1").calls.length, 2, "replay must not duplicate calls");
});

test("晚完成的命令仍归属启动请求；时间窗口归属不唯一时保留未记录", () => {
  const ledger = createToolExecutionLedger();
  add(ledger, "call", { id: "a", toolName: "exec", startedAt: 100 });
  add(ledger, "response", { responseId: "ra" });
  add(ledger, "result", { id: "a", completedAt: 200 });
  add(ledger, "call", { id: "b", toolName: "exec", startedAt: 300 });
  add(ledger, "response", { responseId: "rb" });
  add(ledger, "result", { id: "b", completedAt: 800 });
  add(ledger, "item", { id: "late", toolName: "exec_command", startedAt: 150, completedAt: 700, durationMs: 550 });
  assert.equal(projectToolExecutions(ledger, "ra").calls[0].id, "late");
  assert.equal(projectToolExecutions(ledger, "ra").durationMs, 600, "a session yield does not end the command's execution");
  assert.equal(projectToolExecutions(ledger, "rb").calls[0].durationMs, null);
  assert.equal(projectToolExecutions(ledger, "missing"), null);

  add(ledger, "call", { id: "overlap", toolName: "exec", startedAt: 120 });
  add(ledger, "response", { responseId: "rc" });
  add(ledger, "result", { id: "overlap", completedAt: 210 });
  assert.equal(projectToolExecutions(ledger, "ra").complete, false);
  assert.equal(projectToolExecutions(ledger, "rc").complete, false);
  // Exact native call identity is stronger than overlapping time windows.
  add(ledger, "item", { id: "a", toolName: "native_tool", startedAt: 130, durationMs: 20 });
  assert.equal(projectToolExecutions(ledger, "ra").calls[0].toolName, "native_tool");
});

test("缺少旧响应账本的已结束调用不会被分配给下一次模型请求", () => {
  const ledger = createToolExecutionLedger();
  add(ledger, "call", { id: "old", toolName: "exec", startedAt: 10 });
  add(ledger, "result", { id: "old", completedAt: 20 });
  add(ledger, "call", { id: "new", toolName: "exec", startedAt: 30 });
  add(ledger, "response", { responseId: "new-response" });
  add(ledger, "result", { id: "new", completedAt: 40 });
  assert.deepEqual(projectToolExecutions(ledger, "new-response").calls.map((call) => call.id), ["new"]);
  assert.equal(ledger.calls[0].responseId, null);
});

test("按原生 item 类型识别工具，安全摘要不存储脚本、补丁、参数和返回正文", () => {
  const record = (item, timing = {}) => ({ type: "event_msg", payload: {
    type: "item_completed", thread_id: "thread", turn_id: "turn", item,
    started_at_ms: 100, completed_at_ms: 6_600, ...timing,
  } });
  const command = simplifyToolExecutionRecord(record({ type: "CommandExecution", id: "cmd",
    command: ["/bin/zsh", "-lc", "secret-token"],
    parsed_cmd: [{ type: "unknown", cmd: "npm test && echo secret-token" }],
    duration: { secs: 6, nanos: 316_853_958 }, stdout: "secret-token",
  }));
  assert.equal(command.durationMs, 6_316.853958);
  assert.equal(command.description, "2 条命令");
  assert.deepEqual(command.detailList, { kind: "commands", items: ["npm test", "echo"] });
  assert.equal(JSON.stringify(command).includes("secret-token"), false);
  const types = [
    [{ type: "FileChange", changes: { "/tmp/a.mjs": { unified_diff: "secret-token" } } }, "apply_patch"],
    [{ type: "fileChange", changes: [{ path: "/tmp/a.mjs" }] }, "apply_patch"],
    [{ type: "ImageView", path: "file:///tmp/a.png" }, "view_image"],
    [{ type: "McpToolCall", tool: "never_seen_before", server: "example", arguments: { secret: "secret-token" } }, "never_seen_before"],
    [{ type: "DynamicToolCall", tool: "new_tool", namespace: "example" }, "example.new_tool"],
    [{ type: "FunctionCallOutput", name: "future_tool", namespace: "example" }, "example.future_tool"],
    [{ type: "Extension", kind: "web.search", action: { type: "openPage" } }, "web.search"],
    [{ type: "WebSearch" }, "web_search"],
    [{ type: "CollabAgentToolCall", tool: "spawnAgent" }, "spawnAgent"],
    [{ type: "Sleep" }, "sleep"],
    [{ type: "ImageGeneration" }, "image_generation"],
    [{ type: "CommandExecution", source: "unified_exec_interaction" }, "write_stdin"],
  ];
  for (const [item, expected] of types) {
    const result = simplifyToolExecutionRecord(record({ id: "item", ...item }));
    assert.equal(result.toolName, expected);
    assert.equal(result.durationMs, 6_500);
    assert.equal(JSON.stringify(result).includes("secret-token"), false);
  }
  for (const type of ["Reasoning", "AgentMessage", "UserMessage", "ContextCompaction", "UnknownSchema"]) {
    assert.equal(simplifyToolExecutionRecord(record({ type, id: "item", name: "exec_command" })), null);
  }
  assert.equal(simplifyToolExecutionRecord(record({ type: "ImageView", id: "image" }, {
    started_at_ms: undefined, completed_at_ms: undefined,
  })).durationMs, null);
  assert.equal(simplifyToolExecutionRecord(record({ type: "CommandExecution", id: "user-shell", source: "userShell" })), null);
});

test("命令明细保留执行模式和入口脚本，隐藏目录、业务参数和内联代码", () => {
  const label = (item) => {
    const record = simplifyToolExecutionRecord({ type: "event_msg", payload: {
      type: "item_completed", turn_id: "turn", item: { type: "CommandExecution", id: "cmd", ...item },
    } });
    return record.detailList?.items.join("、") || record.description;
  };
  const parsed = (cmd, type = "unknown") => label({ parsed_cmd: [{ type, cmd }] });
  assert.equal(parsed('git diff --stat src/private.mjs'), "git diff");
  assert.equal(parsed('git -C "/private/project folder" diff --check'), "git diff");
  assert.equal(parsed('npm test -- --test-name-pattern=private'), "npm test");
  assert.equal(parsed('npm run test:unit -- --secret=hidden'), "npm run test:unit");
  assert.equal(parsed('node --check private.mjs && git diff --check && npm test'), "node --check private.mjs、git diff、npm test");
  assert.equal(parsed('npm test >/private/log 2>&1 && git diff --check'), "npm test、git diff");
  assert.equal(parsed('rg -n "secret; git diff" /private/src | head -20', "search"), "rg、head");
  assert.equal(parsed('sed -n "1,50p" /private/file.mjs', "read"), "sed");
  assert.equal(parsed('TOKEN="private value" npm test'), "npm test");
  assert.equal(parsed('curl -H "Authorization: Bearer secret" "https://private.example"'), "curl");
  assert.equal(parsed("node <<'JS'\nsecret_payload();\ngit diff\nJS"), "node");
  assert.equal(parsed("printf '%s\\n' 'secret; npm test'\n# private comment\ngit status --short"), "printf、git status");
  assert.equal(label({ command: ["/bin/zsh", "-lc", "node --check private.mjs && npm test"] }), "node --check private.mjs、npm test");
  assert.equal(label({ command: ["/usr/local/bin/git", "diff", "--stat", "/private/file"] }), "git diff");
  assert.equal(label({ command: '"/some folder/bin/node" --check /private/file' }), "node --check file");
  assert.equal(label({ commandActions: [{ type: "unknown", cmd: "pnpm test --verbose" }] }), "pnpm test");
  assert.equal(label({ parsed_cmd: [{ type: "read", path: "/private/file" }] }), "命令未记录");
  assert.equal(parsed("unknown-cli secret-operand --token=private"), "unknown-cli");
  assert.equal(parsed('node /private/src/launcher.mjs --token=secret extra.mjs'), "node launcher.mjs");
  assert.equal(parsed('node --test --test-concurrency=1 /private/a.test.mjs /private/b.test.mjs'), "node --test a.test.mjs b.test.mjs");
  assert.equal(parsed('node --test --test-name-pattern "secret filter" /private/tools.test.mjs'), "node --test tools.test.mjs");
  assert.equal(parsed('node --require /private/setup.cjs /private/main.mjs secret'), "node main.mjs");
  assert.equal(parsed('node --input-type=module -e "secret();"'), "node -e");
  assert.equal(parsed('node --eval="secret();"'), "node --eval");
  assert.equal(parsed('node -c /private/main.cjs'), "node -c main.cjs");
  assert.equal(label({ command: ["C:\\Program Files\\nodejs\\node.exe", "--check", "C:\\private\\main.mjs"] }), "node.exe --check main.mjs");
});

test("完整文件和命令列表经过持久化及响应投影后不截断、不合并、不分摊耗时", () => {
  const files = Array.from({ length: 80 }, (_, index) => `module-${index}-${"x".repeat(130)}.mjs`);
  const changes = Object.fromEntries(files.map((name) => [`/private/repo/${name}`, { unified_diff: "secret-diff" }]));
  const item = (nativeItem) => simplifyToolExecutionRecord({ type: "event_msg", payload: {
    type: "item_completed", turn_id: "turn", started_at_ms: 120, completed_at_ms: 180, item: nativeItem,
  } });
  const patch = item({ type: "FileChange", id: "patch", changes });
  assert.equal(patch.description, "80 个文件");
  assert.deepEqual(patch.detailList, { kind: "files", items: files });
  const commands = Array.from({ length: 50 }, (_, index) => `node --check src/module-${index}.mjs`);
  const command = item({ type: "CommandExecution", id: "command",
    parsed_cmd: [{ type: "unknown", cmd: [...commands, commands[0]].join(" && ") }] });
  assert.equal(command.description, "51 条命令");
  assert.equal(command.detailList.items.length, 51);
  assert.equal(command.detailList.items.at(-1), "node --check module-0.mjs", "repeated commands stay visible");
  const ledger = createToolExecutionLedger();
  add(ledger, "call", { id: "outer", toolName: "exec", startedAt: 100 });
  add(ledger, "response", { responseId: "response" });
  recordToolExecution(ledger, patch);
  recordToolExecution(ledger, command);
  add(ledger, "result", { id: "outer", completedAt: 200 });
  const original = projectToolExecutions(ledger, "response");
  const json = JSON.stringify(ledger);
  assert.equal(json.includes("secret-diff"), false);
  assert.equal(json.includes("/private/repo"), false);
  const restored = projectToolExecutions(normalizeToolExecutionLedger(JSON.parse(json)), "response");
  assert.deepEqual(restored, original);
  assert.equal(restored.calls.length, 2, "file/command lists must not become extra tool calls");
  assert.equal(restored.calls[0].durationMs, 60);
  assert.equal(restored.calls[0].detailList.items.at(-1), files.at(-1));
});
