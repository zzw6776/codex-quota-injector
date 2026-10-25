# Windows 自动更新安装接管与首次窗口显示

## 范围

- 日期：2026-10-25 12:19（Asia/Shanghai）
- 源码基线：`73f9eea`，工作区应用版本 `0.1.330`
- 环境：Windows 10 IoT Enterprise LTSC `10.0.19044`，x64
- Node.js：`v22.23.2`，Windows 原生运行时
- 类型：应用更新契约与 Windows 安装脚本定向验证；不代表完整免费回归或启停恢复验收

## 原始失效机制

`0.1.321` 更新至 `0.1.329` 时，外层更新 Worker 启动 NSIS 安装器后停在“替换正式版本”。现场只读证据显示：

- 外层状态服务最终记录 `failedStage: installing`，安装命令约 120 秒后失败。
- NSIS 启动的临时应用带有 `--prepare-update` 参数，却另外创建了状态为 `confirm` 的更新服务。
- 正式安装目录和卸载注册信息仍为 `0.1.321`，没有发生文件替换。

根因是安装器继承 `CODEX_QUOTA_ROLE=app-updater` 及同一更新控制路径。临时应用入口优先识别继承的更新器身份，因而未执行安装准备，而是启动嵌套更新器；NSIS 的 `ExecWait` 持续等待，外层更新 Worker 到达 120 秒上限后失败。

## 修复

Windows 安装器现在通过既有 `cleanUpdateEnvironment()` 启动，仅保留普通系统环境，不再向 NSIS 及其 `--prepare-update` 助手传递 `CODEX_QUOTA_*`、`CODEX_APP_TOOLS_*`、旧 CLI 路径或 `NODE_OPTIONS`。

应用入口同时让明确的 `--prepare-update` 参数优先于继承的更新器角色。进程边界负责阻止污染传播，入口优先级保证即使外部环境再次被污染，安装准备意图也不会被覆盖。

Windows 更新窗口首次完成页面 `/ready` 后会产生一次性聚焦信号，由现有 `/focus` 通道激活窗口。重复 `/ready` 不会再次抢焦点；用户之后重新打开窗口时，每次 `/show` 仍产生一次新的聚焦信号。

## 验证

执行命令：

```text
C:\Program Files\nodejs\node.exe --test --test-concurrency=1 test/app-update.test.mjs test/windows-installer-command.test.mjs
```

结果：**31/31 通过，0 失败，0 跳过**。新增用例覆盖：

- 直接向安装调用注入更新器污染环境，确认传给 NSIS 的环境只保留普通 `PATH`，同时保留安装参数、120 秒上限、隐藏窗口和取消信号。
- 在继承 `CODEX_QUOTA_ROLE=app-updater` 时真实启动 `launcher.mjs --prepare-update`，确认入口选择安装准备而不读取继承的更新控制文件。
- 首次 `/ready`、重复 `/ready` 和后续 `/show` 的一次性聚焦语义。

输入 SHA-256：

- `src/app-update/native-install.mjs`: `f5cf3eca89ef550ab588f48ba9e73e1bb4f85accbd989698189e46b261f09deb`
- `src/app-update/window.mjs`: `4e2ffbe33108a7f42f4895401df6ede9cea93e799cc886dbbb61774cf0f01cfb`
- `src/launcher.mjs`: `ff7d268865edf906df77abd844403fa759345b859487944521b082db3bc7a488`
- `test/app-update.test.mjs`: `bf5983cee407666939800ab2ffef7c37b53db8998973895c093c8aa0447666f6`
- `installer/windows-installer.nsi`: `a63f913008ebd16a05da1331d1b5816166264d5be9dfa32fbc41dc2d292cfbab`

## Windows 原生窗口核验

复用现有 GitHub `0.1.329` 候选和当前 `0.1.330` 开发版控制端，在不下载或安装的前提下重新创建更新 Worker 与 PowerShell WinForms 窗口。状态进入 `confirm` 且 `windowReady=true`；等待窗口轮询后，系统前台窗口与新建更新窗口一致，标题为“Codex Quota Injector 更新”，一次性 `/focus` 信号已经被消费。

该结果确认首次创建窗口时会在页面就绪后自动进入前台，无需第二次点击。更新流程停留在确认页，没有触发安装器，不能据此替代“替换正式版本”的正式包端到端验收。

## 边界

本轮未构建或安装 `0.1.330` 正式包，未重启 Codex 或注入器，未发送真实模型请求。现场运行的正式版仍为 `0.1.321`。首次聚焦修复已由当前源码新建的开发版 Worker 完成 Windows 原生核验；正式更新链仍需由新的 Windows 正式包加载后生效。
