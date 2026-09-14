#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { isIPv4, createConnection, createServer } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const options = parseOptions(process.argv.slice(2));
let browser = null;
let server = null;
let idleTimer = null;
let stopping = false;
const sockets = new Set();

try {
  browser = spawn(options.browser, options.browserArgs, {
    env: process.env,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  browser.stderr.pipe(process.stderr);
  browser.once("error", fail);
  const browserPort = await readBrowserPort(browser, options.profile);
  server = createServer((socket) => {
    clearTimeout(idleTimer);
    sockets.add(socket);
    const upstream = createConnection(browserPort, "127.0.0.1");
    socket.pipe(upstream).pipe(socket);
    const close = () => {
      sockets.delete(socket);
      socket.destroy();
      upstream.destroy();
      scheduleIdleStop();
    };
    socket.once("error", close);
    socket.once("close", close);
    upstream.once("error", close);
    upstream.once("close", close);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, options.listenHost, resolve);
  });
  const address = server.address();
  await writeFile(join(options.profile, "CodexBrowserBridge.json"), `${JSON.stringify({
    host: options.listenHost,
    port: address.port,
  })}\n`);
  browser.once("exit", () => stop(0));
  process.stdin.resume();
  process.stdin.once("end", () => stop(0));
  process.once("SIGINT", () => stop(0));
  process.once("SIGTERM", () => stop(0));
  scheduleIdleStop(15_000);
} catch (error) {
  await fail(error);
}

function scheduleIdleStop(delay = 5_000) {
  clearTimeout(idleTimer);
  if (sockets.size === 0) idleTimer = setTimeout(() => stop(0), delay);
}

async function stop(exitCode) {
  if (stopping) return;
  stopping = true;
  clearTimeout(idleTimer);
  for (const socket of sockets) socket.destroy();
  if (server) await new Promise(resolve => server.close(resolve)).catch(() => undefined);
  if (browser && browser.exitCode == null && browser.signalCode == null) {
    const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    await execFileAsync(taskkill, ["/PID", String(browser.pid), "/T", "/F"], {
      windowsHide: true,
      timeout: 5_000,
    }).catch(() => browser.kill());
  }
  process.exitCode = exitCode;
}

async function fail(error) {
  process.stderr.write(`${error?.stack ?? error}\n`);
  await stop(1);
}

async function readBrowserPort(child, profile) {
  const path = join(profile, "DevToolsActivePort");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null || child.signalCode != null) {
      throw new Error(`Windows 测试浏览器提前退出 (${child.exitCode ?? child.signalCode})`);
    }
    const port = Number((await readFile(path, "utf8").catch(() => "")).split("\n")[0]);
    if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Windows 测试浏览器未在 10 秒内写出 DevToolsActivePort");
}

function parseOptions(args) {
  const separator = args.indexOf("--");
  if (separator < 0) throw new Error("浏览器桥接参数缺少 -- 分隔符");
  const values = { browserArgs: args.slice(separator + 1) };
  for (const argument of args.slice(0, separator)) {
    const index = argument.indexOf("=");
    const key = index < 0 ? argument : argument.slice(0, index);
    const value = index < 0 ? "" : argument.slice(index + 1);
    if (key === "--browser") values.browser = value;
    else if (key === "--profile") values.profile = value;
    else if (key === "--listen-host") values.listenHost = value;
    else throw new Error(`未知浏览器桥接参数 ${key}`);
  }
  if (!values.browser || !values.profile || !isIPv4(values.listenHost) || !values.browserArgs.length) {
    throw new Error("浏览器桥接参数不完整");
  }
  return values;
}
