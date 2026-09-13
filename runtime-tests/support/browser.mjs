import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CdpClient } from "../../src/cdp-client.mjs";
import { widgetInstallExpression, widgetUpdateExpression } from "../../src/widget.mjs";
import { waitFor } from "../../test/helpers.mjs";
import { isolatedEnv, sandboxCommand, stopChild, ROOT } from "./offline-runtime.mjs";

export const SHADOW = 'document.getElementById("codex-quota-injector-root").shadowRoot';
export function fixtureData(overrides = {}) {
  return {
    version: "test", currentAccountId: "account-1",
    accounts: [{ id: "account-1", email: "fixture@example.test", current: true, authMode: "oauth", authStatus: "active", planType: "plus",
      canTransfer: true, canTemporaryTransfer: true,
      windows: [{ label: "5h", remainingPercent: 77 }], wakeup: { enabled: false, times: ["08:00"] } }],
    windows: [{ label: "5h", remainingPercent: 77 }], operation: null,
    context: { status: "applied", overriddenCount: 1, models: [{ slug: "fixture-model", displayName: "Fixture Model", overridden: true,
      defaultContextWindow: 128000, defaultMaxContextWindow: 128000, effectiveContextWindow: 256000, effectiveMaxContextWindow: 256000 }] },
    deepSeek: { enabled: false, apiKey: "fixture-key", supported: true, balance: { available: true, items: [] } },
    extraModels: { supported: true, platforms: [] }, tokenUsage: { status: "ready", turns: [] },
    ...overrides,
  };
}

export const FIXTURE_HTML = `<!doctype html><html class="electron-dark"><head><meta charset="UTF-8"><style>
  *{box-sizing:border-box}body{margin:0;font:14px system-ui;background:#202127;color:#eee}
  #profile-row{position:fixed;bottom:12px;left:12px;width:268px;display:flex;align-items:center;gap:8px}
  #profile{height:32px;flex:1}#native{position:fixed;left:310px;right:20px;bottom:20px;display:flex;gap:10px}
  #composer{flex:1;min-height:40px}#conversation{margin:80px 40px 150px 330px;height:400px;overflow:auto}
  article{margin:20px 0}.answer{min-height:50px}button{cursor:pointer}
  </style></head><body>
  <div id="profile-row"><button id="profile" aria-label="Open profile menu">Fixture profile</button></div>
  <section id="conversation"><article data-content-search-turn-key="turn-a"><div class="answer">答案 A</div></article><article data-content-search-turn-key="turn-b"><div class="answer">答案 B</div></article></section>
  <form id="native"><textarea id="composer" aria-label="Message"></textarea><button id="send" type="submit">发送</button><button id="native-tool" type="button">工具</button></form>
  <script>window.nativeMessages=[];window.nativeToolClicks=0;document.getElementById('native').onsubmit=e=>{e.preventDefault();nativeMessages.push(document.getElementById('composer').value)};document.getElementById('native-tool').onclick=()=>nativeToolClicks++;</script>
  </body></html>`;

