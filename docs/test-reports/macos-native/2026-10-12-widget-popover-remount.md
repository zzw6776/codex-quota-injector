# Widget 侧栏重挂载后的浮层恢复

- 组件：免费回归 - 模拟模型的浏览器定向子集，macOS 原生 arm64；不代表完整免费回归或真实模型桌面验收。
- 源码应用版本 `0.1.314`，Widget `193`；Relay 未改。Node `26.7.0`，Chrome `155.0.8059.39`；实际桌面 `26.1007.30912` / build `20156`。
- 日常实例仍为开发版 `0.1.311` / Widget `192`。没有提交、打包、安装或重启；零新增模型测试请求。其他后台改动属于已有工作，不在本轮验证范围。

## 失效机制与修改

实际页面只有一个 Widget。主面板有 `popover="manual"`，但展开后 `:popover-open` 为 false。新版侧栏有 `contain: layout paint`、`isolation: isolate`，丢失顶层状态后，面板在侧栏内被裁切并被任务列表遮挡。

真实浏览器回归证明：移动注入器根节点或其祖先，会自动关闭原生 Popover，而已有 `is-open` 状态、Shadow DOM 和表单节点仍保留。原实现只在面板重建时 `showPopover()`，重挂载时只定位，未恢复顶层状态。

`positionPopover()` 现在先恢复主面板顶层再测量和定位；诊断浮窗同样恢复。仍保留原有关闭样式、节点与草稿，不改官方侧栏样式。Widget 版本递增为 193。

## 定向结果及首次失败

1. 修复前新增真实侧栏重挂载用例 **0/1，failed**：主面板与诊断浮窗均不在顶层，侧栏内外实际命中均失败。保留 `.runtime/ui-popover-diagnosis/before-test.tap`。
2. 第一次修复后布局与导航 **7/9，failed**：迁移恢复成功；新增用例末段另外触发已有的关闭主面板后立即重开诊断浮窗状态缓存问题，未计为迁移修复通过，未在本轮扩展修改。最终用例按本轮目标验证关闭后的主面板重开，并确认已关闭的诊断浮窗不会随迁移重新出现。
3. 同批窄窗口拖动失败在隔离旧代码上也复现：测试页面的文档滚动条使 x=466 落在实际可命中区域外。真实桌面 html/body 为 overflow:hidden，校正该用例的宿主样式后通过；未修改生产布局规避。
4. 最终导航与布局 **9/9，passed**；挂载/换版本/原生输入、逐项诊断操作、窄窗口诊断与草稿 **3/3，passed**。本轮最终合计 **12/12**，无跳过。

执行入口：

```sh
node --test --test-concurrency=1 runtime-tests/widget-browser-navigation-rail.test.mjs runtime-tests/widget-browser-layout.test.mjs
node --test --test-name-pattern='挂载、重复注入|逐项检查详情|紧凑检查浮窗' runtime-tests/widget-browser.test.mjs
```

完整执行输入及原始报告 SHA-256：`.runtime/ui-popover-diagnosis/inputs.json`。原始日志、隔离旧代码材料与浏览器截图保留 `.runtime/ui-popover-diagnosis/`、`.runtime/test-results/`，不上传账号与会话截图。

## 当前运行状态

在实际页面对旧主面板执行 `showPopover()` 后，面板恢复顶层，侧栏内和超出侧栏的部分均正确命中，截图显示遮挡消失。这只是本次页面状态恢复，未冒充加载 Widget 193。

随后发送保留当前版本的开发页面更新请求，响应 `keep`；实际 PID 和页面版本均未变化。当前后台已有其他源码变更，纯页面更新身份不匹配；没有改为接管或重启。最终只读状态仍为开发版 0.1.311 / Widget 192，面板在顶层但已关闭。永久修复待下次正常启动开发版加载。

本轮验证仅确认 macOS 的本问题和相关页面交互；Windows/WSL 原生环境未重新执行。此问题属于项目浮层恢复缺陷，不能套用上游接受项。
