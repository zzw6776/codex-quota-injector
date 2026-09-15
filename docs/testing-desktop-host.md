# B1/B2：真实桌面入口验收

B1 和 B2 各自由两个必须分开保存的组件组成：

| 组件 | 运行位置 | 固定验证范围 |
| --- | --- | --- |
| `B1-official-backend/<runtime>` / `B2-deepseek-backend/<runtime>` | 隔离的官方 app-server | 真实模型路由、文件/命令/MCP、历史、分叉、压缩及 app-server 回调 |
| `B1-official-desktop/<runtime>` / `B2-deepseek-desktop/<runtime>` | 当前 Codex 桌面任务 | 实际模型、codex_app 会话读取、functions.exec、web.run、computer use、当前 Widget/中继/运行环境 |

只有同一源码摘要、平台、运行环境和供应商的两个组件都为 `passed`，对应 B1 或 B2 才是 `passed`。后台通过而桌面组件未运行时，总状态是 `incomplete`；不再使用容易被误解为整批通过的后台结果代替桌面结论。

## 执行顺序

计划命令不会发送模型请求：

```sh
npm run test:live:official -- --plan
npm run test:desktop -- --profile=official --plan

npm run test:live:deepseek -- --plan
npm run test:desktop -- --profile=deepseek --plan
```

取得对应 B 批的本次明确同意后，先运行后台组件：

```sh
npm run test:live:official -- --confirm-token-use
# 或
npm run test:live:deepseek -- --confirm-token-use
```

后台组件通过后，从独立终端启动同一供应商的桌面组件：

```sh
npm run test:desktop -- --profile=official --confirm-token-use
# 或
npm run test:desktop -- --profile=deepseek --confirm-token-use
```

由另一个 Codex 任务通过任务工具发送验收文本时，追加 `--trigger-mode=delegated`；人工直接在目标任务中粘贴或输入时保持默认 `direct`。这个参数记录触发来源，不改变模型、运行环境或工具通过标准。

桌面执行器会先创建报告、启动只监听 `127.0.0.1` 的随机材料服务，并打开可见的 `progress.html`，然后输出一段带验收编号和随机标记的任务文本。把这段文本发送到已经选择目标模型的真实 Codex 桌面测试任务中。不启动第二个 Codex，也不让一个 Codex 通过 UI 控制另一个 Codex。审批允许/拒绝弹窗不属于测试项，项目继续使用 `never`。

执行器每两秒从本机证据刷新报告，完成后自动退出。也可读取已有任务状态：

```sh
npm run test:desktop -- --status=<run-id>
```

## 固定判据

桌面组件逐项核对：

1. `package.json` 源码摘要在测试期间未变化；实际 Widget 显示当前项目版本，实际中继协议与源码一致；接管 app-server 时，`codex_app` 健康状态必须为 `ready`。
2. 当前桌面运行环境与报告一致。macOS、Windows 原生 Relay、WSL 原生 Relay 的结果不能互相继承。
3. rollout 中任务实际使用 B1 的官方模型或 B2 的 `deepseek-flash`，并记录任务 ID、轮次 ID 和各工具调用 ID。
4. `functions.exec` 的成功命令返回随机标记；另一命令返回随机标记和退出码 23，且同一任务随后继续调用其他工具。
5. 实际 `codex_app.list_threads` 返回当前任务，再以该任务 ID 调用 `codex_app.read_thread`。调用时设置 `includeOutputs: true`、`maxOutputCharsPerItem: 20000`，因为默认返回会隐藏委托正文。返回页中的每个 `completed` 回合都必须同时包含真实输入和 `agentMessage`：输入允许 `userMessage`，或 `namespace: codex_app`、`name: create_thread|send_message_to_thread` 的 `functionCallOutput`，后者必须有完整 `codex_delegation`、非空 `source_thread_id` 和 `input` 正文。官方输出包装 `{text, truncated}` 与完整字符串都可识别，截断或仅有工具名称不能通过。只检查匹配任务中的回合，不能跨任务或跨回合拼凑输入与回复；任一完成回合的 `items` 为空或缺失都不能通过；当前 `inProgress` 回合可以为空，`interrupted` 按官方单独行为留证。当前活动输入在回合完成前不会进入 read_thread 投影，因此随机标记只由 rollout 独立绑定，不要求 read_thread 重复回显。随后实际调用 `codex_app.list_projects` 与 `codex_app.get_usage_limits` 并正常返回。四个调用分别记录调用 ID，本地读取 rollout 不能代替。
6. 目标模型回合必须正常结束；`task_complete.error`（包括 `usage_limit_exceeded`）单独写入报告并判定失败，不能被后续 Relay 恢复掩盖。桌面或 app-server 在回合终态附近轮换时，运行时检查会等待同代 Relay 有界恢复后再判定，避免把瞬时切换误报为 Relay 根因。
7. 执行器从中继收到的真实模型请求记录脱敏工具清单，只保留工具类型、名称、命名空间和 MCP server label，不保存提示词、参数、Schema、工具输出或凭据。实际 `web.run` 完成 `search_query`、`open`、`find`，结果来自 OpenAI 官方 Codex 文档或 `openai/codex` 仓库并包含 `thread/fork`。B1 可使用独立 `web.run` 或官方 Hosted Search；B2 只有独立 `web.run` 才视为可调用，DeepSeek Responses 请求中存在但供应商忽略的 Hosted `web_search` 描述单独记录并判为 `unsupported`，阻断完整桌面组件且不继续无效重试。已支持但任务结束仍未调用记为 `not-executed`，调用后返回错误记为 `failed`。
8. Windows 上实际 computer use 启动本轮动态生成的 WinForms 原生应用，通过辅助功能读取随机标记、输入并只提交一次，同时调用一次截图；原生清单独立记录启动次数和提交值。macOS 使用本机 HTTP 材料并额外核对下载事件。调用发生但返回错误不能算通过；模型文字说明不参与判定。

