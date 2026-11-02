# 2026-11-02 速率设计与价格更新定向验证

- 环境：macOS 原生 arm64，Node v26.7.0，临时 Chrome/156.0.8078.74。
- 源码：应用 0.1.340，Widget 209，Relay 102；未准备提交，因此未升级应用发布版本。价格更新不改变持久化用量结构，不升级 Relay。
- 范围：免费公共组件的局部验证；速率部分仅形成[设计](../../generation-rate-design.md)，未实施新采集协议，不把本次计价验证记作测速验收。
- 结果：基础契约 **60/60**、临时浏览器 **1/1**，零失败、零跳过；`git diff --check` 通过。没有真实模型测试请求、构建、安装、日常 Codex 重启、提交或推送。

## 执行与覆盖

基础命令：`node --test --test-concurrency=1 test/token-pricing.test.mjs test/token-usage-pricing-refresh.test.mjs test/token-usage-subagents.test.mjs test/token-usage.test.mjs test/token-usage-cache.test.mjs test/runtime-contracts.test.mjs test/wakeup-client.test.mjs`。

浏览器命令：`node --test runtime-tests/widget-browser-pricing.test.mjs`。首次 1/1 通过；视觉检查后只将说明拆成两行，最终同一用例再次 1/1 通过，不重复累计测试数。

覆盖 GPT-6.1 Terra 短/长上下文、缓存写入、已有用量缺失价格后的重新计算、多次短请求不误计长价、Flash 别名与 Pro 独立价格、峰谷上下界跨归档/供应商/子智能体累计，以及页面本轮/累计区间和按次费用说明。未知费用仍保留待确认状态。

基础 60 项执行后仅修改费用说明分行；相关计价与累计实现、缓存及断言均未变化，因此复用 60 项结果，仅复测受影响的浏览器展示。首次基础执行未独立采集完整输入指纹；以下清单属于最终源码，不冒充首次执行清单。原始输出、最终输入指纹和截图摘要保存在本机 `.runtime/test-results/2026-11-02-pricing-targeted.json`。

| 最终相关生产输入 | SHA-256 |
| --- | --- |
| `src/token-pricing.mjs` | `b8439030cd1cd68a75155f7db7a3020c8192750e75b55dcba4ed5e8a2104153f` |
| `src/token-usage/display.mjs` | `65a21764f93c38018bc6b17d16632e3fb0483828427f4a96e0f47d7fa2c7de5c` |
| `src/widget/contract.mjs` | `f7812437b8948d7696c0e86b03f7f516bdc3f895912d19a83d618b6804539a5a` |
| `src/widget/usage-display.mjs` | `0a9df12fd5a1101a9a0019e6d633f09447a432b145b4cc374cad105480de28b6` |
| `src/widget/usage-tooltip.mjs` | `72eff5d6f42944baecdcb5ab907905dd261c15c92a1fc51cb64b89e19023776d` |

最终浏览器截图 SHA-256：`aeff58c93e0688f88eea8427a5f5a14f539fe342d77799387a83b5282a1370fa`。截图只包含隔离测试材料，不复制用户聊天。

## 日常加载核对

只读核对日常注入器为 dev 0.1.340、页面 Widget 208。当前页面已有 GPT-6.1 Terra 的新短价 `1 / 0.05 / 1.25 / 5` 和长价 `2 / 0.1 / 2.5 / 7.5`，表明短生命周期统计服务已加载新价表。Widget 209 的峰谷区间界面已在临时浏览器通过，日常页面尚未加载；原生页面不能冒充已生效。

现有开发热加载要求后台源码指纹一致；本轮同时包含后台价格与累计逻辑变化，不通过可能触发后台接管的启动路径刷新日常客户端。没有执行接管或重启。

## 六组件与原生环境边界

| 测试组件 | macOS 原生 arm64 | Windows 原生 | WSL 原生 |
| --- | --- | --- | --- |
| 免费回归 - 模拟模型 | 公共组件定向基础 60/60、浏览器 1/1；未重跑完整免费或原生 Relay | 未原生复测，既有执行结论未重新裁定 | 未原生复测，既有执行结论未重新裁定 |
| 后台功能测试 - Codex 官方模型 | 本轮未执行真实模型，既有结果另按输入复用 | 同左 | 同左 |
| 后台功能测试 - DeepSeek Flash | 本轮未执行真实模型，既有结果另按输入复用 | 同左 | 同左 |
| 桌面集成测试 - Codex 官方模型 | 本轮未执行，临时浏览器不能代替 | 本轮未执行 | 本轮未执行 |
| 桌面集成测试 - DeepSeek Flash | 本轮未执行，临时浏览器不能代替 | 本轮未执行 | 本轮未执行 |
| 启停恢复测试 - Codex 官方模型 | 本轮未执行 | 本轮未执行 | 本轮未执行 |

未新增或接受任何上游阻断项；不以本轮局部通过覆盖其他环境、模型与历史报告的真实状态。[价格来源与估价边界](../../pricing-2026-11-02.md)单独保留。
