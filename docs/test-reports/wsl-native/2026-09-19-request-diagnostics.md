# 2026-09-19 模型请求全量日志定向验证

- 组件：免费回归 - 模拟模型（仅 Router 定向用例，不是完整免费回归）。
- 环境：WSL 原生 Linux x64，Node v22.23.1；源码和锁文件复制到 Linux 文件系统，在独立目录执行 `npm ci`、测试及 SEA 构建，未使用 Windows 依赖或缓存。
- 受测代码：上游基线 `3bfb274`，工作区应用 0.1.290 / Relay 88；尚未提交。
- 执行：2026-09-19，`node --test --test-concurrency=1 test/model-router*.test.mjs`，另外配置 spec 和 JSON 事件 reporter。
- 原始执行状态：`passed`，52/52，失败、跳过、中止均为 0。其中新增全量日志契约 12 项，既有 Router 用例 40 项；全部为此次执行，不借用其他平台结果。
- 真实模型请求：0；未执行后台、桌面集成或启停恢复测试，未重启、未安装。

## 覆盖与边界

新增契约覆盖 HTTP 200/292/312/429/500 的实际状态码与完整凭据、Cookie、state、正文；无任务 ID 的辅助接口；压缩请求与响应原始字节；大 SSE 不截断；连接失败不伪造上游状态；WebSocket 101 握手与各次生成/预热分离；312 拒绝握手仍保持原有关闭行为；自定义 HTTP 桥实际密钥与重写请求；客户端中断时保留已收到的正文。

旧日志的脱敏结构测试继续通过：完整原文只进入新增独立诊断文件，不进入普通结构诊断。测试中的密钥和正文均为模拟材料，归档不包含实际凭据或会话。

独立 WSL 原生 SEA 构建成功，产物通过构建脚本的 ELF 校验，并以 `file` 确认为 Linux x86-64 ELF。没有执行正式包安装或实际客户端流量验收；Windows 原生和 macOS 未构建、未执行。日常 Relay 仍是 0.1.282，新源码和产物不能作为当前 Astra 会话已开始记录、或属于 292/312 的证据。

## 原始材料

- 事件：`.runtime/test-results/request-diagnostics-0.1.290/events.jsonl`
- SHA-256：`64a25e515b39c76a1be2cd69ac9d91602b094b6376351b35afcb761480bda6fa`
- 构建产物：`.runtime/artifacts/request-diagnostics-0.1.290/codex-quota-relay-wsl-0.1.290`
- SHA-256：`59f191df725b359db869d8691a0355b9c75aaa81926e5392ff4a5bfe62220697`

材料保留在执行机器，不随 Git 上传。执行后对共享源码与 Linux 快照的整个 `src`、`test` 和锁文件进行逐字节差异核对；没有差异。下表是本次直接变更的行为输入，不代表完整依赖清单；其他输入以基线与工作区差异审计为准。

| 输入 | SHA-256 |
| --- | --- |
| `src/model-router.mjs` | `7765d6b94a44fefad83b5d65e70476ec102fdd7918d4c9a8e54164275c013dc9` |
| `src/model-router/transport-diagnostics.mjs` | `e007f33d9763df6594ba4d287e161e8760ec9b386073745f2668dfc79e3abfd5` |
| `src/model-router/http-transport.mjs` | `816a2d8742b948dcdc463cf5d65cc547520ef44d889cd4c3073782faeb317896` |
| `src/model-router/websocket-bridge.mjs` | `b3fb6e15338972c0d8c4fc78df48c1337aa2cc4c433022a613a834997c84a931` |
| `src/model-router/websocket-transport.mjs` | `5fd6d0451dd0c4ea9bb5b3b3fe6b0a9811196f5aef1173ce9e78ea7796f68641` |
| `src/relay-contract.mjs` | `598f4fa205aad38f246e336c040abcaab95a01021608eb4104abe533c865ad5a` |
| `test/model-router-transport-diagnostics.test.mjs` | `1d30974a3ec6d269f66dc50cd3eb198b6a8e02e66a17b1643e58e52ea77215c3` |

后续仅文档、版本号或报告变化不要求重跑这些行为用例；部署、正式包和其他原生环境仍独立留证。
