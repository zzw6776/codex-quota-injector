# Codex Quota Injector

为 macOS 和 Windows 版 Codex 客户端动态注入多账号额度面板。程序没有独立界面，双击入口后会直接启动官方 Codex，并在后台完成注入。

## 功能

- 同时查看全部账号的 5 小时/周额度、重置时间、套餐和订阅到期时间；
- 一键切换账号，写入 Codex 官方凭据后自动重启客户端；
- 通过 OpenAI OAuth、Token/JSON、本机 Codex 登录或 API Key 添加账号；
- 一键将全部账号导出为可再次导入的 JSON 备份；
- 每 60 秒后台刷新全部 OAuth 账号额度；
- 单实例运行，重复双击不会产生多个注入进程；
- 退出 Codex 后，后台注入进程同步退出；
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

当前自动构建未配置 Authenticode 证书，Windows SmartScreen 可能提示未知发布者。

## 运行机制

启动器会：

1. 获取本机单实例锁；
2. 查找官方 Codex 安装位置；
3. 如果当前 Codex 没有本地 CDP 调试端口，则先关闭再重新启动；
4. 只在 `127.0.0.1:9229` 开启 Chromium 调试端口；
5. 连接 Codex 页面并注入额度组件；
6. 在连接成功后停止目标查找轮询；
7. 在 Codex 退出后结束自身进程。

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

脚本会切换到项目目录，首次运行时自动安装依赖，停止已运行的安装版或开发版注入器，然后以前台方式启动当前开发版；它不会关闭官方 Codex。关闭终端窗口即可停止注入器。

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
