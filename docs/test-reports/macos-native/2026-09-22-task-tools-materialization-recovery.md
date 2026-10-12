# 新任务读取检查的触发与有界恢复

- 日期：2026-09-22；macOS 27.0 / arm64；Node 26.7.0。
- 源码：应用 0.1.296、Relay 93、Widget 180、健康文件结构 4；基于 HEAD `26b9fd1` 加本地修改。未提交、未安装、未重启日常应用。
- 本报告替代 0.1.295 预览包的单次补测方案。旧报告保留当时真实执行记录，不能作为最终调度器的验证。

## 根因与方案

此前一次补测同时由 `turn/start` 响应和 `turn/started` 触发，把开始回合当作历史可读的依据；若补测仍返回未落盘错误，就耗尽恢复机会。新版删除这两个触发点，仅在 `item/completed` 的 `userMessage` 后允许补测。该事件表示用户消息已被处理，仍不将它解释为磁盘持久化承诺；只有实际 `read_thread` 返回符合契约的数据才算通过。

首次收到精确的未落盘错误时保持等待，不显示故障横幅。观察到用户消息后仅重试 `read_thread`，最多四次自动补测，延时依次为 0、250、1000、3000 ms（每次从上次已返回的同类错误起算）；每次调用仍有既有 15 秒超时。成功后保留四项证据，权限等其他错误或超时直接保留真实结果；预算耗尽后显示未确认，仍可手动检查。重复消息不重置预算。

重连、MCP 重载和关闭取消旧计时器，派发前再次校验任务、连接代次和当前结果；手动检查开始时取消退避计时器。MCP 重载清除工具证据，但保留已观察到的用户消息事实。删除原调度器的 `materialized` 集合，消息事实由健康上下文单独持有。

选择事件触发加有界退避，是为了同时避免固定启动延时、单次补测再次过早、以及空任务的持续轮询。它不掩盖持久化故障，也不承诺任意长的磁盘故障能自动恢复。

## 原生对照与验证边界

官方 CLI 实际执行版本 `0.155.0-alpha.9.2`；SHA-256：`9280c0754e8f1f6b72f495d30c8c82a006dbc4995bf0492916fa0901f6bfd1f9`。用临时 HOME/CODEX_HOME、假凭据、本地模拟响应和 macOS loopback-only 沙箱，分别执行官方直连与生产 Swift shim/Relay；零真实模型请求。

新增 MCP 夹具中的 `read_thread` 通过本地桥接调用同一个官方 app-server 的真实 `thread/turns/list`，不合成历史读取成功。两条链都在首条消息前得到真实未落盘错误，用户消息完成后读到一个回合。Relay 自动从等待变为四项通过，期间助手响应被门闩暂缓，证明恢复无需等待助手回合结束。其他三个 MCP 工具返回结构夹具，因此不代表真实桌面四个工具端到端验收。

延迟多个重试周期、顺序颠倒、重复通知、预算耗尽、其他错误、关闭/重连/重载及手动检查由确定性单元测试覆盖。未在日常桌面安装，未执行真实模型、启停恢复或 Windows/WSL 测试。

## 测试结果

| 范围 | 最终适用结果 | 原始证据 |
| --- | --- | --- |
| host-health / host-tools / relay-protocol | 17 + 27 + 14 = 58/58 | `.runtime/task-tools-materialization/final-unit.tap` |
| host-tool-probes / app-server-relay | 3 + 11 = 14/14，复用本轮首批结果；随后这四个源码/测试文件未再修改 | `.runtime/task-tools-materialization/unit.tap` |
| 官方直连 / 正式 Relay 原生历史对照 | 2/2；最终健康状态改动后重新执行 | `.runtime/task-tools-materialization/final-native.tap` |
| git diff --check、三处应用版本、Relay 版本 | 通过 | 本轮命令输出 |
| DMG 镜像校验、只读挂载、快捷方式、资源、版本、架构、签名 | 通过 | `.runtime/task-tools-materialization/package.log`、`package-verification.json` |

单元测试最终覆盖 72 个不重复用例，不把两批重叠用例相加。原生 2 项独立统计；不代表完整免费回归。

探索阶段的临时观察脚本 0/2：两条链均完成了历史观察，但退出清理触发 `waiter.reject is not a function`（临时观察器未提供退出回调）。保留 `probe.tap`，不将失败计为通过；正式新增用例移除了该观察器，以上原生 2/2 来自正式用例。探索期间 `turn/start` 响应后的直接读取出现空页或未支持错误，只作为触发点不稳定的观察，不额外归因为项目回归或接受的上游问题。

## 0.1.296 arm64 预览包

文件：`release/macos-arm64-preview-20260922-0.1.296/Codex-Quota-Injector-0.1.296-macos-arm64.dmg`。

- 大小：42,597,822 字节；SHA-256：`327daa77f54fe11d17e8611d24f3ea79ac87b43f255beefac21f085952c0f9ae`。
- SEA 使用 Node 22.23.1 arm64；构建输入为本报告所列源码。已有 `import.meta` / CJS 构建警告保留在 `build.log`，构建成功；未通过启动正式包验证这些既有路径。
- `hdiutil verify` 通过；挂载后 `Applications -> /Applications`，应用版本 0.1.296，启动器/Worker/shim 均为 arm64，图标及 Node 许可证存在，`codesign --verify --deep --strict` 通过（ad-hoc 签名）。已卸载镜像。
- 未安装、未启动该预览包；不能将源码与隔离 Relay 测试视为日常运行版本已更新。

## 输入与原始结果摘要

完整本机清单：`.runtime/task-tools-materialization/input-hashes.json`。

| 输入/证据 | SHA-256 |
| --- | --- |
| `src/host-tool-probes.mjs` | `8ff167baa29825257d733d7d9192cfe973fc6f8d6bae5bf9dd72347b9b5bcf73` |
| `src/host-health.mjs` | `5b1e73937486703f91645a5bda3b96f513a8a7c5999bdf1772a7be6910557f10` |
| `src/app-server-relay/host-tools.mjs` | `ae420eacec14475ce1e8afe1b271205c0fe3f44c553eccd081a8429cbb6d146e` |
| `src/app-server-relay/server-messages.mjs` | `84c1951d4ae5cfe1867a7c505f1f2340b03087b36d0d59c2246b3c130e06c112` |
| `src/relay-contract.mjs` | `4377f310bb5fa0ec21ad06580b7ed006fda4610af1dc15a879c8f1724ec45ebe` |
| `test/host-tools.test.mjs` | `25dbb081bb470fb5e0d283cc9c340d5dbbdd77380ae3c571a4172e8e2fb6604a` |
| `runtime-tests/host-health-materialization.test.mjs` | `6f1cc03256c093f8fbb02adad37966682b61ce21665d1a641ab08c3335f8fe03` |
| `.runtime/task-tools-materialization/probe.tap` | `f5374652cf40d454324c1b7b1ebe07af547f197cd1c0239ed432b453efcf5a08` |
| `.runtime/task-tools-materialization/unit.tap` | `31b59ff1286ea52a6ea6a6684795426ebaf6b8175f4f7940ab1564d61254fe89` |
| `.runtime/task-tools-materialization/final-unit.tap` | `c459dea7baa4d0bd2b1735d031d7077167e5c017ee700bb2c98646f300d2ab5d` |
| `.runtime/task-tools-materialization/native.tap` | `28afe1b05f7560713c7fe3bdc2059537cb23f5274951985489d2c72776226b6d` |
| `.runtime/task-tools-materialization/final-native.tap` | `463f8458947eff62cc490a620a55edf6781596fa2845c864613edffb226476ec` |
