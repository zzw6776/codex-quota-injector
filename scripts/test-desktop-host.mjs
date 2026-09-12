import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

// The fixture has no account, model or daily Codex dependency. Browser Use opens
// it through a loopback HTTP origin because agent-driven file:// navigation is
// rejected before the page loads. An observer still verifies visible state and
// downloaded bytes instead of trusting the model's reply.
export function desktopFixture({ artifactHref } = {}) {
  const marker = `DESKTOP_${randomBytes(8).toString("hex")}`;
  const artifact = `ARTIFACT_${marker}\n`;
  const download = artifactHref ?? `data:text/plain;charset=utf-8,${encodeURIComponent(artifact)}`;
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Codex 本地宿主回归</title>
    <style>body{font:18px system-ui;max-width:780px;margin:50px auto;padding:20px}input{width:100%;padding:12px;font:inherit;box-sizing:border-box}button{margin-top:20px;padding:12px 25px;font:inherit}code,pre{display:block;padding:20px;background:#eef1f7;white-space:pre-wrap;overflow-wrap:anywhere}</style>
    <h1>桌面工具回归材料</h1><p>读取下面的随机标记，输入并发送一次。</p><code id="marker">${marker}</code>
    <form id="form"><label for="value">测试标记</label><input id="value" autocomplete="off"><button id="submit">发送</button></form>
    <p id="result" role="status"></p><a id="download" href="${download}" download="codex-fixture.txt">下载测试产物</a>
    <h2>可独立读取的操作记录</h2><pre id="evidence">{"submissions":[]}</pre>
    <script>const marker=${JSON.stringify(marker)};const state={submissions:[]};document.querySelector("#form").onsubmit=e=>{e.preventDefault();const value=document.querySelector("#value").value;if(value!==marker){document.querySelector("#result").textContent="标记不匹配";return}state.submissions.push({value,at:new Date().toISOString()});document.querySelector("#evidence").textContent=JSON.stringify(state);document.querySelector("#result").textContent="已收到"};</script></html>`;
  return { marker, artifact, html, dataUrl: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` };
}

export async function startDesktopFixtureServer() {
  const fixture = desktopFixture({ artifactHref: "/artifact" });
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
    if (request.method !== "GET") {
      response.writeHead(405, { ...headers, allow: "GET" }); response.end("Method Not Allowed"); return;
    }
    if (pathname === "/") {
      response.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'" });
      response.end(fixture.html); return;
    }
    if (pathname === "/artifact") {
      response.writeHead(200, { ...headers, "content-type": "text/plain; charset=utf-8",
        "content-disposition": 'attachment; filename="codex-fixture.txt"' });
      response.end(fixture.artifact); return;
    }
    response.writeHead(404, headers); response.end("Not Found");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const url = `http://127.0.0.1:${server.address().port}/`;
  let closed = false;
  return { fixture, url, artifactUrl: new URL("artifact", url).href, server,
    async close() {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = new Set(process.argv.slice(2));
  for (const arg of args) if (arg !== "--serve") throw new Error(`未知参数 ${arg}`);
  const directory = resolve(import.meta.dirname, "../.runtime/test-results");
  await mkdir(directory, { recursive: true });
  const hosted = args.has("--serve") ? await startDesktopFixtureServer() : null;
  const fixture = hosted?.fixture ?? desktopFixture();
  const pagePath = join(directory, "desktop-host-page.html");
  const manifestPath = join(directory, "desktop-host-fixture.json");
  await writeFile(pagePath, fixture.html);
  const manifest = { marker: fixture.marker, artifact: fixture.artifact, pagePath,
    url: hosted?.url ?? null, createdAt: new Date().toISOString() };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(JSON.stringify({ pagePath, manifestPath, url: hosted?.url ?? null,
    instruction: hosted
      ? "保持此命令运行，用实际 computer use 打开 url，完成一次输入和发送并下载产物；核对后按 Ctrl-C 停止本次回环服务。"
      : "文件已生成，但 Browser Use 会拦截自动 file:// 导航。请改用 --serve，以受控的 127.0.0.1 HTTP 地址验收。" }, null, 2));
  if (hosted) {
    await new Promise(resolveStop => {
      let stopping = false;
      const stop = async () => {
        if (stopping) return;
        stopping = true;
        process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
        await hosted.close(); resolveStop();
      };
      process.once("SIGINT", stop); process.once("SIGTERM", stop);
    });
  }
}
