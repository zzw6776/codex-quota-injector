import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCodexCliExecutable } from "./platform.mjs";
import { getOpenAIShortContextRates } from "./token-pricing.mjs";
import packageJson from "../package.json" with { type: "json" };

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_LINE_LENGTH = 1024 * 1024;
const PROMPT = "只回复 OK。不要调用工具、读取文件或执行任何其他操作。";

// Each request gets a native official process and an empty home/work directory.
// Credentials travel over stdin only; the desktop auth.json and keychain are untouched.
export async function sendWakeupRequest(getCredentials, signal, {
  resolveExecutable = resolveCodexCliExecutable, spawnProcess = spawn, timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  signal.throwIfAborted();
  const executable = await resolveExecutable();
  signal.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "codex-quota-wakeup-"));
  let child;
  let childClosed;
  let onExit;
  let onAbort;
  const secrets = new Set();
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  const sanitize = (value) => {
    let text = String(value ?? "未知错误");
    for (const secret of secrets) text = text.replaceAll(secret, "[已隐藏凭据]");
    return text.slice(0, 500);
  };
  try {
    requestSignal.throwIfAborted();
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(CODEX_|OPENAI_|CHATGPT_)/i.test(key)) delete env[key];
    }
    env.CODEX_HOME = directory;
    env.HOME = directory;
    env.XDG_CONFIG_HOME = join(directory, "config");
    env.XDG_CACHE_HOME = join(directory, "cache");
    child = spawnProcess(executable, [
      "-c", 'cli_auth_credentials_store="ephemeral"',
      "-c", 'model_provider="openai"',
      "-c", `log_dir=${JSON.stringify(directory)}`,
      "-c", 'web_search="disabled"',
      "-c", "features.shell_tool=false",
      "-c", "features.multi_agent=false",
      "-c", "features.multi_agent_v2=false",
      "app-server",
    ], { cwd: directory, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    childClosed = new Promise((resolve) => child.once("close", resolve));
    onExit = () => child.kill("SIGKILL");
    process.once("exit", onExit);
    const pending = new Map();
    let nextId = 0;
    let failure = null;
    let threadId = null;
    let reply = "";
    let resolveCompletion;
    let rejectCompletion;
    const completion = new Promise((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    // A process may fail before turn/start reaches the completion wait.
    void completion.catch(() => undefined);
    const fail = (error) => {
      if (failure) return;
      failure = error;
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      rejectCompletion(error);
    };
    const send = (message) => {
      if (failure) throw failure;
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) fail(new Error("唤醒进程通信中断"));
      });
    };
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      try { send({ id, method, params }); } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
    const credentials = async (forceRefresh = false) => {
      const value = await getCredentials({ forceRefresh });
      secrets.add(value.accessToken);
      return value;
    };
    let refreshed = false;
    const handle = async (message) => {
      if (message.method && message.id != null) {
        if (message.method === "account/chatgptAuthTokens/refresh" && !refreshed) {
          refreshed = true;
          send({ id: message.id, result: await credentials(true) });
        } else {
          send({ id: message.id, error: { code: -32601, message: "唤醒不支持此交互" } });
          throw new Error("唤醒请求需要额外交互，已停止，请检查账号登录状态");
        }
        return;
      }
      if (message.id != null) {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        if (message.error) request.reject(new Error(sanitize(message.error.message)));
        else request.resolve(message.result);
        return;
      }
      if (!threadId || message.params?.threadId !== threadId) return;
      if (message.method === "item/completed" && message.params.item?.type === "agentMessage") {
        reply = sanitize(message.params.item.text);
      }
      if (message.method === "turn/completed") {
        const turn = message.params.turn;
        if (turn?.status !== "completed") {
          fail(new Error(sanitize(turn?.error?.message ?? `请求未完成：${turn?.status ?? "未知"}`)));
        } else {
          const finalItem = turn.items?.findLast((item) => item.type === "agentMessage");
          resolveCompletion(finalItem ? sanitize(finalItem.text) : reply);
        }
      }
    };
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.length > MAX_LINE_LENGTH) {
          fail(new Error("唤醒进程响应过大"));
          return;
        }
        if (!line.trim()) continue;
        try {
          void handle(JSON.parse(line)).catch(fail);
        } catch {
          fail(new Error("无法解析官方 Codex 唤醒响应"));
        }
      }
      if (buffer.length > MAX_LINE_LENGTH) fail(new Error("唤醒进程响应过大"));
    });
    // Drain diagnostics without persisting server output that may contain auth context.
    child.stderr.resume();
    child.on("error", (error) => fail(new Error(`无法启动官方 Codex：${error.code ?? "进程错误"}`)));
    child.stdin.on("error", () => fail(new Error("唤醒进程通信中断")));
    child.once("close", () => fail(new Error("唤醒进程已退出，请检查官方 Codex 版本")));
    onAbort = () => {
      fail(new Error(signal.aborted ? "唤醒已取消" : "唤醒超时，结果未知，请手动刷新额度确认"));
      child.kill("SIGKILL");
    };
    requestSignal.addEventListener("abort", onAbort, { once: true });
    if (requestSignal.aborted) onAbort();

    await rpc("initialize", {
      clientInfo: { name: "codex_quota_wakeup", version: packageJson.version },
      capabilities: { experimentalApi: true },
    });
    send({ method: "initialized", params: {} });
    await rpc("account/login/start", { type: "chatgptAuthTokens", ...await credentials() });
    const models = [];
    let cursor = null;
    do {
      const page = await rpc("model/list", { includeHidden: false, cursor });
      models.push(...(page?.data ?? []));
      cursor = page?.nextCursor ?? null;
    } while (cursor);
    const available = models.filter((model) => !model.hidden && model.model &&
      (!model.inputModalities || model.inputModalities.includes("text")));
    if (!available.length) throw new Error("此账号没有可用于唤醒的官方模型");
    // Compare known standard short-context input + output rates. The wakeup is
    // a fresh, tiny text request; API rates are a cost proxy, not OAuth billing.
    // Never silently fall back to the account's potentially expensive default.
    const priced = available.map((model) => ({ model, rates: getOpenAIShortContextRates(model.model) }))
      .filter((item) => item.rates)
      .sort((left, right) =>
        (left.rates.ordinaryInput + left.rates.output) - (right.rates.ordinaryInput + right.rates.output));
    const model = priced[0]?.model;
    if (!model) throw new Error("此账号可用模型均缺少价格配置，无法选择最低价唤醒模型，请更新注入器后重试");
    const efforts = model.supportedReasoningEfforts?.map((item) => item.reasoningEffort) ?? [];
    const effort = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
      .find((value) => efforts.includes(value)) ?? model.defaultReasoningEffort;
    const thread = await rpc("thread/start", {
      model: model.model,
      modelProvider: "openai",
      cwd: directory,
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      baseInstructions: PROMPT,
      developerInstructions: PROMPT,
    });
    threadId = thread?.thread?.id;
    if (!threadId) throw new Error("官方 Codex 未返回唤醒会话 ID");
    await rpc("turn/start", {
      threadId,
      model: model.model,
      effort,
      input: [{ type: "text", text: PROMPT }],
    });
    const response = await completion;
    if (!response) throw new Error("请求已结束但未收到模型回复，请手动检查额度");
    return { model: model.model, reply: response };
  } catch (error) {
    throw new Error(sanitize(error.message));
  } finally {
    if (onAbort) requestSignal.removeEventListener("abort", onAbort);
    if (child) {
      child.stdin.destroy();
      child.kill("SIGKILL");
      await childClosed;
    }
    if (onExit) process.removeListener("exit", onExit);
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      .catch(() => console.error("[wakeup] 临时运行目录清理失败"));
  }
}
