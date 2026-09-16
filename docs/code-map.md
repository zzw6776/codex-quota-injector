# 按功能查看和修改代码

原有 `src/*.mjs` 公共入口和导出保持兼容。实现放入同名目录，按职责组织；跨功能调用使用明确的参数、回调或命名导入。修改时先读入口，再读对应实现和测试，不需要把整个功能的源码全部载入上下文。

## 从修改目标找实现

| 修改目标 | 入口 | 主要实现 |
| --- | --- | --- |
| 页面注入、数据桥接 | `src/widget.mjs` | `widget/expressions.mjs` 组装注入表达式；`widget/runtime.mjs` 挂载、渲染调度、更新和销毁 |
| 页面模型管理 | 同上 | `model-views.mjs` 展示；`model-forms.mjs` 表单读写；`model-state.mjs` 草稿、发现和检测结果；`model-events.mjs` 配置动作 |
| 页面账号、迁移、唤醒 | 同上 | `accounts.mjs`、`migration.mjs`、`wakeup.mjs`；余额与宿主状态分别在 `balance.mjs`、`host-health.mjs` |
| 页面用量和请求详情 | 同上 | `usage-lines.mjs` 会话用量；`usage-tooltip.mjs` 费用；`usage-details.mjs` 请求详情；`tooltip-position.mjs` 提示位置 |
| 页面布局与样式 | 同上 | `panel-layout.mjs`、`panel-events.mjs`、`navigation-events.mjs`、`styles.mjs`；纯展示函数在 `*-display.mjs` 与 `formatting.mjs` |
| 注入器连接、刷新与动作调度 | `src/injector.mjs` | `injector/widget-session.mjs` 页面同步；`injector/host-health-session.mjs` 健康状态监听与轮询 |
| 用量采集与计账 | `src/token-usage.mjs` | `token-usage/usage-events.mjs` 实时事件；`rollout-records.mjs` 历史记录；`turns.mjs` 回合；`generation.mjs` 请求与生成指标 |
| 用量缓存、历史读取和展示 | 同上 | `cache.mjs` 缓存；`rollout-files.mjs` 文件发现；`rollout-worker.mjs` Worker；`subagents.mjs` 子任务归属；`display.mjs` 视图 |
| 模型路由与任务供应商绑定 | `src/model-router.mjs` | `model-router/configuration.mjs` 模型路由；`request-policy.mjs` 能力约束；`request-metadata.mjs` 请求上下文 |
| HTTP、WebSocket 与网络状态 | 同上 | `http-transport.mjs`；`websocket-transport.mjs`、`websocket-bridge.mjs`；`network-monitor.mjs` 独立网络监控 |
| 响应观察与用量事件 | 同上 | `response-observation.mjs` 指标状态；`response-stream.mjs` 流转发；`websocket-observation.mjs`；`usage.mjs` |
| Relay 启动、消息和任务上下文 | `src/app-server-relay.mjs` | `app-server-relay/transport.mjs` 标准流与 sidecar；`client-messages.mjs`、`server-messages.mjs`；`thread-context.mjs` |
| Relay 模型、配置与所有权 | 同上 | `model-catalog.mjs`、`host-tools.mjs`、`usage.mjs`、`configuration.mjs`、`native-paths.mjs`、`ownership.mjs` |
| 模型兼容性检测 | `src/model-capability-probe.mjs` | `model-capability-probe/protocol.mjs` 协议；`tools.mjs` 工具；`reasoning.mjs` 推理；`image.mjs` 图片；`conformance.mjs` 组合验收 |
| 检测重试、失败与诊断 | 同上 | `progress.mjs`、`failures.mjs`、`transport.mjs`、`payloads.mjs`；版本与预算在 `contract.mjs` |
| 账号、凭据与迁移 | `src/account-manager.mjs` | `account-manager/accounts.mjs` 账户表示；`tokens.mjs` 刷新；`oauth.mjs` 授权；`credentials.mjs` 官方凭据；`credential-input.mjs` 导入；`transfer.mjs` 迁移事务与回滚 |
| 平台识别与生命周期 | `src/platform.mjs` | `platform/executables.mjs`、`windows-discovery.mjs`；`processes.mjs`、`process-parsing.mjs`；`lifecycle.mjs`、`macos-lifecycle.mjs`、`readiness.mjs` |
| WSL 配置与平台材料 | 同上 | `wsl-settings.mjs`、`windows-artifacts.mjs`；平台范围的共享原语在 `contract.mjs` |
| Responses / Chat 转换 | `src/chat-compat-proxy.mjs` | `chat-compat-proxy/request.mjs` 请求；`responses-bridge.mjs` 桥接；`response.mjs` 响应状态；`history.mjs` 历史；`policy.mjs` 能力策略；`transport.mjs`、`chat-transport.mjs` |
| Windows 生命周期验收实现 | `scripts/lifecycle-windows.mjs` | `lifecycle-windows/operations.mjs` 编排；`runtime-configuration.mjs` 切换与恢复；`installation.mjs` 回滚；`history.mjs`、`history-rebuild.mjs`、`wsl-history-store.mjs` 历史门禁 |

