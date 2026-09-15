# 官方桌面 read_thread 分页问题：复现材料

## 再次出现时先做什么

已知问题编号：`codex-desktop-read-thread-pagination-cursor`。本说明同时供 B1 官方模型和 B2 DeepSeek 桌面验收使用；模型不同不改变官方桌面工具封装的归因。

触发症状：`read_thread` 成功返回正确任务，但已完成回合的 `items` 为空。遇到此症状，先核对本说明，不先修改供应商兼容逻辑，也不反复消耗 Token 诱导模型重读。

1. 核对请求的任务/回合及终态，以 rollout/SQLite 确认已完成回合确有内容；当前活动回合为空不属于此问题。委托输入类型不等于 userMessage 也不等于内容丢失。
2. 核对实际官方桌面 build、CLI 版本和原生环境是否与下述对照一致。检查此次 Relay/桌面读取链是否发生了会改变分页参数或内容的改动；仅项目发布版本或 Relay 协议号变化，不足以证明读取链发生变化。
3. 对版本、环境、相关读取链和失败形态均匹配，且没有相反证据的情况，复用本问题的既有官方直连/Relay 对照：标注 `blocked-upstream`、问题编号及证据路径，明确 `revalidatedThisThread: false`。这是“匹配已确认的已知上游问题”，不能写成“本任务已重新完成对照”。新任务或更换模型本身不要求重跑完整定位。
4. 官方版本、原生环境或相关读取链变化，底层同样缺失内容，返回了错误任务，或是字段缺失、输出截断、部分回合内容异常等不符合既有对照的情况，不自动复用归因；将本问题列为优先候选，按下方步骤做必要对照。不能用旧 macOS 证据直接标记 Windows 上游阻断。

报告保留原始调用及失败证据，再追加归因说明。已知上游阻断不算通过，也不算新的 DeepSeek 兼容缺陷；整批状态仍依据所有必需项与前置条件判断。只有上述复用条件不再满足、出现相反证据，或官方更新后需要确认修复时，才重新展开完整排查。

## 已确认范围

2026-09-15，在 macOS arm64、官方桌面 build 9275、实际运行 CLI `0.154.0-alpha.6.2`、项目 Relay 协议 74 上确认。版本来自当轮实际二进制，不采用长期任务创建时的 session_meta 版本。本文记录此次已验证的失效机制，不代表所有 read_thread 异常都是同一原因，也不继承为 Windows 结论。

现象：官方 `read_thread` 返回两个已完成回合，但它们的 `items` 都为空；同一数据的底层完整读取能得到内容。

## 根因与对照

官方桌面的工具读取请求使用 `itemsView: full`。任务已经以 `paginated` 模式加载时，桌面 `readThreadTurnsPage` 将页面缓存的 `paginatedHistory.itemsBackwardsCursor` 交给每个回合的 `thread/items/list`。页面游标代表旧历史边界，套用到之后产生的回合会排除其内容。

从安装包只读提取的相关调用链为 `$wi → vwi → readThreadTurnsPage → qLt`；这些符号仅适用于此次构建。现场临时条件断点只记录入参且返回 false，不暂停执行，结束后已移除。

以下为同一任务两个完成回合的脱敏数量对照，A/B 为回合代称：

| 读取入口与参数 | 回合 A 的 items 数 | 回合 B 的 items 数 |
| --- | ---: | ---: |
| 当前官方桌面 read_thread | 0 | 0 |
| 正式 Relay，items/list，页面旧游标 | 0 | 0 |
| 正式 Relay，items/list，cursor: null | 24 | 36 |
| 同版本官方无 Relay，items/list，页面旧游标 | 0 | 0 |
| 同版本官方无 Relay，items/list，cursor: null | 24 | 36 |

除 cursor 外，底层请求均使用同一 threadId、turnId、`limit: 100`、`sortDirection: desc`，上述响应的 nextCursor 均为 null。旧游标的现场边界为 rolloutOrdinal 3627、includeAnchor true、scope.kind itemsByCreatedAtOrdinal；游标不可跨任务复用。

正式 Relay 与官方直连对相同参数的结果一致。此次问题定位在官方桌面为完整内容读取选用了页面历史游标，并非 Relay 删除历史或模型缺少工具。

## 复现步骤

1. 使用存在已完成回合、且桌面已加载分页历史的任务。记录当轮桌面 build、CLI 具体路径和版本、运行环境，并核对 rollout/SQLite 中的回合内容。
2. 调用官方 `read_thread`，记录出现空 items 的完成回合 ID。只读记录桌面对应请求实际使用的 itemsBackwardsCursor；不要自行构造游标。
3. 在正式 Relay 链路上，对同一 task/turn 分别使用现场游标和 null 发送以下请求：

   ```json
   {
     "method": "thread/items/list",
     "params": {
       "threadId": "<现场任务 ID>",
       "turnId": "<空内容的完成回合 ID>",
       "cursor": null,
       "limit": 100,
       "sortDirection": "desc"
     }
   }
   ```

4. 使用同一原生环境、同一 HOME/数据和同版本官方 CLI，独立启动无 Relay 的 `app-server --listen stdio://`。完成协议初始化后重放相同参数的两组请求，只比较 item 类型、数量和 nextCursor；不启动模型回合，不修改任务。
5. 若相同参数在两个底层入口结果不一致，停止套用本归因。若现场旧游标都为空而 null 都完整，并与桌面调用入参吻合，才确认此分页机制。其他异常继续单独定位。

仅有“桌面空、底层非空”的数量差异不足以确认游标根因；必须保留实际参数对照。

## 修复边界与验收

建议上游让工具完整内容读取使用独立分页，从 null 开始并沿该接口返回的 nextCursor 继续；页面 UI 的历史边界继续仅服务页面分页。此建议尚未在官方产品中实施或验证。

项目不在 Relay 中无条件清除 cursor，也不修改官方安装包。底层读取只能用于定位或明确标注的临时读取，不能替代官方 read_thread 的桌面通过证据。本项保持 `blocked-upstream`，待官方修复后重新验收。

另一个独立问题是验收器只接受 userMessage。真实委托输入可能是 codex_app.send_message_to_thread 的 functionCallOutput；报告版本 8 支持核验其中完整的委托输入，并明确要求 includeOutputs。该修复不能修复或掩盖 items 为空的问题，旧报告不自动升级为通过。

## 原始证据保留

现场文件位于被 Git 忽略的 `.runtime/read-thread-investigation/`：`desktop-cursor-comparison.json`、`official-cursor-control.json`、`direct.json`、`official-source-excerpts.json` 和 `diagnosis.md`。原始任务正文、具体任务标识、SQLite、凭据与完整官方代码不纳入提交材料；对外反馈可使用本文脱敏数量和复现步骤。本文尚未向上游发送。
