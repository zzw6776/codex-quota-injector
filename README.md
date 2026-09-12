# Codex Quota Injector

为 macOS 和 Windows 版 Codex 客户端动态注入多账号额度面板。程序没有独立界面，双击入口后会直接启动官方 Codex，并在后台完成注入。

## 功能

- 同时查看全部账号的 5 小时/周额度、重置时间、套餐和订阅到期时间；
- 一键切换账号，写入 Codex 官方凭据后自动重启客户端；
- 通过 OpenAI OAuth、Token/JSON、本机 Codex 登录或 API Key 添加账号；
- 一键将全部账号导出为可再次导入的 JSON 备份；
- 每 60 秒独立刷新全部 OAuth 账号额度，不受页面注入或重连影响；
- 每个 OAuth 账号可独立设置多个每日唤醒时刻，也可手动立即唤醒，包括当前未登录到客户端的已保存账号；
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

1. 从 GitHub Actions Artifacts 或 GitHub Releases 下载对应架构的安装包：Apple Silicon 选择 `macos-arm64.dmg`，Intel Mac 选择 `macos-x64.dmg`；
2. 将 `Codex Quota Injector.app` 拖入“应用程序”；
3. 双击 `Codex Quota Injector`，它会直接启动官方 Codex；
4. 额度入口显示在 Codex 左下角账号区域。

macOS 安装包按架构独立构建，不再合并为 Universal DMG。当前自动构建使用 ad-hoc 签名，没有 Apple Developer ID 公证；首次打开若被 Gatekeeper 拦截，可在“系统设置 → 隐私与安全性”中允许打开。

### Windows

1. 从 GitHub Actions Artifacts 或 GitHub Releases 下载 `Codex-Quota-Injector-版本号-windows-x64-Setup.exe`；
2. 运行安装程序；
3. 双击桌面或开始菜单中的 `Codex Quota Injector`；
4. 程序会直接启动 Microsoft Store 安装的 ChatGPT / Codex，并在后台注入额度面板。

Windows 安装包同时内置原生 Windows relay 和原生 WSL relay；安装后会根据 Codex 的运行模式自动选择，全程不需要联网或安装 Node.js。当前自动构建未配置 Authenticode 证书，Windows SmartScreen 可能提示未知发布者。

## 运行机制

启动器会：

1. macOS 原生启动器接收首次启动和重复双击事件，并唤起后台注入器；
2. 后台注入器获取本机单实例锁；重复启动时由旧实例交接并只重启注入器；如果旧版本返回无法识别的接管协议，确认端口占用者属于本项目后终止旧实例再接管，无法确认时退出；
3. 查找官方 Codex 安装位置；
4. Codex 的本地 CDP 调试端口与所需模型中继均就绪时复用当前进程；缺少调试端口或中继配置、协议尚未生效时重启并重新加载；
5. 只在 `127.0.0.1:9229` 开启 Chromium 调试端口；
6. 连接 Codex 页面并注入额度组件；
7. 监听 Codex `auth.json` 变化，将当前账号轮换后的最新 Token 同步回独立账户库；
8. 在连接成功后停止目标查找轮询；
9. 在 Codex 退出前最后同步一次当前账号凭证，再结束后台注入工作进程；macOS 原生入口会在工作进程结束后同步退出。

macOS 支持 `/Applications/ChatGPT.app` 和旧版 `/Applications/Codex.app`。Windows 支持 Microsoft Store 的 `OpenAI.ChatGPT`、`OpenAI.Codex`、`ChatGPT.exe` 和 `Codex.exe`。

定时刷新官方模型目录只更新缓存，不重启 Codex。手动刷新在需要重新加载模型中继时会重启；修改模型注入配置、上下文覆盖或切换账号也会重启。

## 定时唤醒

