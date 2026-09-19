# 2026-09-19 turn state 生命周期与日志保护定向验证

- 组件：免费回归 - 模拟模型（Router 定向子集，不是完整免费回归）。
- 环境：WSL 原生 Linux x64，Node v22.23.1；源码、依赖、测试和 SEA 构建全部在独立 Linux 目录执行。
- 受测代码：上游基线 `3bfb274`，工作区应用 0.1.291 / Relay 89 / 全量诊断 Schema 2；尚未提交、安装或重启。
- 最终执行：`node --test --test-concurrency=1 test/model-router*.test.mjs`，55/55 通过，失败、跳过、中止均为 0。
- 首次执行：53/54，轮换用例失败；根因为同一缓冲批超过阈值时只按整批写入，未按完整 JSONL 记录分段。修复后该用例单独 1/1、相关套件 54/54；加入 Windows ACL 解析契约后最终统一执行 55/55。首次失败原样保留。
- 构建：WSL 原生 SEA 0.1.291 成功并通过构建脚本的 ELF 校验；Windows 原生和 macOS 未构建、未执行。
- 真实模型请求：测试为 0。生命周期分析只读取已经由用户日常会话产生的本机日志，没有为验证额外调用模型。

## 新增契约

- `current_turn_state` 与 `x-codex-turn-state` 都生成字段路径、字符/字节长度和 SHA-256 索引，原始日志继续保留完整值。
- 生命周期分析按连接、请求、回合和模型关联，区分 HTTP 状态、协议数值字段、state 长度与 state 指纹；输出报告不含原值、正文或凭据。
- 单文件 256 MiB 轮换，不拆 JSONL 记录，不自动删除旧分片；分析器自动读取全部分片。
- WSL/Windows 数据盘日志创建后禁用 ACL 继承并移除 `CodexSandboxUsers`，保留所有者、SYSTEM 和 Administrators；无法收紧时记录警告。当前既有日志已实际核对并收紧。

## 当前会话只读证据快照

本机脱敏报告快照覆盖 26,276 条诊断事件、67 个模型请求：Astra 29 个请求/16 个 state，Sol 38 个请求/38 个 state；54 个 state 指纹全部不同。HTTP 状态只有两次 WebSocket 101，HTTP 292/312 和协议 292/312 均为 0。请求侧 state 为 0；一次收到 state 后的同回合重连也没有回传。

实际 CLI `0.155.0-alpha.2.6` 对应源码中，HTTP Responses 选项会附带缓存 state，但 WebSocket 建连路径明确传入 `turn_state: None`，与抓取结果一致。第三方文章使用不同端点且没有可审计工具源码，未执行 Chat Completions 注入或绕过实验。详细边界见[调查记录](../../turn-state-investigation.md)。

## 原始材料

- 首次失败事件：`.runtime/test-results/state-analysis-0.1.291/events-first-failed.jsonl`，SHA-256 `40dee80e2bcd8aea035d90a05fbeb7e18e2662f8fc80fa7a92472ac02c424bde`
- 轮换修复后事件：`.runtime/test-results/state-analysis-0.1.291/events-before-acl.jsonl`，SHA-256 `fc1a4f904a8145bd540f913e1a841730f735d21187b0965a3ba4078dd6acb498`
- 最终事件：`.runtime/test-results/state-analysis-0.1.291/events-final.jsonl`，SHA-256 `c579aca32d4e5439a5fe5463a6e3082b1c8481fab9be3ef0883c4bbdb8599766`
- 脱敏生命周期快照：`.runtime/analysis/state-lifecycle-01a0b7ae.json`，SHA-256 `f0b3ed6a68a291b1c52af73181f6d5345334bc4023436f5b6fc5f659628433b5`
- WSL SEA：`.runtime/artifacts/state-analysis-0.1.291/codex-quota-relay-wsl-0.1.291`，SHA-256 `7071ce85f76387f75460ed9075017a4a0fe2797d9148a50092ad320f321a4a70`

原始材料保留在执行机器，不随 Git 上传；生命周期快照不含 state 原值、请求正文或凭据。日常仍运行 0.1.290 / Relay 88，当前会话已收紧 ACL，但源码新增索引、自动轮换和后续新文件 ACL 处理尚未加载。本结果不替代完整免费回归、真实模型、桌面集成或启停恢复验收。
