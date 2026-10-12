# 官方配置警告与注入器关联核对

- 日期：2026-10-12（America/Los_Angeles）；macOS arm64，Node v26.7.0。
- 用户引用聊天《解释 Codex 配置警告》，已通过 read_thread 读取上下文。聊天结论作为线索，本轮重新核对相关本机事实。
- 实际官方 CLI：`0.162.0-alpha.17.2`，路径与注入器 upstreamExecutable、官方应用内置路径及当前运行的两个 app-server 进程一致；没有使用不同版本的旧缓存 CLI。
- 范围：源码与日志只读核对、隔离官方 CLI / 项目 Relay 最小配置对照；零 turn/start、零模型请求。没有修改生产配置、关闭或重启日常应用。

## 证据与结论

1. 注入器源码及脚本不含 `code_mode_tool_description_first`、`guardianv2.thread_context` 配置；shim 和 Relay 新增参数集中于模型路由、供应商和模型目录，原请求的配置参数保留。
2. 官方 `app.asar` 内置代码直接生成 `code_mode_tool_description_first`；Guardian 配置也由官方动态配置层构建。本轮没有继续追踪 Guardian 的 `thread_context` 具体实验值来源，因此不把它归因用户配置文件。
3. 当前用户 config.toml 未找到这两个设置；日常桌面日志有 Guardian 弃用通知。运行中 CLI 命令行没有直接出现目标字段，不能据此排除它们来自后续 RPC 会话配置。
4. 使用同一个官方 CLI、相同隔离配置与相同目标字段，直连和经项目 Relay 均出现完全相同的官方 configWarning / deprecationNotice。警告本身及其忽略语义来自官方运行时；没有发现注入器引入目标配置或改变结果的证据。

## 最小对照结果

| 隔离输入 | 无 Relay 官方 CLI | 项目 Relay |
| --- | --- | --- |
| 两字段作为 -c 参数，initialize + config/read | 配置读取通过；复现第一条 session-flags 警告 | 配置读取通过；警告相同，Guardian 配置值保留 |
| 两字段作为 thread/start 的 config 覆盖 | 建立空任务通过；复现两条完整警告 | 建立空任务通过；两条完整警告相同 |

四次隔离操作均退出码 0。后两次仅建立隔离临时 HOME/CODEX_HOME 中的空任务，未发送用户消息或 turn/start，不出现在日常历史中。此前第一组 config/read 没有触发 Guardian 通知，保留真实范围，不把它写成已复现第二条。

本次 Relay 使用实际项目源码入口，不是重新打包的 SEA；只证明本机对应配置转发与警告结果，不代表跨平台、全量模型或正式包验收。没有为消除警告增加过滤、绕过或用户配置修改。

完整私有材料在 `.runtime/config-warning-20261012/`，包含两组原始协议输出与六项直接输入的摘要。

| 材料 | SHA-256 |
| --- | --- |
| 输入清单及实际 CLI 摘要 | `96490914ffa0f647313fac7c044f3849c0a59708b70541c44ce1ebbab16cd4b6` |
| 配置读取对照摘要 | `fca72480283493261f98d779713f843b2b5da1b857f8825bbd0fc0b15a2536ea` |
| 空任务配置对照摘要 | `7f547e7dd812b5a1f22847a29c48643b714587ac74beb191363917f141855b29` |
