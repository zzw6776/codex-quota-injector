# 新任务首条消息前工具检查竞态修复

> 历史预览记录：单次补测方案已由 [0.1.296 的触发与有界恢复](2026-09-22-task-tools-materialization-recovery.md) 替代。以下保留当时输入与结果。

- 日期：2026-09-22；macOS 27.0，arm64；Node v26.7.0。
- 源码：应用 0.1.295、Relay 协议 92；Widget 180 不变。基于 Git HEAD `26b9fd1` 加本地未提交修改；本轮未安装或重启日常应用。
- 触发证据：本机日志中，新任务的 `read_thread` 在首条用户消息落盘前返回 `is not materialized yet; thread/turns/list is unavailable before first user message`；其余三项只读工具成功。此症状与历史分页空 `items` 问题不同。
- 关键源码 SHA-256：`host-tool-probes.mjs` `8ff167baa29825257d733d7d9192cfe973fc6f8d6bae5bf9dd72347b9b5bcf73`；`host-health.mjs` `633fe2d25d361c25acdbabc1ea2f02f62a758fff97e92fd99d98e730847ad8e1`；`app-server-relay/host-tools.mjs` `688d5d0839de238beb0e74cbcdeec2c5c7aa93e5e4353312a768d0a494c583f7`；`app-server-relay/server-messages.mjs` `5c4c76854a526c91a7bd88cf0ebbbf5015cb0aa4eef651e2189e106ac31f2b32`。
- 原始测试 stdout 未另存文件，文件 SHA-256 无；执行结果按以下定向测试记录。

## 改动与边界

仅将明确的“任务尚未落盘、首条消息前不可读取”结果视为等待首条消息，避免在消息发送前显示异常横幅。收到该任务的首个成功 `turn/start` 响应或 `turn/started` 通知后，只补测一次 `read_thread`；通知和原探针结果两种先后顺序均处理。补测仍失败时保留真实未确认状态，不循环重试。权限错误等其他失败不自动补测；其他三个工具的既有成功证据保留。

## 定向验证

| 范围 | 结果 |
| --- | --- |
| `host-health`、`host-tool-probes`、`app-server-relay` | 既有四文件批次中的对应 31/31 通过；之后未修改这些文件 |
| `host-tools` 最终执行 | 21/21 通过；包含新任务竞态、反向响应顺序、工具就绪前通知、重复通知、补测仍失败和其他错误隔离 |
| `relay-protocol` | 14/14 通过，双向 RPC 外壳与上下文行为保持 |
| `git diff --check`、应用与锁文件三处版本、Relay 版本 | 通过；应用 0.1.295，Relay 92 |

第一次四文件定向批次为 37/38：新增通知测试夹具漏建回合状态，生产代码未受影响。补齐夹具后失败项 1/1 通过；随后四文件批次 50/50 通过。最后只修改调度器的就绪前通知处理并增加对应用例，`host-tools` 单文件最终 21/21 通过，其余文件结果按输入未变复用。零真实模型请求。

## arm64 预览包

使用官方 Node 22.23.1 arm64 运行时及项目 `build:sea`、`package:macos` 入口生成 `release/macos-arm64-preview-20260922-0.1.295/Codex-Quota-Injector-0.1.295-macos-arm64.dmg`，41 MiB；SHA-256：`a08f219d78fa9c9ded6fd5f0a2f2bb5949821fa7df8d1390f20cb309f8998524`。镜像校验通过；只读挂载后确认 `Applications -> /Applications`、应用版本 0.1.295、三个 arm64 可执行文件和 ad-hoc 签名验证通过，随后已卸载。尚未安装、启动或执行启停恢复；x64 未构建，本机日常运行版本仍未加载此修复。
