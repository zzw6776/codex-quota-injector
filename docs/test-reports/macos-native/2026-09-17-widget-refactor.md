# Widget 同步与渲染定向回归 — 2026-09-17

- 组件：免费回归 - 模拟模型，`free-common` 的 Widget 定向子集；没有执行原生 Relay 组件。
- 环境：macOS 原生、arm64；Node v26.7.0；Chrome 153.0.8010.48。
- 受测工作区版本：0.1.283，Widget 173；有既有未提交改动，不是正式发布包验收。
- 实际模型：无；真实模型请求：0。
- 最终执行状态：**passed，49/49，0 失败，0 跳过**。17 项同步/热加载契约、1 项桥接契约、30 项 Widget 浏览器用例、1 项前后对照，均以自动化检查项计数。
- 基线提交：`c8c65a8931645c9531e2a71f87ee70f05a0fe604`。前后对照仅替换本轮改动前的 Widget runtime、conversation-usage、contract 和 widget-session；这些文件在本轮开始时没有其他未提交改动。
- 输入清单摘要：`70646e69a20f53c7c6e51c042c859553f3b51b2e37fc93ccca6f1bc4a1ae235e`。私有 JSON 保存仓库相对路径、逐文件 SHA-256 和修改时间。清单在执行后采集，按对应批次开始时间检查，没有输入在该批次开始后修改；不把这份定向静态导入清单当成完整组件覆盖证明。
- 原始汇总：`.runtime/refactor-2026-09-17/report.json`；SHA-256：`0c2e3500635a8201a254cceaba0496f570237a93b30a97939734db2e001e9fb5`。

## 执行证据

以下文件均在执行机器 `.runtime/refactor-2026-09-17/`，原始日志与浏览器截图未上传。

| 原始结果 | 最终通过数 | SHA-256 |
| --- | --- | --- |
| `contracts.tap` | 17/17 | `ffd6eea8b9434c8339f1946d270065e4228d4cb1683e6741cace48c5c0821646` |
| `bridge-contract.tap` | 1/1 | `78a4567993621924c66e857b89a9b661a66d1683c84b6e49355a1565b5004a2e` |
| `browser-final.tap` | 30/30 | `22dd94a7a079e28799a6a410f95fdf223a94173c42a29f7d2a4fb264f6a9577d` |
| `comparison.tap` | 1/1 | `3511e13e2abadceb3e15f78855cce00d0d7cbb1e06bd6b190995526607ce8a88` |

对应命令：

```sh
node --test --test-concurrency=1 test/widget-session.test.mjs test/dev-runtime.test.mjs
node --test --test-name-pattern='Widget 桥接' test/runtime-contracts.test.mjs
node --test --test-concurrency=1 runtime-tests/widget-browser*.test.mjs
node --test .runtime/refactor-2026-09-17/compare.mjs
```

最后一项为一次性隔离对照脚本，原始脚本和结果保存在执行机器。长期回归由 `test/widget-session.test.mjs`、`runtime-tests/widget-browser-observation.test.mjs`、`runtime-tests/widget-browser-session.test.mjs` 及新增模型编辑公共状态用例承担。压缩打包的 Widget 也在本轮浏览器验证中通过，但没有验证正式应用安装包。

## 前后对照

| 场景 | 原实现 | 新实现 |
| --- | --- | --- |
| 连续六次流式正文更新：会话根查询数 | 6 | 0 |
| 账号、网络、用量同批变化：CDP 往返数 | 3 | 1 |
| 幸存页面 revision 为 1，首次重连应显示 42% | 错误显示 77% | 正确显示 42% |
| 模型编辑时公共额度从 77% 更新为 42% | 错误保留 77% | 正确显示 42%；表单节点、输入、焦点保留 |

另外覆盖同一连接重置、安装中换连接、批次异常后重新收敛、页面消失后重装、无数据变化的健康检查、网络小包不扫描历史、模型专用通道、rollout 短时空视图保护，以及页面任务切换和侧栏重建。

首次结果没有覆盖或改写：

- `browser-initial.tap` 为 8/9：性能断言通过，新增用例错误地期待文本出现 `100`，实际 UI 使用 `0.00M`。修正为检查绑定的真实 Token 数值，没有为通过测试修改数值格式。
- `model-page-before.tap` 为 0/1：确实复现模型编辑页额度停在 77%。修复公共渲染边界后，本用例纳入最终 30 项浏览器验证并通过。
- `browser-initial.tap`：`f4c5a06a697ec8e77b829823738fb92af00f82b34bb7618f214c71a874988fad`。
- `model-page-before.tap`：`eb24915cc3c08b61eb1ebce6eee2623f38005efe40094e28e65fee3c342dd761`。

## 本轮覆盖与未执行边界

| 测试组件 | macOS 原生 | Windows 原生 | WSL 原生 |
| --- | --- | --- | --- |
| 免费回归 - 模拟模型 | [定向 49/49，passed](2026-09-17-widget-refactor.md)，完整免费及原生 Relay 未在本轮执行 | 本轮未执行 | 本轮未执行 |
| 后台功能测试 - Codex 官方模型 | 本轮未执行 | 本轮未执行 | 本轮未执行 |
| 后台功能测试 - DeepSeek Flash | 本轮未执行 | 本轮未执行 | 本轮未执行 |
| 桌面集成测试 - Codex 官方模型 | 本轮未执行 | 本轮未执行 | 本轮未执行 |
| 桌面集成测试 - DeepSeek Flash | 本轮未执行 | 本轮未执行 | 本轮未执行 |
| 启停恢复测试 - Codex 官方模型 | 本轮未执行 | 本轮未执行 | 本轮未执行 |

“本轮未执行”不覆盖历史原始结论。未重新审核其他组件的历史报告输入，不能据此将它们全部标绿或全部作废。跨环境不继承本轮浏览器结果。

日常实例只读核验：正式模式 **0.1.282 / Widget 172，ready**。新 Widget 173 在临时真实浏览器完成安装、版本替换与重装；注入器后端不支持热加载，本轮未接管或重启日常实例。源码和隔离测试通过不表示日常实例已加载修改。

审查依据与设计说明见[架构审查](../../architecture-review-2026-09-17.md)。此报告保留重连和界面失效机制的修复前后证据，属于应额外保留的关键回归证据。