在账号额度面板顶部点击时钟图标 `◷`（定时任务），进入与 DeepSeek、额外模型、模型上下文并列的“每日唤醒”独立设置页。所有 OAuth 账号直接平铺展示，每个账号均可独立添加一个或多个 24 小时时刻（例如 `08:00`、`13:00`、`18:00`），勾选“开启每日定时唤醒”并保存，也可点击该账号的“立即唤醒”。各账号的编辑互不影响，返回账号额度或关闭面板会丢弃未保存编辑。时间按电脑本地时区每天重复，设置及最近一次结果保存在加密账号库中。API Key 账号不提供此功能。

账号卡片第一行的“唤醒”胶囊按钮放在倒数第二位（套餐标签之前），与切换、移除按钮风格一致：紫色点亮表示已开启每日唤醒，灰色表示未开启。鼠标停留 300ms 后，仅显示配置时间，以及最近一次唤醒的具体执行时间和成功状态；尚未执行时显示对应提示。点击可打开设置页并定位到对应账号。切换按钮简写为“切换”，鼠标停留 300ms 后显示完整文字“切换到此账号”。是否点亮表示定时开关，执行是否成功以悬浮结果为准。

“立即唤醒”无需开启定时，会用该账号通过独立的官方 Codex 进程发送一句简短消息。进程使用临时目录和仅存在于内存中的登录凭据，不切换客户端账号、不重启客户端，也不将唤醒对话加入日常任务。手动和定时唤醒均从该账号官方目录的可用文本模型中，按项目内已核对的[官方标准 API 价格](https://developers.openai.com/api/docs/pricing)（短上下文非缓存输入与输出单价之和）选择最低价模型，推理强度取其支持的最低档。当前价格表中最低价为 `gpt-5.6-luna`，该账号没有此模型时按其余已知价格选择；模型均无价格配置时停止并提示更新，不回退到默认模型。API 单价仅用于成本排序，不代表 OAuth 订阅额度的实际扣减规则；调用会产生模型用量。

定时检查间隔为 15 秒，允许一分钟以内的检查延迟；检查间隔超过一分钟时跳过中断期间的计划。程序关闭或长时间休眠后不补发错过的时刻。同一时刻的多个账号依次执行；同一账号仍在排队或执行时，跳过重叠时刻。每天每个时刻最多自动尝试一次，失败或超时不自动重试。修改设置不会重新执行当天已尝试的时刻。关闭 Codex 会同时停止注入器和唤醒功能。

手动确认时，可以先进入“每日唤醒”页，在某个非当前账号卡片中点击“立即唤醒”，查看请求状态、所用模型、回复及额度刷新结果，再确认该账号的重置时间是否开始新一轮计时。随后设置一个将来的时刻并保存，返回账号额度确认“唤醒”文字点亮及悬浮信息更新，保持 Codex 和电脑运行，确认定时结果及重新打开程序后的设置保留情况。显示“唤醒成功（模型已回复）”仅表示模型已回复，不代表已验证服务端的额度计时规则；超时或中断时结果可能未知，可手动刷新额度确认。

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

- 每次提交到 `master`：读取 `package.json` 版本，分别构建对应版本的 macOS arm64 DMG、macOS x64 DMG 和 Windows x64 Setup，创建或更新 `v版本号` 正式 Release、标记为 Latest，并同时上传到 Actions Artifacts；
- Linux job 会预构建 WSL SEA relay，并只把该中间产物交给 Windows 安装包；macOS DMG 不包含 Linux Node 或 WSL relay；
- 推送 `v*` 标签：标签必须与 `package.json` 版本一致，构建成功后更新同版本 GitHub Release；
- 支持在 Actions 页面手动触发。

自动打包前会在 macOS、Windows 和 Linux 上运行免费契约测试；任一平台失败都会阻止打包与发布。本机的官方运行时、浏览器测试和真实模型验收另有入口，结果只对本次平台生效。真实模型测试会产生用量，不在 CI 中执行。完整覆盖边界见 [`docs/testing.md`](docs/testing.md)。

## 本地开发

需要 Node.js 22 或更高版本：

```bash
npm install
npm run launch
```

也可以直接双击项目根目录中的开发版启动入口：

- macOS：`启动开发版.app`（Finder、QSpace Pro 均推荐）或 `启动开发版.command`
- Windows：`启动开发版.cmd`

Windows 开发入口会先使用项目内或系统中的 Node.js 22 准备 relay，再隐藏启动注入器。普通 Windows 模式会在首次启动当前项目版本时原子生成版本化的原生 Windows SEA relay；源码开发版若要重建 WSL relay，需要在 `runtime/node-v22.23.1-linux-x64/bin/node` 准备本地 Linux Node。正式 Windows 安装包已经压缩内置构建好的 WSL relay，安装和运行均不需要该开发运行时。启动器根据版本和运行模式协商是否接管已运行的注入器；旧版本协议无法识别时，会在确认旧进程属于本项目后终止旧进程并继续启动。CDP 和模型中继均就绪时保留官方 Codex，否则需要重启以加载配置；Windows 开发入口不会保留 npm 或 PowerShell 前台窗口。启动日志位于 `%LOCALAPPDATA%\Codex Quota Injector\Logs\launcher.log`，运行日志位于同目录的 `injector.log`。

其他命令：

```bash
npm run doctor
npm run read-quota
npm run inject
npm run preview
npm test
npm run test:coverage
npm run test:offline
npm run test:live:official -- --plan
npm run test:live:deepseek -- --plan
npm run test:lifecycle -- --plan
```

`npm test` 运行免费基础回归；`npm run test:offline` 在当前 macOS 或 Windows x64 上追加真实官方运行时和临时 Chrome/Edge 页面操作，不消耗模型 Token。两种平台都使用临时配置、测试凭据和本地模型端点；macOS 额外使用 Seatbelt 限制出站。若请求没有到达本地端点，测试会失败。报告保存在 `.runtime/test-results/offline.json`，同时绑定代码、CLI 和浏览器摘要。

测试固定分为三批。A 为 `npm run test:offline` 免费回归，代码、配置或测试修改完成后默认自动执行。A 通过后应主动展示后续计划并询问用户：B1 用 `npm run test:live:official -- --plan`/`--confirm-token-use` 只测 Codex 官方模型，B2 用 `npm run test:live:deepseek -- --plan`/`--confirm-token-use` 只测 DeepSeek。B1、B2 分别授权、分别报告，不切换账号或重启日常 Codex；桌面特有工具按[宿主验收步骤](docs/testing-desktop-host.md)归入当前模型对应批次。

C 为 `npm run test:lifecycle -- --plan`，只读核对正式包、进程、中继协议、账号条件和计划中的一次官方冒烟；单独获得当次同意后，`--confirm-restart` 才会执行安装、接管、重连、关闭重开和账号往返。测试开始前会在独立浏览器页实时显示步骤，macOS 由 launchd 监督，Windows 由任务计划程序监督，因此 Codex 被关闭后控制程序仍能继续记录和恢复。

## 限制

- Token 费用按官方 Standard API 单价估算，并非 ChatGPT 订阅扣费或第三方账单。OpenAI 价格已按 [2026-09-06 官方定价页面](https://developers.openai.com/api/docs/pricing) 更新，覆盖 GPT-6 Astra、GPT-5.6 Sol/Terra/Luna/Cyber、GPT-5.3 Codex 和 Chat Latest 等文本模型；Sol 使用当前公布的优惠价（至少持续至 2026-11-21）。Fast、Batch、Flex、地域附加费和工具调用费用不计入该估算；
- 必须通过 `Codex Quota Injector` 启动官方 Codex；普通方式启动的客户端没有 CDP 端口，无法注入；
- 账号切换会重启官方 Codex，当前任务由客户端自身恢复；
- API Key 账号可以保存和切换，但 ChatGPT 订阅额度接口不适用于 API Key；
- Codex 更新若修改账号区域的 DOM 或无障碍标签，需要同步更新 `src/widget.mjs` 的定位规则。
