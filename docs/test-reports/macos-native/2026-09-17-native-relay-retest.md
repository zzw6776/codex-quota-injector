# 免费回归 - 模拟模型：原生 Relay 定向复测

环境：macOS 原生 arm64；官方 CLI `0.154.0-alpha.6.2`。当前工作区为 `0.1.283` / Widget 173 / Relay 85。

**2/2 passed，0 失败、0 跳过，真实模型请求 0 次。**

执行命令：

```sh
CODEX_TEST_RUNTIME_TARGET=macos-native node --test --test-concurrency=1 --test-reporter=tap runtime-tests/deepseek-tools.test.mjs runtime-tests/deepseek-history.test.mjs
```

实际官方 app-server 经 macOS 生产入口、Router 与兼容代理连接临时本地模型端点，子进程使用仅回环网络的 Seatbelt；没有访问真实模型供应商或改写日常配置。

| 用例 | 结果与证据范围 |
| --- | --- |
| DeepSeek Flash 原生 MCP 命名空间 | 通过。首次请求暴露只读 MCP，真实工具执行及同轮结果回灌有独立证据 |
| DeepSeek Flash 完整推理历史 | 通过。工具历史、恢复、分叉、压缩前后续接保持契约，不转发私有消息元数据 |

原始材料：`.runtime/retest-2026-09-17/native-relay.tap`、`native-evidence.json`。[脱敏摘要与输入记录](2026-09-17-native-relay-retest.json)。本轮源码及运行时摘要是在执行结束后采集，不冒充事前清单；用例实际版本来自执行诊断。

这是免费原生组件的两项定向结果，不替代完整免费、真实模型、桌面或启停验收。此前 67 项状态/协议、56 项账号、2 项子任务和49项页面的结果按各自范围保留。

重新注入后的只读检查确认实际页面 `0.1.283.dev / Widget 173`、Relay 85，任务工具 ready。已安装正式包元数据仍为 0.1.282；开发注入和安装包版本分别记录。
