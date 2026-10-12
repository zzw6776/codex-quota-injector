# 新版 Codex 任务识别与 macOS CLI 回退修复

- 源码：应用 0.1.306；Widget 保持 188；Relay 95（启动查找行为变更）。
- 环境：macOS arm64，Node v26.7.0，隔离浏览器 Chrome/155.0.8059.39。
- 范围：免费回归的定向子集，7/7 通过。没有发送模型请求、启动 app-server、重启或接管日常应用；不是完整免费回归或桌面验收。

## 修复及证据

1. 新版会保留隐藏聊天的输入区。侧栏仍为临时 ID 时，旧逻辑要求整页只有一个 ID 节点，因而无法识别当前任务。现在只读取唯一可见的聊天输入区，并对其内部 ID 去重；多个可见输入区、有多个不同 ID、缺失或无效 ID 时仍拒绝猜测。可见性检查作用于输入区根节点，允许提供 ID 的空 portal 自身隐藏。旧版真实侧栏 ID 的逻辑保留。
2. Swift 启动桥接的自动查找仍只支持 `Contents/Resources/codex`。现在所有运行中和标准安装位置均优先查找 `Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`，再回退旧路径；显式路径优先、可执行权限和防止递归执行自身的检查保留。

## 定向执行

执行入口：`node --test test/host-health-session.test.mjs test/macos-shim-discovery.test.mjs runtime-tests/active-task-browser.test.mjs`。

| 用例组 | 结果 | 覆盖 |
| --- | --- | --- |
| 任务选择及健康状态会话 | 4/4 | 真实 ID、临时 ID、无效/歧义 ID、云任务、任务切换与异步响应隔离 |
| 浏览器任务识别 | 1/1 | 隐藏祖先、visibility:hidden、空 portal、相同 ID 去重、多个可见聊天、切换可见聊天、主页排除、旧侧栏 ID |
| 原生 Swift CLI 查找与回退 | 2/2 | 新旧目录、优先级、权限、缺失文件、自身符号链接；完整 shim 在无配置和损坏配置时调用已确认的官方 CLI `--version` |

Swift 路径夹具编译生产查找函数原文并使用临时安装目录；完整 shim 另行编译至临时目录。未覆盖或替换日常使用的可执行文件。

## 当前页面只读复核与生效边界

在日常 Codex 页面执行修复后的只读任务识别函数：发现两个聊天输入区，仅一个可见；成功识别，结果与可见输入区 ID 一致。页面同时有 11 个回合节点和 11 条用量行，GPT-6.1 Sol、GPT-6 Astra 已有可用价格结果。

复查本次修改及此前确认的页面/路径依赖，未发现新的确定不兼容点。此结论不扩展为 Windows、WSL 或所有桌面交互通过。

现有热加载仅覆盖 Widget 模块，不覆盖后台任务识别函数和 Swift 桥接。日常注入器仍为 0.1.301，Widget 188；健康状态仍由旧后台计算为 idle。单次执行新函数仅证明修复可识别现场，不表示持续后台已加载。源码修复须下次启动开发版后生效，正式安装包未构建或替换。

## 原始证据与输入

- `.runtime/compatibility-20261012/targeted.log`：SHA-256 `09efe1ec77e09175a3b4244033ec8b6e26105a40ced81575ec998aff3fe7720e`。
- `.runtime/compatibility-20261012/live-readonly.json`：SHA-256 `f02ad17fb1e069e241feb97e798aefcc10c263f8a1b5e24f8efee826e0e36c6a`，含运行状态及受测源码/用例的逐文件 SHA-256。
- 浏览器材料：`.runtime/test-results/browser-031646e55adc.png`。
- 关键生产输入：`src/injector/active-task.mjs` 为 `8b27d31507d0bcf679241c95d78212e60df43bda0d92739f7407aef759a615b7`；`src/macos-codex-shim.swift` 为 `3eb8d90c3dbb30cc9d7164b9a753e5b903caf38ad4073cb31d6a4e423fdc3192`。

作为新版保留隐藏页面和 CLI 迁移的兼容性修复证据额外保留；未清理历史报告。
