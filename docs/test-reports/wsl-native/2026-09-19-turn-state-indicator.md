# 全量日志默认关闭与 292 指示定向验证

- 日期：2026-09-19
- 环境：WSL 原生 Linux x64，Node v22.23.1
- 源码：基线 `3bfb2748a67b134c779777e56ca7efe99aae0cc8` 上的未提交工作区；应用 0.1.292、Widget 175、Relay 90
- 范围：Router 全量日志开关、官方 `x-codex-turn-state` 内存观察、按任务隔离、Widget 右上角展示、页面桥接表达式、Relay 协议回归与 WSL SEA 构建
- 未执行：完整免费回归、真实模型、真实桌面浏览器、Windows/macOS 原生构建、安装和启停恢复

## 结果

- 最终 Router 与 Widget 定向：73/73 通过，0 失败、0 跳过。
- 页面桥接、运行时与 Relay 协议定向：40/40 通过，0 失败、0 跳过。
- 合计选定用例：113/113 通过；全部使用本地模拟上游，零真实模型请求。
- WSL 原生 SEA 构建成功，产物为 Linux x86-64 ELF；SHA-256：`6f742a5c6ede53bbf520565be56a04e04237843369e4dbd8aaa1a0a47111b954`。
- `git diff --check` 通过；`package.json`、锁文件顶层与根包版本均为 0.1.292。

覆盖的真实失效机制包括：未设置开关时即使存在 `usageEventPath` 也不创建敏感日志；关闭全量日志后仍能从 HTTP 响应头和 WebSocket `codex.response.metadata` 观察官方 state；只接受 `x-codex-turn-state`，不把 `current_turn_state` 或第三方同名字段冒充右上角状态；按任务隔离最新结果；292、非 292、未观察三种展示均有契约；公开视图不包含 state 原值。

## 执行说明

首次补充运行页面/协议用例时，隔离目录缺少 `runtime-tests` 和 `docs/testing-protocol-inventory.json`，分别以模块不存在和 ENOENT 结束；补齐与工作区相同的只读测试材料后，原命令 40/40 通过。WSL SEA 首次命令传入不存在的 `/usr/bin/node`，在编译启动前以 ENOENT 结束；核对当前 WSL 实际 Node 为 `/usr/local/lib/nodejs/node-v22.23.1-linux-x64/bin/node` 后，同源码构建成功。两次均为隔离环境准备错误，没有修改生产实现或把失败断言覆盖为通过。

日常 Codex 尚未安装或加载 0.1.292 / Widget 175 / Relay 90。当前运行中的旧 Relay 是否继续写入既有全量日志取决于其已加载版本；本报告不能作为默认关闭已经在日常客户端生效的证据。
