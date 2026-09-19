# Codex turn state 实际链路调查

本调查只回答当前官方 Codex Responses 链路中实际出现了什么，不把第三方文章的推测当成协议定义。原始请求、响应、凭据和 state 保存在本机全量日志；本文及测试报告只保留脱敏计数和源码证据。

## 当前结论

- 当前桌面实际 CLI 为 `codex-cli 0.155.0-alpha.2.6`，模型请求走 Responses WebSocket。
- 服务端通过 `codex.response.metadata.headers["x-codex-turn-state"]` 下发 state。已观察的值都是 292 字节，但每次响应的 SHA-256 均不同，因此“292”首先是当前令牌编码长度，不是 HTTP 状态。
- 捕获范围内只有 WebSocket 握手 HTTP 101，没有 HTTP 292/312；解析后的协议状态字段也没有 292/312。
- 有一次同一 `turnId` 在收到 state 后连接异常关闭并重新握手；新握手没有携带 `x-codex-turn-state`。Router 对官方上游保留所有 `x-codex-*` 头，不是 Router 删除。
- 对应 CLI 标签 [`rust-v0.155.0-alpha.2.6`](https://github.com/openai/codex/tree/rust-v0.155.0-alpha.2.6) 的实现能解释该现象：HTTP Responses 选项会从 `turn_state` 构造请求头，但 WebSocket 的 `build_websocket_headers` 和 `connect` 路径明确传入 `turn_state: None`。因此这个版本的 WebSocket 重连不能用“后续握手一定回传 state”作为判据。

## 与第三方文章的边界

文章描述的是 `chat/completions`、HTTP 292/312 和名为 `current_turn_state` 的上层数据；当前捕获的是 Codex Responses WebSocket 及 `x-codex-turn-state`。公开 Codex 源码只把后者定义为 turn 范围的粘性路由令牌，没有公开文档把令牌长度 292 定义成资源等级，也没有找到文章所称 `codex-state-kit` 的可审计源码来证明两个字段的转换关系。

因此目前可以确认：Astra 与 Sol 都收到 292 字节的 `x-codex-turn-state`，这些值逐响应变化；不能确认它等于文章的 `current_turn_state`，也不能据此判断模型是否“降智”。若未来取得该工具源码或原始抓包，应先验证字段映射和真实 HTTP 状态，再考虑同端点对照，不能把 Responses WebSocket 结果直接套到 Chat Completions。

## 复现分析

使用[全量日志说明](model-request-diagnostics.md)中的 `npm run analyze:requests`。分析器自动读取基础文件和轮换分片，按连接、请求和回合关联 state，只输出字段路径、长度和 SHA-256，不输出原值、正文或凭据。

应用 0.1.292 起，全量日志默认关闭；右上角的轻量指示独立工作。0.1.293 修复了 WSL Relay 与 Windows 注入器分进程时状态只留在 Relay 内存、Widget 永远读取另一实例的问题：Relay 现在通过现有用量事件文件传递并缓存任务 ID、长度、模型和时间，仍不传递 state 原值。指示器只显示当前任务最近一次官方 `x-codex-turn-state` 是否为 292 字节，不检查 `current_turn_state`，也不能代表模型质量或 HTTP 状态码。

`replayObserved=false` 表示捕获范围内没有看到同一个 state 进入后续请求；它可能来自连接未重建、当前客户端实现没有附带，或捕获范围不足，不能单独解释成服务端拒绝 state。
