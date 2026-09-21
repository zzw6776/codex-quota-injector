# 任务工具重检通知定向验证

- 执行日期：2026-09-21，Asia/Shanghai。
- 组件：免费回归 - 模拟模型的定向契约子集；不代表完整免费回归。
- 实际环境：Windows 原生 x64，Node v22.23.2；零真实模型请求。
- 源码版本：0.1.295 / Widget 180 / Relay 92。
- 基线提交：`26b9fd199610dfaf9be1ddf57a0743e5c9e26538`，已合入远端 0.1.294 的浮窗与开发启动更新。
- 原始执行状态：passed，49/49；0 失败、0 跳过。
- 对本次源码的适用性：所选定向用例有效；不延伸为实际桌面或 WSL 原生验收。

## 执行与覆盖

Windows 原生 Node 执行以下 6 个文件，全部用例通过：

```text
node --test --test-concurrency=1 --test-reporter=tap --test-reporter-destination=.runtime/test-results/host-tool-signal-20260921/windows.tap test/host-health.test.mjs test/host-tool-probes.test.mjs test/host-tools.test.mjs test/host-health-session.test.mjs test/wsl-readiness-console.test.mjs test/host-health-widget.test.mjs
```

覆盖请求原子落盘后通知、通知失败清理、generation 与稳定进程身份检查、模拟缺失文件事件时由信号消费请求、监听清理、任务探针分类、检查调度、任务选择及合并后的 Widget 展示契约。通知测试使用注入的执行器和信号事件模拟，不能作为实际 Windows→WSL 信号或正式 Relay 加载的通过证据。

版本一致性与 `git diff --check` 通过。未构建、安装、热加载或重启；本报告不声明运行中的应用已加载修复。

## 已知遗漏

此前审查已复现：首条消息前的 `read_thread` 错误改为“未确认”后，消息完成及重新选择任务不会自动复检；手动“重新检查”可恢复。本次按请求提交现有修复，未加入自动恢复逻辑，不能将 49 项通过解释为该遗漏已修复。

## 证据

- 原始 TAP：`.runtime/test-results/host-tool-signal-20260921/windows.tap`，留在执行机器，不随 Git 上传。
- 原始 TAP SHA-256：`5772fd42561fb7215f280a6dd743ae9a532a8dd953ecea1351a789d4c6976a41`。
- 受测源码 SHA-256：`e8b069614b0c7d4b71343a04143cf823486b450b64fcab6e0bb6572327211f1d`。
- 源码摘要算法：对 `git ls-files -z src test package.json package-lock.json` 返回的 262 个路径排序，逐文件计算原始字节 SHA-256，将 `{path,sha256}` 数组以 `JSON.stringify` 序列化后再计算 SHA-256。文档不计入摘要。
- 实际模型：不适用。正式包版本及运行中应用版本：本次未核验。
