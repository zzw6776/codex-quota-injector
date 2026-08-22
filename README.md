# Codex Quota Injector

为 macOS 和 Windows 版 Codex 客户端动态注入多账号额度面板。程序没有独立界面，双击入口后会直接启动官方 Codex，并在后台完成注入。

## 功能

- 同时查看全部账号的 5 小时/周额度、重置时间、套餐和订阅到期时间；
- 一键切换账号，写入 Codex 官方凭据后自动重启客户端；
- 通过 OpenAI OAuth、Token/JSON、本机 Codex 登录或 API Key 添加账号；
- 一键将全部账号导出为可再次导入的 JSON 备份；
- 每 60 秒独立刷新全部 OAuth 账号额度，不受页面注入或重连影响；
- 外层百分比只显示 Codex 官方 app-server 额度，读取失败时保留最后一次成功值；
- 悬浮框内所有账号均显示账号接口刷新后写入本地账户库的额度缓存；
- 悬浮框为每个账号显示最后成功刷新时间；Token、额度或订阅刷新异常会保留旧额度并直接显示错误；
- 当前账号的 Token 由 Codex 管理并实时同步回账户库；非当前账号仅在不足 5 分钟、已过期或接口明确返回 401 时续期，切换前先完成凭证交接；
- OpenAI OAuth 等待状态提供“取消授权”，取消后立即关闭本地回调服务并恢复面板操作；
- OpenAI OAuth 使用客户端登记的固定回调地址 `http://localhost:1455/auth/callback`；
- macOS 和 Windows 的 Codex 客户端均支持 DeepSeek V4 Flash 与官方模型共存；
- macOS 使用原生无界面启动器接收 Finder 的重复打开事件；重复双击会接管旧注入器，Codex 已开放调试端口时保留当前客户端；
- 退出 Codex 后，后台注入工作进程与 macOS 原生入口都会同步退出，不残留后台进程；
- 不修改官方客户端，不依赖 Cockpit，不要求用户安装 Node.js。

## 安装与使用

### macOS

1. 从 GitHub Actions Artifacts 或 GitHub Releases 下载 `macos-universal.dmg`；
2. 将 `Codex Quota Injector.app` 拖入“应用程序”；
3. 双击 `Codex Quota Injector`，它会直接启动官方 Codex；
4. 额度入口显示在 Codex 左下角账号区域。

安装包同时覆盖 Apple Silicon 和 Intel Mac。当前自动构建使用 ad-hoc 签名，没有 Apple Developer ID 公证；首次打开若被 Gatekeeper 拦截，可在“系统设置 → 隐私与安全性”中允许打开。

### Windows

1. 从 GitHub Actions Artifacts 或 GitHub Releases 下载 `windows-x64-setup.exe`；
2. 运行安装程序；
3. 双击桌面或开始菜单中的 `Codex Quota Injector`；
4. 程序会直接启动 Microsoft Store 安装的 ChatGPT / Codex，并在后台注入额度面板。

Windows 安装包同时内置原生 Windows relay 和原生 WSL relay；安装后会根据 Codex 的运行模式自动选择，全程不需要联网或安装 Node.js。当前自动构建未配置 Authenticode 证书，Windows SmartScreen 可能提示未知发布者。

## 运行机制

启动器会：

1. macOS 原生启动器接收首次启动和重复双击事件，并唤起后台注入器；
2. 后台注入器获取本机单实例锁；重复启动时由旧实例交接并只重启注入器；如果旧版本返回无法识别的接管协议，确认端口占用者属于本项目后终止旧实例再接管，无法确认时退出；
3. 查找官方 Codex 安装位置；
4. Codex 已开放本地 CDP 调试端口时直接复用当前进程；仅在未开放调试端口时重启并以调试模式拉起；
5. 只在 `127.0.0.1:9229` 开启 Chromium 调试端口；
6. 连接 Codex 页面并注入额度组件；
7. 监听 Codex `auth.json` 变化，将当前账号轮换后的最新 Token 同步回独立账户库；
8. 在连接成功后停止目标查找轮询；
9. 在 Codex 退出前最后同步一次当前账号凭证，再结束后台注入工作进程；macOS 原生入口会在工作进程结束后同步退出。

