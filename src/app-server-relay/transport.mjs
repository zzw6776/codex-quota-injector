import { createReadStream, createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { SIDECAR_MODE_ENV, SIDECAR_UPSTREAM_STDIN_FD_ENV, SIDECAR_UPSTREAM_STDOUT_FD_ENV, PRIMARY_APP_SERVER_ENV } from "./contract.mjs";

function openSidecarUpstream() {
  if (process.env[SIDECAR_MODE_ENV] !== "1") return null;
  if (process.platform !== "darwin") {
    throw new Error("app-server 中继 sidecar 仅支持 macOS");
  }
  const stdinFd = inheritedDescriptor(SIDECAR_UPSTREAM_STDIN_FD_ENV);
  const stdoutFd = inheritedDescriptor(SIDECAR_UPSTREAM_STDOUT_FD_ENV);
  if (stdinFd === stdoutFd) throw new Error("app-server 中继 sidecar 管道描述符重复");
  const stdin = createWriteStream(null, { fd: stdinFd, autoClose: true });
  const stdout = createReadStream(null, { fd: stdoutFd, autoClose: true });
  return {
    stdin,
    stdout,
    close() {
      stdin.destroy();
      stdout.destroy();
    },
  };
}

function inheritedDescriptor(name) {
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value < 3) {
    throw new Error(`app-server 中继 sidecar 缺少有效的 ${name}`);
  }
  return value;
}

function pipeLines(input, output, transform) {
  input.setEncoding("utf8");
  let pending = "";
  input.on("data", (chunk) => {
    pending += chunk;
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const line = pending.slice(0, newline).replace(/\r$/, "");
      pending = pending.slice(newline + 1);
      const transformed = transform(line);
      if (transformed && typeof transformed === "object" && "directOutput" in transformed) {
        writeWithBackpressure(process.stdout, `${transformed.directOutput}\n`, input);
      } else if (transformed !== "") {
        writeWithBackpressure(output, `${transformed}\n`, input);
      }
    }
  });
  input.once("end", () => {
    if (pending) {
      const transformed = transform(pending.replace(/\r$/, ""));
      if (transformed && typeof transformed === "object" && "directOutput" in transformed) {
        writeWithBackpressure(process.stdout, transformed.directOutput, input);
      } else if (transformed !== "") {
        output.write(transformed);
      }
    }
    output.end();
  });
  input.once("error", (error) => {
    if (error.code !== "EPIPE") fail(error);
  });
  output.once("error", (error) => {
    if (error.code !== "EPIPE") fail(error);
  });
}

function pipeRaw(input, output) {
  input.on("data", (chunk) => writeWithBackpressure(output, chunk, input));
}

function writeWithBackpressure(output, chunk, input) {
  if (output.write(chunk)) return;
  input.pause();
  output.once("drain", () => input.resume());
}

async function runPassthrough(upstreamExecutable, args) {
  const env = { ...process.env, CODEX_CLI_PATH: upstreamExecutable };
  clearRelayEnvironment(env);
  delete env.CODEX_APP_SERVER_FORCE_CLI;
  delete env.CODEX_APP_SERVER_WS_URL;
  env.CODEX_CLI_PATH = upstreamExecutable;
  const child = spawn(upstreamExecutable, args, {
    env,
    stdio: "inherit",
    windowsHide: process.platform === "win32",
  });
  const stopForwardingSignals = forwardSignals(child);
  child.once("error", fail);
  child.once("exit", (code, signal) => {
    // Restore the default signal action before reproducing the child's exit.
    stopForwardingSignals();
    exitLikeChild(code, signal);
  });
}

function clearRelayEnvironment(env) {
  for (const key of [
    PRIMARY_APP_SERVER_ENV,
    "CODEX_QUOTA_RELAY_CONFIG",
    "CODEX_QUOTA_ROLE",
    "CODEX_QUOTA_UPSTREAM_CODEX_CLI",
    "CODEX_QUOTA_EXTRA_MODEL_SETTINGS",
    "CODEX_QUOTA_MODEL_CATALOG",
    "CODEX_QUOTA_RELAY_STATE",
    "CODEX_QUOTA_TOKEN_USAGE_EVENTS",
    "CODEX_QUOTA_BRIDGE_GENERATION",
    "CODEX_QUOTA_WSL_NATIVE",
    "CODEX_QUOTA_WSL_UPSTREAM_CODEX_CLI",
    "CODEX_QUOTA_WINDOWS_NATIVE",
    SIDECAR_MODE_ENV,
    SIDECAR_UPSTREAM_STDIN_FD_ENV,
    SIDECAR_UPSTREAM_STDOUT_FD_ENV,
  ]) {
    delete env[key];
  }
}

function forwardSignals(child) {
  const handlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      if (!child.killed) child.kill(signal);
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}

function forwardSidecarSignals(cleanup) {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      void cleanup().then(
        () => process.kill(process.pid, signal),
        (error) => fail(error),
      );
    });
  }
}

function exitLikeChild(code, signal) {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
}

function fail(error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

export { openSidecarUpstream, pipeLines, pipeRaw, runPassthrough, clearRelayEnvironment, forwardSignals, forwardSidecarSignals, exitLikeChild, fail };
