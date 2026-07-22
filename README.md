# Codex Quota Injector

给 macOS Codex 客户端动态注入多账号额度面板，不修改 `ChatGPT.app`、不解包 `app.asar`、不破坏 OpenAI 签名。

面板支持：

- 同时查看所有账号的 5 小时/周额度、重置时间、套餐和订阅到期时间；
- 一键切换账号，写入 Codex 官方 `auth.json` 与 macOS Keychain 后自动重启客户端；
- 通过 OpenAI OAuth、Token/JSON、本机 Codex 登录或 API Key 添加账号；
- 点击额度标签固定展开，或直接从标签向上移动鼠标进入悬浮框；
- 每 60 秒后台刷新全部 OAuth 账号的额度。

## 使用

双击 `启动 Codex 额度悬浮框.app`（推荐）。也可以在终端执行 `./start-codex-quota.command`。启动器会：

1. 正常退出当前 Codex；
2. 仅在本机 `127.0.0.1:9229` 开启 Chromium 调试端口；
3. 重新启动官方 `/Applications/ChatGPT.app`；
4. 启动后台注入器，在左下角用户名右侧显示当前账号的 `xx%`；同时存在 5 小时与周窗口时显示 `xx% · xx%`；
5. 鼠标悬停或点击额度标签，查看全部账号并执行添加、刷新和切换。

注入成功后会复用现有 CDP 连接，不再重复查找 Codex target。退出 Codex 后，后台注入器会在连接断开时同步退出；LaunchAgent 不会自动将它重新拉起。重复打开启动器时，会先停止已有注入器，再启动唯一的新实例。

后台进程在 macOS“活动监视器”中显示为 `Codex Quota Injector`。启动器会为 Codex 内置 Node 创建同名硬链接，因此不复制二进制文件，并会在每次启动时重新生成以跟随 Codex 更新。

停止注入器可在终端执行 `./stop-injector.command`。悬浮框在刷新或重启 Codex 后消失。

## 数据与安全

- 本项目拥有独立的账户库，运行时不依赖 Cockpit 的源码、进程、安装包或数据目录。
- 独立数据目录为 `~/Library/Application Support/Codex Quota Injector/`。
- 第一次启动且独立账户库为空时，会从 `~/.antigravity_cockpit/` 复制一次已有账号；复制完成后即独立运行，Cockpit 可关闭或卸载。
- 账号详情使用 AES-256-GCM 加密保存，账户文件、索引和本地密钥权限均收紧为当前用户可读写。
- OAuth 额度来自 ChatGPT 官方 `backend-api/wham/usage`，订阅信息来自官方 accounts/check 与 subscriptions 接口。
- 没有已添加账号时，当前账号额度会降级使用客户端自带的 `codex app-server` 正式协议 `account/rateLimits/read`。
- CDP 只绑定到 `127.0.0.1`，不会监听局域网地址。
- 不修改 `/Applications/ChatGPT.app`，客户端自动更新不受影响。

API Key 账号可以保存和切换，但 ChatGPT 订阅额度接口不适用于 API Key，因此不会显示订阅额度。

## 添加与切换账号

打开额度悬浮框后，可选择：

1. `OpenAI OAuth`：在系统浏览器完成授权，最适合日常添加账号；
2. `导入本机登录`：读取当前 `~/.codex/auth.json`；
3. `Token / JSON`：支持完整 `auth.json`、tokens JSON、access token 或 refresh token；
4. `API Key`：保存一个 API Key 账号。

切换账号会正常退出并重启 Codex，当前任务由客户端自行恢复。后台注入器不会重启，因此新客户端打开后悬浮框会自动重新注入。

## CLI

```bash
npm run doctor
npm run read-quota
npm run inject
```

日志位于 `~/Library/Logs/Codex Quota Injector/injector.log`。

## 限制

必须通过 `start-codex-quota.command` 启动 Codex，普通方式启动的客户端没有 CDP 端口，无法动态注入。客户端更新若改变左下角账户按钮的无障碍标签，需要同步调整 `src/widget.mjs` 中的定位规则。OAuth 登录依赖系统浏览器能够访问 OpenAI 授权页面。
