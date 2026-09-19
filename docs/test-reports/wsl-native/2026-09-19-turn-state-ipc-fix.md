# 2026-09-19 turn state 跨进程修复定向验证

- 环境：WSL 原生 Linux x64，Node v22.23.1；源码与 Linux 依赖在隔离的 Linux 文件系统快照中执行。
- 受测版本：应用 0.1.293、Widget 176、Relay 协议 91、Token 缓存 25。
- 范围：Router、用量事件与缓存、Widget 会话、任务状态展示、app-server Relay 和 Relay 协议定向用例。
- 结果：117/117 通过，失败、跳过、中止均为 0；测试全部使用本地模拟上游，真实模型请求为 0。
- 构建：WSL x64 SEA Relay `build/codex-quota-relay-wsl-0.1.293` 已通过构建器内置 ELF、文件大小和 SEA fuse 校验；SHA-256 为 `a401a306962ba740fdadb506f3d0af8686d193eb001e0137c80a8649daf2dfdf`。
- 未执行：完整免费回归、真实模型、真实桌面、正式安装与启停恢复；没有重启当前 Codex。

## 根因与修复

0.1.292 的轻量监测器位于 WSL Relay 内部 Router，而右上角 Widget 从 Windows 注入器中的另一个 `ModelRouterManager` 实例读取。两边任务 ID 和模型请求都正常，但没有跨进程状态传递，所以 Widget 始终得到 `unknown`。

修复复用既有 `token-usage-events.jsonl` 通道：Router 新增 `turn-state-observed` 事件，只包含任务 ID、UTF-8 字节长度、模型和记录时间；`TokenUsageManager` 按任务读取并缓存最多 256 项，Widget 改从该跨进程数据源读取。事件和缓存均不包含 `x-codex-turn-state` 原值。

## 定向证据

- Router HTTP 夹具确认官方 292 字节响应 state 会生成脱敏事件，事件无 state 原值。
- Token 用量管理器确认不同任务的 292/312 字节摘要相互隔离，未知任务返回 `unknown`，并可从缓存恢复。
- Widget 会话确认展示数据来自跨进程用量管理器；既有 292、非 292、未观察三种页面契约继续通过。
- Router、Token、Widget、app-server Relay 和 Relay 协议统一定向执行 117/117 通过。

当前日常运行版本仍为 0.1.292 / Widget 175 / Relay 90。本报告只证明源码修复和模拟链路，不证明当前客户端已加载 0.1.293；加载修复需要一次受控重启。
