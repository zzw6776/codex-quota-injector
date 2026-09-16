# 桌面已知问题快速判定

遇到异常先核对本表，再决定是否需要对照。已确认问题只复用归因，不跨任务复用随机标记或功能执行结果；供应商变化、项目发布版本和无关文档修改不会单独触发完整定位、付费重测或重启。

| 症状 | 已确认原因 | 快速核对 | 本机证据 |
| --- | --- | --- | --- |
| read_thread 成功返回正确任务，completed 回合显式 items: [] | 官方桌面把旧页面历史游标用于之后产生的回合，过滤了内容 | 实际官方 build/CLI/环境匹配；SQLite 或 rollout 确有完整内容；历史为 paginated；实际页面游标边界早于空回合；相关读取链未改变 | `.runtime/wsl-desktop-attribution-20260916/official-relay-cursor-comparison.json` 与 `desktop-live-cursors.json`；完整排查见 [分页说明](read-thread-pagination-investigation.md) |
| WSL 任务无 node_repl，MCP 启动 ENOENT | 旧 Windows 任务切到 WSL 后，cwd 被拼成不存在的 Linux 路径 | 实际任务执行 cwd 是错误拼接路径且目录不存在；node_repl 可执行文件存在；官方 MCP 日志为启动 No such file or directory，或省略无就绪客户端的 node_repl；环境和启动链匹配已知对照 | `.runtime/wsl-desktop-attribution-20260916/native-mcp-compatibility-comparison.json` 与 `node-repl-runtime-logs.json` |
| Windows 实际截图返回 SetIsBorderRequired 0x80004002 | 同版本官方 Windows 截图接口在无 Relay 时也失败 | 必须有本轮真实截图调用和相同错误；Windows 原生环境、实际 CLI 字节版本、截图接口匹配旧对照 | `.runtime/official-computer-use-screenshot-control-windows.json`；不能用于尚未调用截图的 WSL 任务 |
| WSL 启停接管仅 hostToolsReady 超时，全局 MCP 目录为空但任务通知 ready | 项目健康检查漏核验任务专属工具目录；不属于可接受放行的上游问题 | 同版本官方与 Relay 的全局列表都为空，指定 ready 通知中的同一任务后 connected 且四个必需工具完整；先核对 Relay 82 修复是否已加载 | `.runtime/lifecycle-preparation-20260916/host-status-comparison.json`；修复后的原生 ELF 证据见 `host-status-fixed-native-elf.json` |

## 已确认环境

WSL 两项于 2026-09-16 在 Windows 桌面 `26.908.40834` / WSL Linux x64、实际官方 Linux CLI `0.154.0-alpha.6.2` 上确认。CLI SHA-256 为 `6970ad6a5b7615d2f5838879e19c1369e5527cb1544f1515f76900267740a403`；受测项目版本 `0.1.279`，Relay 81。分页对照分别返回 0/0/0/0 与 17/2/38/3 条，官方与正式 Relay 响应一致。启动对照中，两组错误 cwd 在官方无 Relay 与正式 Relay 上均无 js 工具，正确 `/mnt/d/...` 原生目录在两条链上均有 js。

node_repl 的证据只确认该跨环境 cwd 失效机制，不表示 WSL 普遍缺少入口，也不证明 Windows 图形交互在 WSL 下实际成功。截图因同一入口启动失败而未调用时，共用该兼容性归因，不重新查 Windows 截图错误。

## 再次出现时的顺序

1. 核对当前任务、回合、错误原文和实际原生环境。版本用当前 CLI 二进制和官方桌面元数据，不能用旧任务创建时的 session_meta。
2. 检查本机证据文件及表中条件。原始调用、SQLite/rollout、目录存在性等只读材料足以核对时，不重新发起模型任务。读取问题必要时只捕获实际游标，不构造历史游标。
3. 条件全部匹配且相关链未改动：引用既有证据，标注当前任务/回合、环境及 `revalidatedThisThread: false`。不因新任务或换模型重复完整对照；游标值不能跨任务照抄。
4. 官方更新、实际二进制变化、调用链变化、证据缺失或错误形态不匹配：只补受影响问题的最小官方无 Relay/正式 Relay 对照。无需全套回归；未确认前不接受为通过。

任务准备时先检查实际 cwd 存在且属于当前原生环境。完整 WSL 原生交互应使用目录有效的专用任务；旧 Windows 任务目录已失效时，不继续用它反复诱导模型重试。

## 通过报告口径

用户已明确要求，经确认属于官方上游或环境兼容性问题的阻断可接受为验收通过。保留原始执行报告及真实通过数，另存通过验收报告，分别记录实际通过、接受上游、接受兼容性、不适用和未确认数量。只有其他适用项都通过且未确认/项目回归数量为 0 时，整体验收才通过。

通过报告必须绑定当次任务、回合、源码输入和环境，注明归因是复用还是重新对照，并保留原始报告链接。原始未执行项不能改成实际成功，普通工具遗漏不能当兼容性问题。已完成报告可按用户口径另存复核结果，不覆盖历史执行。

本轮通过报告索引为 `.runtime/test-results/desktop-host/accepted-wsl-20260916.json`，原始报告、通过报告及依据分别保留。此文是后续代理排查与复核规则；执行器原始功能判据继续保留，没有新增自动放行所有错误的程序逻辑。
