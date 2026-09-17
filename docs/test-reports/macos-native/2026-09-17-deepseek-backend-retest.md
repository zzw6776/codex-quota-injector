# 后台功能测试 - DeepSeek Flash：重新注入后复测

环境：macOS 原生 arm64；实际模型 `deepseek-flash`。工作区 `0.1.283` / Widget 173 / Relay 85。

**4/4 passed，0 失败、0 跳过。** 后台执行输入和 CLI、Node、浏览器摘要结束后核对均可复用；桌面结果另行保存。

```sh
node scripts/test-live.mjs --profile=deepseek --runtime=macos-native --confirm-token-use
```

仅加载已启用、当前检测有效的 DeepSeek Flash 预设，隔离其他模型。隔离 app-server 经当前源码的生产 Relay、模型目录与路由链调用真实供应商；不改写日常凭据、配置或账号。

| 独立阶段 | 结果 | 观察 Token | 常规轮次 |
| --- | --- | --- | --- |
| 工具 | passed；读取、补丁、MCP 直调及模型调用分别核对 | 271,759 | 2 |
| 历史 | passed；短历史恢复和分叉保留口令 | 223,733 | 3 |
| 压缩 | passed；真实压缩事件与压缩后历史核对 | 96,632 | 2 |
| 回调 | passed；动态网页/浏览器、图片识色和用户输入回调 | 362,197 | 3 |

累计观察 **954,321 Token、10 个常规轮次**。四阶段分别执行 500,000 Token / 40 轮的现有停止阈值；计数包含重复输入上下文等供应商计量，不是新生成文字长度或精确账单。动态 fixture 网页/浏览器验证 app-server 回调，不冒充真实桌面 web.run 或 computer use。

原始结果：`.runtime/test-results/live-deepseek-macos-native.json` 及对应四个 `live-<阶段>-deepseek-macos-native-events.jsonl`；控制台保留于 `.runtime/retest-2026-09-17/deepseek-backend.log`。[脱敏结果、执行时间、原始 SHA-256 与输入清单](2026-09-17-deepseek-backend-retest.json)。归档绑定后台结束时的结果；桌面验收器随后会更新原后台文件的桌面状态，因此该文件之后的摘要变化不抹除原后台执行证据。

不继承为官方模型、Windows/WSL 原生或启停通过结论；本轮没有运行账号独立唤醒。其他环境的历史结果保留原状态。
