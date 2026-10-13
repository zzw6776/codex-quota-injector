# 更新确认页展示版本更新日志

- 日期：2026-10-12；源码 0.1.322，macOS arm64，Node v26.7.0，Chrome/155.0.8059.39。
- 范围：免费回归 - 模拟模型 / macos-native 的更新候选与确认页定向子集，未执行完整免费、真实模型、安装或启停恢复。Widget 和 Relay 输入及版本未改变。

## 变更与结果

GitHub Release 正文随目标安装包传入更新 Worker，在第一级确认页的“立即更新”按钮上方显示“更新日志”。原文保留换行，以纯文本展示；长内容独立滚动，发布说明缺失时明确提示。同版本安装包的说明发生变化时不复用旧确认页，防止显示过时内容。

| 验证 | 原始结果 | 覆盖 |
| --- | --- | --- |
| 更新契约 | 25/25，passed | Release 正文到确认页、缺失/空白说明、HTML 转义、日志变化后的候选复用判断及既有更新契约 |
| 浏览器定向 | 2/2，passed | 500×510 原生窗口尺寸下长日志完整保留、滚动与按钮可见；缺失提示；下载后恢复进度页；原有进度与终态展示 |
| 隔离 macOS WebKit | passed | 新 Worker 确认页实际加载并上报就绪；完整日志进入原生窗口服务；相同日志复用自身窗口；关闭请求成功，零下载 |

原生视觉截图未确认：Computer Use 无法选择独立的非 `.app` 更新窗口可执行文件，应用清单也未列出该窗口。版式与滚动证据来自真实 Chrome；不将其作为 Windows/WSL 或原生 WebKit 视觉验收。

日常正式应用保持 0.1.321，同一 PID 未变化。源码 0.1.322 尚未安装生效，独立验证窗口已关闭；未打包、提交或推送。

私有材料保留 `.runtime/update-release-notes-20261012/`：`contracts.tap`、`browser.tap`、`native-result.json` 和本轮输入清单 `inputs.json`。输入清单记录直接更新模块、原生窗口源码和执行夹具，摘要见下表。

| 材料 | SHA-256 |
| --- | --- |
| inputs.json | `15063e2dea83afe21d80a9a7750e9836e706d5cfaac8974f4c293ff783a1881c` |
| contracts.tap | `3869a87c46577b58924a90fbb7d2da7cf1b4e72076c88e9ae92fa3252a4bf5c0` |
| browser.tap | `7bc18851f33c5ca063ecd2e5c80971f4eb71f33bef4d42576c4b8653602692e3` |
| native-result.json | `2fb0b3cb67cd60359c0445e82e8407880edee85b9e9f0716f61d5cd008c5d05a` |