`file://` 会在 Browser Use 页面加载前被 URL 安全策略拒绝，这是正常边界。桌面材料固定使用本机 HTTP；如果当前宿主仍拒绝回环地址，报告保留原始结果并标记未通过，不修改系统网络策略或加入防火墙规则。

## Windows 非浏览器 Computer Use 基线

Windows 的 TOOL-06 以每轮动态生成的 WinForms 原生应用为验收材料，浏览器或 HTTP 页面不能替代。材料入口为：

```sh
node scripts/test-computer-use-windows.mjs
```

WSL 会把材料生成和证据监督完整交给 Windows Node.js。`test:desktop` 已在 Windows 接入该原生清单，并拒绝重复启动、重复提交、错误标记以及只发生调用但返回错误的 Computer Use 结果。Relay 出错时还必须用同版本官方上游、同一原生环境和同一材料建立无 Relay 对照后再归因。当前官方 Computer Use 不能把 WSL 的 `/mnt/...` 工作目录映射为 Windows 本地 URI，因此 WSL 桌面任务保留 `BLOCKED_UPSTREAM`；Windows 原生 Relay 才是非浏览器应用完整交互的可执行链路。

## 平台和运行环境

默认 `--runtime=current` 只读取当前桌面设置，不修改它。也可显式指定本平台的一个环境：

```sh
npm run test:desktop -- --profile=official --runtime=macos-native --plan
npm run test:desktop -- --profile=official --runtime=windows-native --plan
npm run test:desktop -- --profile=official --runtime=wsl-native --plan
```

付费执行拒绝 `--runtime=all`。Windows 桌面若当前使用 WSL，执行器会从 WSL 的 Codex 会话目录读取本次随机标记所在的 rollout；Windows 和 WSL 的 Node.js、依赖、CLI、Relay、`codex_app` 健康状态及报告仍各自独立。测试脚本不会为了 B 批自动切换桌面运行方式，自动切换和逐字节恢复只属于最后执行的 C 批。

## 报告与其他桌面能力

每次结果写入 `.runtime/test-results/desktop-host/<run-id>/report.json`，相邻 `progress.html` 只显示脱敏步骤和状态，不驱动测试，也不参与断言。后台报告同步记录桌面报告路径、两个组件状态和 B 总状态。固定检查逐项使用 `passed`、`unsupported`、`not-executed`、`failed` 或执行中的 `not-run`；存在 `unsupported` 或 `not-executed` 时桌面组件为 `blocked`。报告不保存提示正文之外的真实业务内容、工具输出正文或凭据。

`read_thread` 或其他官方宿主工具异常不能根据单次桌面结果直接归因。先检查已知问题并核对 rollout/SQLite。`read_thread` 的正确任务中出现 completed 回合空 items 时，第一排查方向是 `codex-desktop-read-thread-pagination-cursor`，按[证据复用说明](read-thread-pagination-investigation.md#再次出现时先做什么)核对适用条件；匹配时引用既有对照并注明本任务未重复对照，不因供应商或任务变化重复完整定位。首次出现或证据不匹配时，再以实际运行的同版本官方 app-server、同一数据分别运行无 Relay 直连和正式 Relay 对照。两个底层结果一致且桌面封装异常的证据齐全时才标记 `blocked-upstream`；对照不一致仍保持 `failed` 并继续定位。当前 read_thread 归因只匹配“正确任务已成功返回，完成回合全部为显式空 items”的现场形态；缺失 items 字段、委托正文不完整或其他读取错误不能套用这个阻断标签。

已确认的 macOS 桌面分页游标问题见 [read_thread 分页问题复现材料](read-thread-pagination-investigation.md)。委托输入判据修复不改变该问题的 `blocked-upstream` 状态，也不重写既有验收报告；后续执行生成报告版本 9 的新证据。

Windows Computer Use 截图失败也遵循同一规则。桌面执行器只读取 `.runtime/test-results/desktop-host/upstream-attributions-<runtime>.json` 中经过结构核验的归因；当前 rollout 必须出现对应失败，并且文件必须同时记录同运行环境的生产 Relay 失败与已移除 Relay 的官方对照失败，才允许将截图标记为 `blocked-upstream`。

兼容入口 `node scripts/test-desktop-host.mjs --serve` 仍可只启动免费材料服务，但它不选择模型、不读取 rollout，也不能生成 B 桌面组件通过结论。

Apps、插件独特能力、媒体生成、自动化、远程环境和实时语音取决于当次桌面实际开放与配置，继续按[场景矩阵](codex-compatibility-test-plan.md)逐项记录 `PASS`、`FAIL`、`BLOCKED`、`NOT_RUN` 或有依据的 `OUT_OF_SCOPE`。固定桌面组件通过不会把这些条件场景自动标绿。关闭/重启、接管、单实例、断线恢复、正式包更新和真实账号往返以 C 批 `.runtime/test-results/lifecycle/<run-id>/report.json` 为准。
