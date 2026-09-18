# macOS 任务工具目录查询定向诊断

- 执行日期：2026-09-18；原生 macOS arm64。
- 范围：用户指定任务的四项只读任务工具、三次目录查询及一次直接 RPC 探针；不替代完整桌面、后台或启停验收。
- 实际运行版本：应用 0.1.283 / Widget 173 / Relay 85；官方桌面 build 9771；CLI 0.155.0-alpha.9。诊断回合实际模型 gpt-5.6-sol、high。
- 原始健康检查状态：`status-query-failed`，保留为失败；本次四项实际调用 4/4 成功，额外目录请求 3/3 成功、直接探针 1/1 成功，分别计数，不把原始超时改成执行成功。
- 未修改生产代码、配置；未重载、未重启。

## 结果

| 请求 | 实际耗时 | 结果 |
| --- | --- | --- |
| list_threads | 1,616.98 ms | completed，无工具错误 |
| read_thread | 20.22 ms | completed，无工具错误；读取当前活动回合，不覆盖 completed 历史内容语义 |
| list_projects | 86.58 ms | completed，无工具错误 |
| get_usage_limits | 1,800.32 ms | completed，无工具错误 |
| 完整目录 | 16,764 ms | 成功，13 项，无后续页 |
| toolsAndAuthOnly 目录 | 15,657 ms | 成功，13 项，无后续页 |
| toolsAndAuthOnly，limit=3 | 14,683 ms | 成功，3 项，有后续页，本页包含 codex_app |
| scoped mcpServer/tool/call：list_projects | 517 ms | 成功，无工具错误 |

模型回合内的工具耗时来自原始 McpToolCall 记录，不使用模型并发请求后依次 await 得到的累计耗时。目录请求均绑定用户指定任务，四个 requiredTools 均存在。健康记录随后由正常目录响应更新为 `ready / toolsVerified=true / missingTools=[]`；没有手改健康文件，也未验证所有工具业务语义。

## 已确认机制与边界

项目按任务排入共享串行目录核验队列，15 秒超时后标记 expired，丢弃该请求的迟到响应。这与本次成功目录实际耗时超过 15 秒共同解释了“工具实际成功、健康检查却失败”。串行排队会增加其他任务等待，但本次单独目录请求本身也需要约 15–17 秒。

同版本官方公开源码的 scoped 状态列表先收集完整快照：计算所有有效服务鉴权状态，新建 `previous=None / startup_policy=Eager` 的连接集，收集服务信息与工具，最后才对结果分页。普通服务信息会等待连接初始化；full 还请求资源和资源模板。已有部分目录缓存不等于完全复用当前任务连接。`toolsAndAuthOnly` 仅省略资源，本次没有消除主要等待；缩小 limit 也不会缩小上游快照采集范围。

依据：官方仓库 tag `rust-v0.155.0-alpha.9` 的 `codex-rs/app-server/src/request_processors/mcp_processor.rs`、`codex-rs/codex-mcp/src/mcp/mod.rs`、`mcp/auth.rs`、`connection_manager.rs`；[官方接口文档](https://developers.openai.com/zh-Hans/docs/app-server)。没有执行无 Relay 的同数据最小对照，没有逐服务阶段计时，因此不能确定某个具体服务占用了全部等待，也不登记为已接受的上游故障。

候选改进：前台采用当前任务的低成本只读探针，后台目录核验独立记录完整性；超时显示未确认而非工具不可用；同代迟到结果可接收；UI 按当前任务读取健康记录。单工具探针只能证明该工具实际可调用，不能替代四项注册完整性。以上尚未实现或完成行为验证。

## 证据保留

私有诊断材料：`.runtime/task-tools-gkd-20260918/diagnosis.json`，包含执行输入摘要、任务标识、计时和运行时摘要；原始 rollout 与桌面日志留在执行机器，不纳入 Git。诊断材料 SHA-256：`1b3633927431cb86df7444e289350bf8a3f5ce95d9a51960facd3a6f50132ca4`。CLI SHA-256：`2e0918e73319f9a57126a1bf04dcc778e1ff5c1804cac1cbff08ba0853f1c97b`。

保留原因：任务健康检查误判机制及慢目录的关键定向证据；不能据此推定跨版本、跨平台或其他任务通过。
