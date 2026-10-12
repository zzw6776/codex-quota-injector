import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const escape = value => String(value ?? "").replace(/[&<>"']/g, character =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const STEPS = ["downloading", "verifying", "waiting", "installing", "launching", "success"];
const LABELS = ["下载安装包", "校验安装包", "确认任务已结束并落盘", "替换正式版本", "启动正式版本", "更新成功"];

export function updateWindowFragment(state) {
  const current = STEPS.indexOf(state.status === "failed" ? state.failedStage
    : state.status === "cancelled" ? state.cancelledStage : state.status);
  const confirm = state.status === "confirm";
  const finished = ["success", "failed", "cancelled"].includes(state.status);
  const percent = state.total ? Math.min(100, Math.floor(state.received / state.total * 100)) : 0;
  return `<h1>更新 Codex Quota Injector</h1><div class="versions">${escape(state.currentVersion)}${state.mode === "dev" ? " · dev" : ""} → ${escape(state.version)} · 正式版</div>
    <div class="status ${escape(state.status)}">${escape(state.message)}</div>
    ${confirm ? '<p>确认后自动下载、替换正式应用并打开正式版。正在运行的任务结束并保存后，才会重启 Codex。</p>' :
      `<ol>${STEPS.map((step, index) => `<li class="${index < current || state.status === "success" ? "done" : index === current ? "current" : ""}">${LABELS[index]}</li>`).join("")}</ol>`}
    ${state.status === "downloading" ? `<div class="meter"><div style="width:${percent}%"></div></div><p>${percent}% · ${(Number(state.received) / 1048576).toFixed(1)} / ${(Number(state.total) / 1048576).toFixed(1)} MB</p>` : ""}
    ${state.status === "success" ? '<p>正式版已启动，窗口将保留，直到你手动关闭。</p>' : ""}
    <div class="actions">${confirm ? '<button onclick="action(\'close\')">取消</button><button class="primary" onclick="action(\'confirm\')">立即更新</button>' : `${finished ? "" : `<button class="danger" onclick="action('terminate')" ${state.terminating ? "disabled" : ""}>${state.terminating ? "终止中…" : "终止更新"}</button>`}<button onclick="action('close')" ${finished ? "" : "disabled"}>关闭</button>`}</div>`;
}

export function updateWindowHtml() {
  // ES5/XHR also works in the native Windows WebBrowser control. No user browser
  // profile, registry changes, external scripts or CDN are required.
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="X-UA-Compatible" content="IE=edge"><title>Codex Quota Injector 更新</title><style>
    body{margin:0;background:#f5f6f8;color:#25282b;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{padding:26px;max-width:520px;margin:auto}h1{font-size:20px;margin:0 0 12px}.versions{color:#73777e;font-size:12px}.status{font-size:16px;margin:24px 0 16px}.success,.done{color:#238348}.failed{color:#b43c34}.current{font-weight:600;color:#238348}p{line-height:1.7;color:#73777e}ol{padding-left:24px}li{line-height:2.2;color:#92979e}.actions{text-align:right;margin-top:22px}button{padding:9px 16px;margin-left:8px;border:1px solid #d1d5da;border-radius:8px;background:#fff;font:inherit;cursor:pointer}button:disabled{opacity:.45;cursor:default}.primary{background:#238348;border-color:#238348;color:white}.meter{height:6px;border-radius:3px;background:#dfe4e0}.meter div{height:6px;background:#238348;border-radius:3px}
    </style></head><body><main id="content">正在读取更新状态…</main><script>
    var previous='';var posting=false;var ready=false;var acknowledging=false;var root=location.pathname.slice(0,-1);
    function request(method,path,done){var xhr=new XMLHttpRequest();xhr.open(method,root+path,true);xhr.onreadystatechange=function(){if(xhr.readyState===4)done(xhr.status,xhr.responseText);};xhr.send(null);}
    function acknowledge(){if(ready||acknowledging)return;acknowledging=true;request('POST','/ready',function(status){acknowledging=false;ready=status===200;});}
    function refresh(){request('GET','/fragment',function(status,html){if(status===200){if(html!==previous){previous=html;document.getElementById('content').innerHTML=html;}if(window.requestAnimationFrame)window.requestAnimationFrame(acknowledge);else setTimeout(acknowledge,0);}});}
    function action(name){if(posting)return;posting=true;request('POST','/'+name,function(status){posting=false;if(name==='close'&&status===200)window.close();else refresh();});}
    refresh();setInterval(refresh,750);
    </script></body></html>`;
}

export async function startUpdateWindowServer({ state, confirm, close, terminate = () => {}, show = () => {}, port = 0 }) {
  const token = randomBytes(24).toString("hex");
  const prefix = `/${token}`;
  let focus = false, windowReady = false, closingRequested = false;
  const server = createServer(async (request, response) => {
    const origin = request.headers.origin;
    const expected = `127.0.0.1:${server.address().port}`;
    if (request.headers.host !== expected || origin && origin !== `http://${expected}` ||
        !request.url.startsWith(`${prefix}/`)) { response.writeHead(403); response.end(); return; }
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const path = request.url.slice(prefix.length);
    if (closingRequested && request.method === "POST") { response.writeHead(409); response.end(); return; }
    try {
      if (request.method === "GET" && path === "/") {
        response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(updateWindowHtml());
      } else if (request.method === "GET" && path === "/fragment") {
        response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(updateWindowFragment(state()));
      } else if (request.method === "GET" && path === "/state") {
        response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ ...state(), windowReady }));
      } else if (request.method === "POST" && path === "/ready") {
        windowReady = true; response.end("ok");
      } else if (request.method === "GET" && path === "/focus") {
        response.end(focus ? "show" : ""); focus = false;
      } else if (request.method === "POST" && path === "/show") {
        focus = true; show(); response.end("ok");
      } else if (request.method === "POST" && path === "/confirm") {
        confirm(); response.end("ok");
      } else if (request.method === "POST" && path === "/terminate") {
        terminate(); response.writeHead(202); response.end("ok");
      } else if (request.method === "POST" && path === "/close") {
        if (!["confirm", "success", "failed", "cancelled"].includes(state().status)) { response.writeHead(409); response.end(); return; }
        closingRequested = true;
        response.end("ok"); setTimeout(close, 100);
      } else { response.writeHead(404); response.end(); }
    } catch (error) { response.writeHead(409); response.end(escape(error.message)); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return { url: `http://127.0.0.1:${server.address().port}${prefix}/`, server,
    invalidateReady() { windowReady = false; },
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