同名目录中的 `contract.mjs` 仅保存该功能共享的常量和基础契约，不作为全项目工具集合。

## 状态归属与特殊边界

- `TokenUsageManager` 持有回合、缓存和事件去重状态；Worker 生命周期由 `RolloutWorkerClient` 持有。Worker 继续使用内嵌源码与 `eval: true`，正式 SEA 包不依赖外部 Worker 文件。
- `ModelRouterManager` 持有模型路由和任务供应商绑定；`RouterNetworkMonitor` 独立持有网络连接、采样和监听状态。响应观察对象各自持有单个请求的指标。
- `AccountManager` 持有账户库、操作状态与锁。迁移模块在既有锁和操作边界内执行完整事务，不把刷新、凭据交接和回滚拆成独立交易。
- `runAppServerRelay` 持有 Relay 会话状态，各消息模块使用明确传入的同一状态；平台可执行文件的可变缓存留在各自发现模块。
- `runInjector` 管理连接和调度；页面同步模块持有 revision、差量和稳定用量快照；宿主健康模块持有监听器、轮询和操作错误。
- Widget 的 `runtime.mjs` 持有唯一页面状态。`browser-features.mjs` 注册功能工厂，每个工厂通过显式依赖执行原有功能。工厂必须能独立序列化：不能依赖模块导入或 Node.js 闭包；跨功能回调延迟读取，避免初始化顺序造成循环引用。
- `expressions.mjs` 将运行时、功能工厂和样式组装为浏览器表达式。`src/dev-runtime.mjs` 对整个 Widget 目录创建独立 ESM 快照，导入后清理临时文件，子模块变更不会命中旧模块缓存。

## 测试入口

大测试已拆为同目录下的 `*-*.test.mjs`，共享材料位于 `test/<功能>/support.mjs`。`npm test` 继续发现全部顶层契约测试；`npm run test:offline` 继续将全部 Widget 浏览器测试归入 `A-common`。

| 功能 | 契约 / 浏览器测试 |
| --- | --- |
| Router | `test/model-router*.test.mjs` |
| 用量 | `test/token-usage*.test.mjs` |
| 兼容检测 | `test/model-capability-probe*.test.mjs` |
| 模型配置 | `test/model-configuration*.test.mjs` |
| Widget | `runtime-tests/widget-browser*.test.mjs`、`test/runtime-contracts.test.mjs` |
| 子模块热更新 | `test/dev-runtime.test.mjs` |

源码拆分不改变 A/B/C 的授权、平台隔离和报告口径。压缩打包后的 Widget 会在临时真实浏览器中验证序列化、模型表单与动作；完整 Windows 生命周期仍须在 Windows 原生环境执行 C。

版本规则保持原意：应用版本在 `package.json` 与 `package-lock.json`；Widget 版本定义在 `src/widget/contract.mjs` 并从原入口导出；Relay 协议仍在 `src/relay-contract.mjs`。等价的内部拆分不改变 Relay、缓存或模型检测结论的版本。
