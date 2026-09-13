# B1/B2：真实桌面入口验收

B1 和 B2 各自由两个必须分开保存的组件组成：

| 组件 | 运行位置 | 固定验证范围 |
| --- | --- | --- |
| `B1-official-backend/<runtime>` / `B2-deepseek-backend/<runtime>` | 隔离的官方 app-server | 真实模型路由、文件/命令/MCP、历史、分叉、压缩及 app-server 回调 |
| `B1-official-desktop/<runtime>` / `B2-deepseek-desktop/<runtime>` | 当前 Codex 桌面任务 | 实际模型、codex_app 会话读取、functions.exec、web.run、computer use、用户补充输入、当前 Widget/中继/运行环境 |

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

由另一个 Codex 任务通过任务工具发送验收文本时，追加 `--trigger-mode=delegated`；人工直接在目标任务中粘贴或输入时保持默认 `direct`。这个参数只改变 `read_thread` 的证据判定，不改变模型、运行环境或其他工具步骤。

桌面执行器会先创建报告、启动只监听 `127.0.0.1` 的随机材料服务，并打开可见的 `progress.html`，然后输出一段带验收编号和随机标记的任务文本。把这段文本发送到已经选择目标模型、能够使用 `request_user_input` 的真实 Codex 桌面测试任务中；当前客户端仅在 Plan 模式开放该工具时，就用 Plan 模式创建本次临时任务。不启动第二个 Codex，也不让一个 Codex 通过 UI 控制另一个 Codex。用户补充输入是固定验收步骤，收到问题后正常回答即可。审批允许/拒绝弹窗不属于测试项，项目继续使用 `never`。

执行器每两秒从本机证据刷新报告，完成后自动退出。也可读取已有任务状态：

```sh
npm run test:desktop -- --status=<run-id>
```

## 固定判据

桌面组件逐项核对：

1. `package.json` 源码摘要在测试期间未变化；实际 Widget 显示当前项目版本，实际中继协议与源码一致；接管 app-server 时，`codex_app` 健康状态必须为 `ready`。
2. 当前桌面运行环境与报告一致。macOS、Windows 原生 Relay、WSL 原生 Relay 的结果不能互相继承。
3. rollout 中任务实际使用 B1 的官方模型或 B2 的 `deepseek-v4-flash`，并记录任务 ID、轮次 ID 和各工具调用 ID。
4. `functions.exec` 的成功命令返回随机标记；另一命令返回随机标记和退出码 23，且同一任务随后继续调用其他工具。
5. 实际 `codex_app.list_threads` 返回当前任务，再以该任务 ID 调用 `codex_app.read_thread`。直接触发时，read_thread 输出必须包含本次随机标记；跨任务委托时，read_thread 只要求成功读取正确任务，因为当前活动输入可能尚未进入摘要，随机标记继续由 rollout 独立绑定。随后实际调用 `codex_app.list_projects` 与 `codex_app.get_usage_limits` 并正常返回。四个调用分别记录调用 ID，本地读取 rollout 不能代替。
6. 执行器从中继收到的真实模型请求记录脱敏工具清单，只保留工具类型、名称、命名空间和 MCP server label，不保存提示词、参数、Schema、工具输出或凭据。实际 `web.run` 完成 `search_query`、`open`、`find`，结果来自 OpenAI 官方 Codex 文档或 `openai/codex` 仓库并包含 `thread/fork`。B1 可使用独立 `web.run` 或官方 Hosted Search；B2 只有独立 `web.run` 才视为可调用，DeepSeek Responses 请求中存在但供应商忽略的 Hosted `web_search` 描述单独记录并判为 `unsupported`，阻断完整桌面组件且不继续无效重试。已支持但任务结束仍未调用记为 `not-executed`，调用后返回错误记为 `failed`。
7. 实际 computer use 打开本机 HTTP 材料、读取随机标记、输入并只提交一次、截图并下载产物。材料服务独立记录提交和下载；模型文字说明不参与判定。
8. 实际 `request_user_input` 的回答回到同一任务，任务继续并正常结束。

`file://` 会在 Browser Use 页面加载前被 URL 安全策略拒绝，这是正常边界。桌面材料固定使用本机 HTTP；如果当前宿主仍拒绝回环地址，报告保留原始结果并标记未通过，不修改系统网络策略或加入防火墙规则。

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

兼容入口 `node scripts/test-desktop-host.mjs --serve` 仍可只启动免费材料服务，但它不选择模型、不读取 rollout，也不能生成 B 桌面组件通过结论。

Apps、插件独特能力、媒体生成、自动化、远程环境和实时语音取决于当次桌面实际开放与配置，继续按[场景矩阵](codex-compatibility-test-plan.md)逐项记录 `PASS`、`FAIL`、`BLOCKED`、`NOT_RUN` 或有依据的 `OUT_OF_SCOPE`。固定桌面组件通过不会把这些条件场景自动标绿。关闭/重启、接管、单实例、断线恢复、正式包更新和真实账号往返以 C 批 `.runtime/test-results/lifecycle/<run-id>/report.json` 为准。
