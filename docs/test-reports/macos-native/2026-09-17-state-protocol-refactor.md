# 状态与协议重构定向验证

所属组件：**免费回归 - 模拟模型 / 公共组件定向验证**。运行环境：macOS 原生 arm64；不是完整免费回归，也不是 Windows/WSL 原生、模型后台、桌面或启停验收。

## 本轮最后统一执行

| 字段 | 记录 |
| --- | --- |
| 时间（UTC） | 2026-09-17 03:41:46.552 至 03:41:51.855 |
| 运行时 | Node v26.7.0，darwin arm64 |
| 工作区版本 | 应用 0.1.283、Widget 173、Relay 85 |
| 命令 | `node --test --test-reporter=tap`，显式指定下列 14 个文件 |
| 实际执行 | **67/67 passed**；0 failed、0 skipped、0 cancelled |
| 真实模型请求 | 0；上游、凭据和文件使用临时模拟材料 |
| 执行输入 | 执行前记录 SHA-256，结束后核对，无变化；[脱敏输入清单](2026-09-17-state-protocol-inputs.json) |
| 原始结果 | `.runtime/full-review/final.tap`；SHA-256 `b7d364286c5d59b038be6271b4b3f5cc771af8763c5ec668da89dbfaebe07998` |
| 私有执行记录 | `.runtime/full-review/final-inputs.json`、`final-report.json` |

输入清单为溯源快照，包含被收集但未执行的源码和测试文件；实际测试范围以下表为准。执行后只移除了 `scripts/build-windows-relay.mjs` 文件末尾的一个空行，并更新说明文档；原始输入摘要未被覆盖。该空白差异不要求重跑行为测试。

| 测试文件 | 关注契约 |
| --- | --- |
| `test/tool-schema-compat.test.mjs` | 引用展开、false 约束、合取、输出引用隔离 |
| `test/responses-tool-adapter.test.mjs` | 原生/桥接工具、命名空间、工具选择、SSE 还原 |
| `test/chat-compat-proxy.test.mjs` | 协议路由、工具历史续接、原生与桥接 Schema 边界 |
| `test/chat-protocol-tools.test.mjs` | 原始文本工具、增量历史、失败与隔离 |
| `test/model-router-capabilities.test.mjs` | 能力过滤、凭据隔离、官方透传、自定义桥接 |
| `test/model-configuration.test.mjs` | 模型配置与临时 CLI/目录迁移契约 |
| `test/model-configuration-context.test.mjs` | 覆盖值持久化、外部配置保护、三种写失败及后续恢复 |
| `test/model-configuration-catalog.test.mjs` | 参数验证、旧配置迁移、模型别名 |
| `test/model-configuration-deepseek-balance.test.mjs` | 保存、余额及 Key 变化后的状态 |
| `test/model-configuration-detection.test.mjs` | 保存与检测分离、检测结果应用、失败保留 |
| `test/model-configuration-detection-events.test.mjs` | 并发保存、乱序检测与旧请求隔离 |
| `test/windows-sea-support.test.mjs` | 模拟 PE 的签名移除、postject 伪成功拒绝 |
| `test/windows-artifact.test.mjs` | 模拟 PE/SEA 标识、体积和 fuse 检查 |
| `.runtime/full-review/subagents-comparison.test.mjs` | 相同材料下新旧归属结果及全量遍历计数 |

最后一项为一次性的改前/改后对照，改前源码和对照脚本留在私有材料目录，不作为产品依赖。生产测试 `test/token-usage-subagents.test.mjs` 保留多级子任务、缺失父任务、迟到时间修正和幂等行为覆盖。

## 子任务归属工作量

材料包含 1,400 个回合、100 份子任务元数据，包括无关任务、多级子任务与多个根回合。

| 指标 | 改前 | 改后 |
| --- | --- | --- |
| 完整回合集合遍历次数 | 400 | 1 |
| 上述遍历访问的回合数 | 560,000 | 1,400 |
| 最终所有回合数据 | 与改后完全相同 | 与改前完全相同 |

不统计局部分组内查找/排序成本，不代表整机性能或真实模型延迟。原始结果位于 `.runtime/full-review/subagents-comparison.json`。

## 此前执行记录，未重复测试

用户要求“中途不测试，最后再测试”之前，账号与子任务修改已经有以下执行结果。此处补归档原始结果，未重跑，也未把事后采集的输入摘要冒充当时清单。

| 范围 | 原始结果 | 材料与 SHA-256 |
| --- | --- | --- |
| 账号/凭据 7 个定向文件 | **56/56 passed**，0 失败/跳过；2026-09-17 03:18:58 UTC 写出报告 | `.runtime/full-review/accounts-after.tap`；`b35e509b27016171b7add0a69f174de85adf871911257a8ffb766d32b2423d81` |
| 子任务用量集成及多级归属 | **2/2 passed**，0 失败/跳过；2026-09-17 03:20:46 UTC 写出报告 | `.runtime/full-review/subagents-tests.tap`；`43a8cda94098a5b742399304efcd51ef4e4560e3f93fba23c8a2b207f26ed5bf` |
| 页面同步/渲染 | [49/49 passed](2026-09-17-widget-refactor.md)，保留该阶段范围和输入证据 | 不作为新增后台代码的验证结果 |

账号命令显式选择 `account-store`、`account-reliability`、`account-credentials`、`account-manager`、`account-transfer`、`account-oauth`、`account-wakeup` 七个 `.test.mjs`。覆盖切换失败的 current/lastUsed 一致性、移除时索引与账号文件写入失败、Cockpit 导入坏文件，以及 Keychain 命令错误不能泄漏假凭据。Keychain 用子进程替身注入失败，未访问真实钥匙串。

账号改前失败证据为 `.runtime/full-review/accounts-before.tap`（扩展名为 tap，内容实际为 spec），SHA-256 `35bec1dd73715af384da302cc39adf7767405f303268affa969b4f83e3361505`；原始 15 项中 9 通过、6 失败，保留真实失效机制。历史账号报告缺少事前分文件输入清单，当前适用性依据同任务改动记录、阅读摘要和文件时间做差异复核；不能借本次归档宣称全组件当前验收通过。

## 边界与生效状态

- 本轮未执行完整免费回归、真实模型、实际 Windows SEA 构建、Windows/WSL 原生运行或启停测试。
- macOS 上的模拟 PE 测试验证共享函数行为，不替代 Windows 构建与原生进程验证。
- 页面代码在此前临时 Chrome 中热加载到 Widget 173；本轮后台修改不支持热加载，没有为本任务重启日常实例。当前工作区源码通过定向验证不等于已安装版本生效。
- 收尾通过已安装应用的 Info.plist 只读核对，正式包版本仍为 0.1.282；没有执行 GUI 主程序的版本探测命令。
- 应用 0.1.283 为工作区已有版本；本任务未提交、未发布。其他任务既有宿主健康、生命周期和 Relay 工具改动的结果不并入这份报告。
