# Token 价格实时展示优化设计

## 背景与目标

当前正式版 `0.1.102` 在恢复 Token 缓存时引用了未定义的 `usage`，导致
`TokenUsageManager` 初始化中断，实时文件监听没有启动，价格主要依赖 15 秒兜底刷新。
同时，Codex app-server 对 `thread/tokenUsage/updated` 的发送时机不固定；在首条 usage
到达前，现有 Widget 会直接过滤零 Token 回合，用户只能看到价格空白。

本次目标：

- 修复缓存恢复异常，恢复 usage 事件的实时消费。
- 新回合开始后立即显示“等待 Token 数据”，不伪造价格。
- 首条 usage 到达后立即切换为实时估算，完成后显示本轮费用。
- 实时监听异常时继续使用现有 15 秒兜底刷新。

## 最终方案

### 实时链路

1. relay 收到 `turn/started` 后写入内部 `turn-started` 事件，携带
   `threadId`、`turnId`、`model` 和 `modelSource`。
2. `TokenUsageManager` 创建幂等的零 Token 临时回合。
3. Widget 对运行中的零 Token 回合显示“等待 Token 数据 · 价格待计算”。
4. relay 收到 `thread/tokenUsage/updated` 后沿用现有增量合并和价格计算逻辑。
5. 收到 `turn/completed` 或 `turn/aborted` 后结束等待；若始终没有 usage，显示
   “本轮未获取到 Token 数据 · 价格无法计算”。

### 缓存与降级链路

1. 缓存段恢复时先标准化 `segment.usage`，再计算上下文价格档位。
2. 缓存恢复失败只丢弃本次缓存状态，不阻断实时事件监听和首次刷新。
3. 实时 watcher 在首次刷新前启动；watcher 报错后释放实例，后续刷新可重新建立。
4. 15 秒兜底刷新保持不变，只负责补读已经存在的 usage 或 rollout 数据，不生成 usage。
5. 零 Token 临时回合不写入长期缓存，避免重启后遗留“等待中”的假记录。

## 状态与展示

| 回合状态 | Token 数据 | 展示 |
| --- | --- | --- |
| 运行中 | 无 | 等待 Token 数据 · 价格待计算 |
| 运行中 | 有 | 实时 Token / 输入 / 缓存输入 / 输出 / 速率 / 实时估算 |
| 已完成或中止 | 有 | 本轮 Token 与本轮费用 |
| 已完成或中止 | 无 | 本轮未获取到 Token 数据 · 价格无法计算 |

## 改动范围

- `src/app-server-relay.mjs`：转发 `turn-started` 内部事件。
- `src/token-usage.mjs`：修复缓存恢复、隔离缓存失败、恢复 watcher、维护零 Token 回合。
- `src/widget.mjs`：展示等待和无数据状态。
- `src/relay-contract.mjs`：relay 协议版本从 7 升至 8。
- `src/platform.mjs`：同时校验 relay 配置与运行状态的 generation。
- `package.json`、`package-lock.json`：项目版本从 `0.1.102` 升至 `0.1.104`；
  `0.1.103` 运行态核验发现只更新配置、未切换旧 relay，因此追加启动器修复并再次升版。
- Widget runtime 从 66 升至 67。

不涉及数据库、外部 API、依赖、中间件或价格公式变更。

## 外部依赖与契约

提供方为 Codex app-server。当前实机事件已确认：

- `turn/started` 提供 `threadId` 和 `turn.id`。
- `thread/tokenUsage/updated` 提供 `threadId`、`turnId`、`tokenUsage.last`、
  `tokenUsage.total` 和上下文窗口。
- `turn/completed`、`turn/aborted` 提供终态。

usage 推送周期不是本项目可控制的契约，因此方案不依赖固定时间间隔；上游未提供 usage
时只展示等待状态。

## 幂等、顺序与失败处理

- 所有回合状态以 `turnId` 幂等合并，重复 `turn-started` 不重复创建记录。
- usage 早于或晚于终态时都保留已有计数；终态不清空 usage。
- 缓存恢复失败后从事件文件和 rollout 重新补全，不影响 relay 写入。
- watcher 失败后由后续 15 秒刷新尝试恢复；刷新本身仍负责补读遗漏事件。
- 并行任务按各自 `turnId` 独立维护，Widget 只渲染当前页面存在的回合节点。

## 风险与取舍

- 上游长时间不发送 usage 时无法提前得到可信价格，本次明确不做本地 Token 猜算。
- relay 协议升级会要求下次启动时使用新版 relay；本次不自动重启或安装。
- 启动器必须同时确认 relay config 和 state generation；仅配置已更新不能视为 relay 就绪。
- 缓存损坏后的首次全量补读可能比正常启动慢，但不会阻断实时监听。

## 验证方式

按项目规则不新增、不运行自动化测试，也不执行自动化功能验证。

只执行静态检查：

- 修改文件的 Node.js 语法检查。
- `git diff --check`。

由用户安装后手工确认：

- 启动日志不再出现 `usage is not defined`。
- 新回合立即出现等待状态。
- 首条 usage 到达后价格及时出现。
- 完成但无 usage 的回合不再永久等待。
- 重启后零 Token 临时回合不会残留。

## 非目标

- 不改变 OpenAI 或 DeepSeek 价格配置。
- 不缩短或取消 15 秒兜底刷新。
- 不本地估算隐藏上下文、缓存命中或推理 Token。
- 不构建、安装、重启 Codex 或注入器。

## 确认记录

- 方案确认时间：2026-08-19（Asia/Shanghai）。
- 用户确认：“可以，按你最后的方案来吧”。