export async function browserExecutable() {
  const candidates = [process.env.CODEX_TEST_BROWSER,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    process.platform === "win32" && join(process.env.PROGRAMFILES ?? "", "Google", "Chrome", "Application", "chrome.exe"),
    process.platform === "win32" && join(process.env["PROGRAMFILES(X86)"] ?? "", "Google", "Chrome", "Application", "chrome.exe"),
    process.platform === "win32" && join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
    process.platform === "win32" && join(process.env.PROGRAMFILES ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
    process.platform === "win32" && join(process.env["PROGRAMFILES(X86)"] ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
  ].filter(Boolean);
  let executable;
  for (const path of candidates) { try { await access(path); executable = path; break; } catch {} }
  assert.ok(executable, "BLOCKED: 本平台需要 Chrome/Edge；用 CODEX_TEST_BROWSER 指定测试浏览器");
  return executable;
}

export function browserLaunchArguments(directory, platform = process.platform) {
  return [
    "--headless",
    "--no-sandbox",
    "--disable-gpu",
    "--no-proxy-server",
    "--remote-debugging-port=0",
    `--user-data-dir=${directory}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    ...(platform === "darwin" ? ["--use-mock-keychain"] : []),
    "--window-size=1280,900",
    "about:blank",
  ];
}

export async function startBrowser(t) {
  const executable = await browserExecutable();
  const directory = await mkdtemp(join(tmpdir(), "quota-browser-fixture-"));
  let stderr = "";
  // macOS cannot nest Chromium's renderer sandbox inside this test's Seatbelt
  // network sandbox. This disposable browser also uses Chromium's macOS mock
  // keychain so a temporary profile never reads or prompts for the user's keychain.
  const launchArguments = browserLaunchArguments(directory);
  const command = sandboxCommand(executable, launchArguments);
  const child = spawn(command.executable, command.args, { env: isolatedEnv(directory), stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-8000); });
  const clients = [];
  t.after(async () => {
    try {
      if (clients[0]?.isConnected) {
        const target = join(ROOT, `.runtime/test-results/browser-${createHash("sha256").update(t.name).digest("hex").slice(0, 12)}.png`);
        await mkdir(join(ROOT, ".runtime/test-results"), { recursive: true });
        const screenshot = await clients[0].request("Page.captureScreenshot").catch(() => null);
        if (screenshot) { await writeFile(target, Buffer.from(screenshot.data, "base64")); t.diagnostic(`浏览器证据 ${target}`); }
      }
    } finally {
      for (const client of clients) client.close();
      await stopChild(child);
      await rm(directory, { recursive: true, force: true });
    }
    if (stderr) {
      await mkdir(join(ROOT, ".runtime/test-results"), { recursive: true });
      await writeFile(join(ROOT, `.runtime/test-results/browser-${createHash("sha256").update(t.name).digest("hex").slice(0, 12)}.log`), stderr);
    }
  });
  const port = await waitFor(async () => {
    if (child.exitCode != null) throw new Error(`测试浏览器退出：${stderr}`);
    try { return Number((await readFile(join(directory, "DevToolsActivePort"), "utf8")).split("\n")[0]); } catch { return null; }
  }, { timeoutMs: 10000 });
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
  const client = new CdpClient(targets.find(x => x.type === "page" && x.url === "about:blank").webSocketDebuggerUrl);
  await client.connect();
  clients.push(client);
  t.diagnostic(`测试浏览器 ${(await client.request("Browser.getVersion")).product}`);
  await client.request("Page.enable");
  await client.request("Runtime.enable");
  await client.request("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  const { frameTree } = await client.request("Page.getFrameTree");
  await client.request("Page.setDocumentContent", { frameId: frameTree.frame.id, html: FIXTURE_HTML });
  await client.evaluate(widgetInstallExpression());
  await client.evaluate(widgetUpdateExpression(fixtureData()));
  const settled = () => client.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
  await settled();
  const nodeExpression = (selector, shadow = true) => `${shadow ? SHADOW : "document"}.querySelector(${JSON.stringify(selector)})`;
  return { client, child, port, directory, launchArguments, settled,
    async click(selector, { shadow = true } = {}) {
      const rect = await client.evaluate(`(() => { const el=${nodeExpression(selector,shadow)}; if(!el)throw Error('missing '+${JSON.stringify(selector)}); el.scrollIntoView({block:'nearest'}); const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height,disabled:el.disabled}; })()`);
      assert.ok(rect.width > 0 && rect.height > 0, `不可点击 ${selector}`);
      await client.request("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y });
      await client.request("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
      await client.request("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
      await settled();
    },
    async fill(selector, text, { shadow = true } = {}) {
      await client.evaluate(`(() => {const el=${nodeExpression(selector,shadow)};el.focus();el.select();})()`);
      await client.request("Input.insertText", { text });
    },
    async value(selector, property = "textContent", shadow = true) {
      return client.evaluate(`${nodeExpression(selector,shadow)}?.[${JSON.stringify(property)}] ?? null`);
    },
    async update(data) { await client.evaluate(widgetUpdateExpression(data)); await settled(); },
    async drain() { return client.evaluate("window.__codexQuotaWidget.drainActions()"); },
  };
}
