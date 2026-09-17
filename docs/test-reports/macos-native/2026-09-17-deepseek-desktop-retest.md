# 桌面集成测试 - DeepSeek Flash：重新注入后复测

环境：macOS 原生 arm64；实际模型 `deepseek-flash`；桌面加载 `0.1.283.dev / Widget 173 / Relay 85`。已安装正式包元数据为 0.1.282，不混同开发注入版本。

**13/13 passed，3 项不适用。** 后台四阶段已经通过且输入及运行时匹配，本轮 DeepSeek 在 macOS 原生环境的后台与桌面均通过。未套用上游失败接受项。

执行：`node scripts/test-desktop-host.mjs --profile=deepseek --runtime=macos-native --trigger-mode=delegated --confirm-token-use`。使用新建的短历史任务，先完成准备回合，再在一个标记绑定回合执行验收。

| 项目 | 结果 |
| --- | --- |
| 输入、版本、协议、原生环境 | passed，执行期间输入保持一致 |
| 实际模型、回合正常结束 | passed |
| 成功命令、失败退出码 23 后续接 | passed，有真实返回和标记 |
| list_threads / read_thread / list_projects / get_usage_limits | 全部 passed；读取正确任务，准备回合含完整委托输入与助手回复 |
| Computer use 页面、输入、单次提交 | passed；HTTP 材料服务独立记录一次页面请求、一次正确提交、零错误提交 |
| 实际截图、下载 | passed；真实截图调用及下载调用有返回。服务端产物请求为 2 次，如实保留，不描述为单次下载 |
| web.run 搜索 / 打开 / 查找 | 三项 unsupported，不适用；本轮真实工具清单没有独立 web.run |

验收编号 `20260917035307-94fb1f3e`，结束于 2026-09-17 03:56:10.755 UTC。首个浏览器清单调用曾返回 `Unable to load browser request-header policy`，同回合随后正常返回并完成实际操作；保留调用记录，不归为项目缺陷。

原始报告 `.runtime/test-results/desktop-host/20260917035307-94fb1f3e/report.json`，相邻 `progress.html` 为实时报告；控制台 `.runtime/retest-2026-09-17/deepseek-desktop.log`。[脱敏逐项结果、输入、运行时和原始摘要](2026-09-17-deepseek-desktop-retest.json)。后台原始文件由桌面验收器同步整体 passed，后台执行证据仍以[后台归档](2026-09-17-deepseek-backend-retest.md)为准。

未复测官方桌面、Windows/WSL 或其他供应商；Apps、语音、媒体、自动化等条件能力不自动获得通过结论。启停恢复另行保存。