macOS 支持 `/Applications/ChatGPT.app` 和旧版 `/Applications/Codex.app`。Windows 支持 Microsoft Store 的 `OpenAI.ChatGPT`、`OpenAI.Codex`、`ChatGPT.exe` 和 `Codex.exe`。

## 数据目录

项目拥有独立账户库，第一次启动且账户库为空时，可以从 `~/.antigravity_cockpit/` 一次性迁移已有 Codex 账号，迁移后不再依赖 Cockpit。

- macOS：`~/Library/Application Support/Codex Quota Injector/`
- Windows：`%APPDATA%\Codex Quota Injector\`

账号详情使用 AES-256-GCM 加密保存。OAuth 额度、订阅和账号信息来自 OpenAI 官方接口；CDP 仅绑定本机回环地址。

面板中的“导出全部”会在系统“下载”目录生成 JSON 文件。该文件包含完整 OAuth Token 或 API Key，属于明文敏感凭据，请仅存放在可信设备中并妥善保管；需要恢复时，可将文件内容粘贴到“Token / JSON”入口。

日志目录：

- macOS：`~/Library/Logs/Codex Quota Injector/injector.log`
- Windows：`%LOCALAPPDATA%\Codex Quota Injector\Logs\injector.log`

## 自动打包

GitHub Actions 工作流位于 `.github/workflows/build-packages.yml`：

- 每次提交到 `master`：读取 `package.json` 版本，自动构建对应版本的 macOS Universal DMG 和 Windows x64 Setup，创建或更新 `v版本号` 正式 Release、标记为 Latest，并同时上传到 Actions Artifacts；
- Linux job 会预构建 WSL SEA relay，并只把该中间产物交给 Windows 安装包；macOS DMG 不包含 Linux Node 或 WSL relay；
- 推送 `v*` 标签：标签必须与 `package.json` 版本一致，构建成功后更新同版本 GitHub Release；
- 支持在 Actions 页面手动触发。

自动打包不运行测试，安装后的实际功能由使用者手动确认。

## 本地开发

需要 Node.js 22 或更高版本：

```bash
npm install
npm run launch
```

也可以直接双击项目根目录中的开发版启动入口：

- macOS：`启动开发版.app`（Finder、QSpace Pro 均推荐）或 `启动开发版.command`
- Windows：`启动开发版.cmd`

脚本会先使用项目内或系统中的 Node.js 22 准备 relay，再隐藏启动注入器。普通 Windows 模式会在首次启动当前项目版本时原子生成版本化的原生 Windows SEA relay；源码开发版若要重建 WSL relay，需要在 `runtime/node-v22.23.1-linux-x64/bin/node` 准备本地 Linux Node。正式 Windows 安装包已经压缩内置构建好的 WSL relay，安装和运行均不需要该开发运行时。启动器按远端规则根据版本和运行模式协商是否接管已运行的注入器；旧版本协议无法识别时，会在确认旧进程属于本项目后终止旧进程并继续启动。它不会关闭官方 Codex，也不会保留 npm 或 PowerShell 前台窗口。启动日志位于 `%LOCALAPPDATA%\\Codex Quota Injector\\Logs\\launcher.log`，运行日志位于同目录的 `injector.log`。

其他命令：

```bash
npm run doctor
npm run read-quota
npm run inject
npm run preview
```

## 限制

- 必须通过 `Codex Quota Injector` 启动官方 Codex；普通方式启动的客户端没有 CDP 端口，无法注入；
- 账号切换会重启官方 Codex，当前任务由客户端自身恢复；
- API Key 账号可以保存和切换，但 ChatGPT 订阅额度接口不适用于 API Key；
- Codex 更新若修改账号区域的 DOM 或无障碍标签，需要同步更新 `src/widget.mjs` 的定位规则。
