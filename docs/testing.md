# 测试入口与验收边界

固定分三批：**A 免费回归；B 消耗 Token 的真实模型和桌面宿主验收；C 涉及关闭或重启 Codex 的生命周期验收**。B 再分为只测 Codex 官方模型的 B1 和只测 DeepSeek 的 B2，分别计划、分别确认、分别报告。测试当前平台，不要求其他平台同时通过；Windows 原生与 WSL 原生属于同一平台内两套独立运行环境，也不能互相继承结果。

最近一次完整 A：2026-09-13，macOS arm64，`codex-cli 0.154.0-alpha.6.2`、Chrome `153.0.8010.36`、Node `26.7.0`，**263 项通过，0 失败、0 跳过**；`A-common` 233 项、`A-macos-native-relay` 30 项，汇总测试时长约 65.4 秒。代码摘要为 `52bc4a7983fc8d59eb0e22eecf062c09b1da372ae6cf75c9eed87df06c31577a`。本次选择、当前运行环境与 macOS 全部支持环境均为 `passed`。全部 69 项索引都有通过的免费证据，其中 66 项仍按各自适用条件保留真实 B/C 验收要求；免费证据不等于真实宿主、模型或生命周期验收完成。

此前绑定 `0.1.203` 源码的 B 后台按四个独立阶段完成真实测试。官方配置各阶段起始选择 `gpt-5.6-luna`，文件/命令/补丁与 MCP、历史恢复与分叉、显式压缩与压缩后续接、动态网页/浏览器适配、识图、原生 `webSearch` 和用户输入回调均通过，共观测 337,757 Token、11 个常规轮次。历史阶段的最小 `thread/fork` RPC 未携带模型参数，分叉首轮由 app-server 选择当时的官方默认 `gpt-6-astra`；因此该项证明官方分叉和历史保留可用，不把它表述为 Luna 精确继承。DeepSeek `deepseek-v4-flash` 的同类适用场景均通过，共观测 639,731 Token、9 个常规轮次，恢复、分叉和压缩后请求均继续路由到 DeepSeek；该模型不声明图片能力，也不运行官方专属 `webSearch`。TokenHub Responses、TokenHub Chat 按本机环境限制未运行，结果保持 `NOT_RUN`，既不计为通过也不计为失败。这些 B 结果不自动继承为 `0.1.208`、Windows 原生或 WSL 原生的通过结论。

真实 OAuth 账号还通过隔离的官方 app-server 完成一次最小唤醒请求并取得预期回复。该辅助链不切换账号、不写入日常配置，也不替代主入口验收。

此前的 macOS 桌面主入口还实际完成了 `web.run` 的 search/open/find、Codex App 的项目与额度只读调用、一次不占用当前任务的独立自动化调度、真实图片生成，以及 computer use 对回环 HTTP 材料的读取、输入、单次提交、截图和下载事件；自动化与服务端产物的随机标记均由独立文件核对，图片产物也已直接查看。临时自动化在首次成功后已经暂停并删除，没有重复运行。该宿主证据确认当时相应工具可调用，但不能据此宣称当前源码或 Windows 桌面主入口全部通过。详见 `.runtime/test-results/desktop-host.md`。

首次生命周期实测把正式包 `0.1.202` 和中继协议 `52` 加载进日常 Codex；正式包验签与更新、进程接管、重复启动单实例、中继自动重连、关闭后重开均通过。切换到第二个 OAuth 账号后，唯一一次最小模型冒烟收到该账号的用量上限错误，因此整批保留为失败；监督器随后成功回切原账号、恢复安装前 `0.1.167`，并从当时源码重新启动。当前源码为 `0.1.208`、中继协议为 `54`；本轮 Windows 改动必须由 Windows 真机 lifecycle 报告分别验证正式包中的 Windows 原生与 WSL 原生链路、目标协议、自动切换恢复和第二账号冒烟。

## 日常怎么运行

| 命令 | 作用 |
| --- | --- |
| `npm test` | 免费基础契约、状态机和故障回归；可以在 CI 运行 |
| `npm run test:offline` | 当前平台完整 A：`A-common` + 本平台全部原生 Relay 组件；Windows 会分别执行 Windows 原生和 WSL 原生链路 |
| `npm run test:offline -- --runtime=current\|windows-native\|wsl-native` | 开发定位时只执行所选 Relay 组件及 `A-common`；不能作为 Windows 完整 A 结论 |
| `npm run test:live:official -- --plan` | 免费列出 B1 Codex 官方模型的协议、场景和停止阈值；不发模型请求 |
| `npm run test:live:official -- --confirm-token-use` | 当前代码、当前桌面运行环境对应的 A 组件通过并获得 B1 当次明确同意后，只执行 Codex 官方真实测试 |
| `npm run test:live:deepseek -- --plan` | 免费列出 B2 DeepSeek 的模型、协议、场景和停止阈值；不发模型请求 |
| `npm run test:live:deepseek -- --confirm-token-use` | 当前代码、当前桌面运行环境对应的 A 组件通过并获得 B2 当次明确同意后，只执行 DeepSeek 真实测试 |
| `npm run test:live -- --plan` | 只读列出当前可用真实 profile 的总览；付费执行必须显式指定单个 profile，不能用该入口一次运行全部供应商 |
| B1/B2 命令追加 `--stage=tools\|history\|compaction\|host` | 只运行一个隔离阶段；四阶段各自启动 app-server 并单独应用停止阈值 |
| B1/B2 命令追加 `--runtime=macos-native\|windows-native\|wsl-native` | 明确选择本平台一个运行环境；默认 `current`，不修改桌面设置，禁止 `all` |
| B1/B2 命令追加 `--wakeup` | 后台链路通过后，再执行一次独立的真实账号唤醒 |
| [桌面宿主步骤](testing-desktop-host.md) | 按当前所选模型归入 B1 或 B2：当前 Codex 实际调用 web.run、computer use 等宿主能力 |
| `npm run test:lifecycle -- --plan` | 只读列出 C 批的本机 Codex、注入器、正式包、中继协议、账号条件和预计一次官方冒烟；不重启、不切换、不发模型请求 |
| `npm run test:lifecycle -- --confirm-restart` | 完整 A 属于当前源码并获得 C 当次明确同意后，构建并验证正式包；Windows 自动切到 Windows 原生、再切到 WSL 原生，逐套执行重启、接管、单实例与断线恢复，最后精确恢复原设置并执行账号往返 |
| `npm run test:lifecycle -- --status` | 读取最近一次持久化报告；也可追加 `=<run-id>` 指定报告。监督器中断后用 `--resume=<run-id>` 按检查点恢复，并重新打开进度页 |

除纯文档且不改变测试规则或行为的修改外，代码、配置或测试完成后自动执行完整 A；局部免费用例只用于开发中快速定位。A 通过后必须主动展示 B1、B2、C 三份计划并询问用户分别执行哪些批次。B1、B2 或 C 失败后保留首次证据，不自动重试收费或重启场景。

## A 实际执行了什么

当前官方运行时和浏览器适配器支持 **macOS arm64/x64 与 Windows x64（含 WSL）**。使用已安装的 Codex CLI 和 Chrome/Edge；macOS 生产 shim 还需要 Xcode Command Line Tools 的 Swift 编译器。可用 `CODEX_TEST_CLI`、`CODEX_TEST_BROWSER` 指定路径。缺少工具或当前平台未适配时报告阻塞，不跳过后宣称通过。Windows 适配器已实现，但必须在 Windows 真机执行后才能形成该平台结论。

A 的固定组件是：

| 组件 | 执行环境与判据 |
| --- | --- |
| `A-common` | 共享逻辑、Router/协议，以及同一桌面宿主共用的 Widget、浏览器与页面契约，只执行一次 |
| `A-macos-native-relay` | macOS Node.js、官方 CLI、生产 shim/Relay 与临时目录 |
| `A-windows-native-relay` | Windows Node.js、Windows `node_modules`、Windows 官方 CLI、实际 PE SEA Relay、Windows 路径/进程/临时目录 |
| `A-wsl-native-relay` | WSL Linux Node.js、独立 `npm ci` 依赖和缓存、WSL 官方 CLI、实际 ELF SEA Relay、Linux 环境变量/路径与启动身份 |

macOS 的完整 A 是 `A-common + A-macos-native-relay`；Windows 的完整 A 是 `A-common + A-windows-native-relay + A-wsl-native-relay`。报告分别写 `currentRuntimeStatus` 与 `allSupportedStatus`：当前桌面设置为 WSL 时，Windows 原生结果仍不能从 WSL 继承；反过来也一样。A 读取设置来标记当前环境，不修改桌面运行方式。

A 中官方 CLI 使用临时 HOME、CODEX_HOME、XDG/APPDATA 目录和测试凭据，模型端点是会记录并断言每次请求的本地脚本服务。macOS 继续用 Seatbelt 将实际官方运行时、工具和浏览器子进程限制到本机端口及本地 Unix 通信；Windows 原生链在 Windows 临时环境中运行，WSL 链把当前源码复制到 Linux 临时工作区并使用独立依赖、缓存与临时 HOME。请求未到本地服务，或者出现真实上游的网络/认证结果时，用例直接失败。Chrome/Edge 使用临时用户目录；macOS 启动参数固定包含 `--use-mock-keychain`，不读取或弹窗请求日常 Chrome 钥匙串。官方解析、命令、补丁、PTY、MCP、Hooks、文件、Git 和浏览器执行都是真实的；模型响应由固定材料提供，不产生模型 Token。

基础契约沿用 `npm test` 的临时材料和假凭据，不启动真实模型。macOS 的基础契约需要调用 `/bin/ps` 核对进程身份，该系统程序不能在 Seatbelt 内执行，因此运行器先执行基础契约，再在 Seatbelt 中执行官方/浏览器组合。macOS 不允许嵌套 Chrome 渲染器沙箱，临时浏览器使用 `--no-sandbox`，外围 Seatbelt 仍然保留；Windows 浏览器同样使用一次性用户目录。两边都不改变用户浏览器设置。B 的真实工具改用官方 `workspace-write` 文件沙箱，执行结果需由 B 实测。

| 证据文件 | 核对内容 |
| --- | --- |
| [官方工作流](../runtime-tests/official-workflows.test.mjs) | 官方直接路径、Swift shim、官方经 Router、第三方 Responses/Chat、生产生成目录；文件读写/补丁/并行失败命令、2 MiB 内容、PTY、历史/分叉/归档恢复、输入队列恰好执行一次 |
| [交互](../runtime-tests/official-interactions.test.mjs) | MCP 发现/资源/只读调用/错误；写入型 MCP 在 `never` 下拒绝且无副作用，MCP elicitation 直接终结；Plan 用户输入、动态工具回调、中断与再继续、Skills 和项目 |
| [上下文](../runtime-tests/official-context.test.mjs) | 官方手动压缩、压缩后状态与用量；有效图片/附件/产物；steer、设置、历史注入；真实加载和信任后的 Hooks 执行 |
| [第三方历史兼容](../runtime-tests/deepseek-history.test.mjs) | 实际官方 app-server 经内置 DeepSeek 路由恢复并分叉任务，模拟真实 `reasoning_text` 流并保留消息和工具调用/结果关联；恢复、分叉、压缩及压缩后续接请求剥离 Codex 私有消息元数据和 DeepSeek 不支持的推理字段 |
| [DeepSeek 工具链](../runtime-tests/deepseek-tools.test.mjs) | 实际官方 app-server 经当前平台生产中继入口连接本地 Responses/MCP；首个请求直接暴露 MCP 命名空间，不依赖 `tool_search`，在 `never` 下执行只读 MCP 并验证独立事件与工具结果续接 |
| [任务状态](../runtime-tests/official-task-state.test.mjs) | 目标实际执行文件任务并完成、官方自动压缩、时间线分页、分组/删除、会话式文件搜索 |
| [扩展](../runtime-tests/official-extensions.test.mjs) | 默认和实验协议 Schema 摘要核对；当前平台设备验证状态的实际只读判定；本地插件实际安装/停用/卸载；Git 真实差异审查 |
| [Widget 浏览器](../runtime-tests/widget-browser.test.mjs) | 真实 DOM 注入/替换/销毁、点击/输入、全部面板动作、表单到配置管理器、不同尺寸/主题/任务节点变化、原生输入及工具按钮仍可操作 |
| [工具宿主组合](../runtime-tests/browser-host.test.mjs)、[桌面材料](../runtime-tests/desktop-fixture.test.mjs) | 同一桌面宿主的浏览器契约由公共组件运行一次；原生组件另行覆盖各自官方 CLI/app-server 的动态工具往返。这里执行本地网页/浏览器、data URL 导航、输入、点击、下载及模型续接；CDP 断开后仍回收测试浏览器；不冒充桌面 web.run/CUA |
| [协议回归](../test/relay-protocol.test.mjs)、[Chat 工具契约](../test/chat-tool-contracts.test.mjs)、[新增格式](../test/chat-protocol-tools.test.mjs)、[路由恢复](../test/model-router-recovery.test.mjs) | 双向请求/ID/分页/大消息，Responses Lite/custom/namespace，历史关联、指定工具、预热/断流/错误/取消、不同供应商隔离与观察故障 |
| [账号可靠性](../test/account-reliability.test.mjs)、[OAuth](../test/account-oauth.test.mjs)、[唤醒进程](../test/wakeup-client.test.mjs) | 并发/写入和 rename 失败/损坏数据保护；测试 OAuth 的 PKCE/state、端口冲突/超时/取消、导入导出；真实子进程的最低价选择、刷新、异常和清理 |
| [基础测试目录](../test)、[测试边界](../test/testing-boundaries.test.mjs) | 原有账号、模型配置、计价、计量、CDP、单实例等契约继续执行；未授权 B 不读取账号或启动模型，场景索引不能漏项 |

关闭的是本轮自己创建的测试 CLI、终端和浏览器。没有启动第二个桌面 Codex 去操作日常 Codex，也没有调用生产的全局停止、重启、账号切换或接管入口。

当前桌面宿主的 in-app Browser Use 已成功打开只绑定 `127.0.0.1` 的 HTTP 材料，完成读取、输入、点击、结果读取、截图和下载事件。隔离 Chrome 的自包含页面继续验证底层 DOM 与文件契约；两类证据分别记录，不能相互冒充。`file://` 在页面加载前被 URL 策略拒绝属于正常安全边界，不再作为注入或 computer use 失效证据。

## B1/B2 的真实判据与成本

后台 B 使用当前凭据登录临时、仅内存保存认证的官方 app-server，再经过所选运行环境的生产 Relay、目录生成器、Router/Chat 代理。当前账号的 auth.json、Keychain、日常配置及任务不被写入。B 默认读取当前桌面运行环境，也可显式选择本平台一个运行环境；它不切换桌面设置。认证过期而需要未实现的桌面刷新交互时失败，不改写日常账号来绕过。

B1 只选择 Codex 官方模型，B2 只选择已配置的 DeepSeek 模型；两批都核对真实文件修改、只读 MCP 结果、历史恢复/分叉、压缩后口令、动态工具结果和用户输入回调。声明支持图片的模型额外识图，官方模型额外执行原生网页搜索。网页搜索必须产生官方 `webSearch` 事件，并返回路径属于 app-server 的 OpenAI 文档站或 `openai/codex` 官方仓库链接，不能只按单一站点域名判断。MCP 使用 `never` 策略下可执行的只读工具，先直调预检，再由模型调用，并核对两次独立事件。审批允许/拒绝弹窗不属于测试项。

每个隔离阶段的默认停止阈值为观察到 500,000 Token 或启动 40 个常规轮次；可用 `CODEX_TEST_LIVE_MAX_TOKENS`、`CODEX_TEST_LIVE_MAX_TURNS` 调低。它们是停止条件，**不是预估费用或严格账单上限**，在途请求、压缩与工具费用可能超出；实际唤醒单独增加一次最小请求。每次运行前都必须展示对应计划并取得当次明确同意；B1 的同意不覆盖 B2，B1/B2 的同意也不覆盖 C。

后台进程没有桌面特有的 web.run、computer use、Apps、语音、自动化和远程宿主。B 后台成功状态为 `desktop-host-not-verified`，再按[桌面宿主步骤](testing-desktop-host.md)留下实际调用和独立结果。缺少能力、配置或权限必须写原因；不能把未执行改成通过。

## 报告和以后怎么防止漏测

- `.runtime/test-results/offline.json`：本次平台、Node、实际 CLI/浏览器/Relay 摘要、源码摘要、`A-common` 与各原生 Relay 组件结果、`selectedStatus`、`currentRuntimeStatus`、`allSupportedStatus`、用例结果，以及全部 69 个场景的证据状态。默认完整运行以 `allSupportedStatus` 为总状态；定向运行只允许 `selectedStatus` 通过。
- `offline-events.jsonl` 与 `browser-*.png`：逐项事件和浏览器截图；错误保留首次异常。截图来自临时页面。
- `live-<配置 ID>-<运行环境>[-<阶段>].json` 与 `live-<阶段>-<配置 ID>-<运行环境>-events.jsonl`：绑定一个真实 profile 和一个运行环境的计划及后台结果；失败时保留阶段、用量、工具状态、脱敏错误和 MCP 参数形状，不复制提示词或工具正文。TokenHub 两条没有运行报告。
- `lifecycle/<run-id>/report.json`：正式包哈希、每次 Codex/注入器/中继 PID、协议版本、`C-package-common`/`C-windows-native`/`C-wsl-native`/自动切换恢复结果和脱敏账号指纹。相邻的 `progress.html` 从该报告生成，测试开始前在浏览器打开，显示当前步骤、失败和回滚状态；它不触发操作，也不参与通过判定。`control.json` 只为中断恢复保存两个账号 ID 和权限限制为当前用户的配置备份路径，不保存 Token；公开报告不写账号 ID、邮箱、配置正文或 Router 私密地址。配置副本留在对应私有 run 目录，供中断核对和人工恢复。
- [场景索引](testing-scenarios.json)逐一对应[69 项矩阵](codex-compatibility-test-plan.md)。`free-evidence-passed` 只表示列出的免费证据通过，仍保留 `liveStatus: not-run` 和每项限制；不能把它当完整验收。
- [协议清单](testing-protocol-inventory.json)覆盖当前 CLI 的默认及实验协议。字段、方法或类型变化会使 A 失败，要求重新审核清单和补测试，不能默默复用上次绿灯。
- B 启动前核对本次平台、源码/测试文件摘要及实际 CLI/浏览器摘要。旧代码、运行时升级或测试期间文件改变的报告无效。
- A/B/C 不依赖当前对话在失败后继续作答。后台模型测试由 Node 控制程序落盘；生命周期测试由 macOS launchd 或 Windows 任务计划程序托管的一次性 Node 监督器落盘，并由独立浏览器页面展示同一份脱敏报告。Windows 计划任务带登录触发和失败重启策略；页面无法打开时不调度重启。步骤开始前写检查点，已核实完成的副作用不重复，模型请求结果未知时拒绝自动重放并先恢复原账号；存在未完成或回滚失败的 C 时，新任务只展示恢复命令，不覆盖现场。

## 补测发现并修复的问题

本轮回归复现并修复了 Responses Lite/命名空间/原始文本工具无法正确转换、WS 本地预热丢失增量历史、账号写入失败留下虚假内存状态、取消 OAuth 后仍可能保存授权、唤醒进程继承日常 HOME、Widget 主题切换不同步、隔离 Chrome 误探测日常 macOS 钥匙串、真实测试错误拒绝写入型 MCP 工具、原生网页搜索错误排除 OpenAI 官方仓库来源、Codex 私有历史元数据被转发给第三方 Responses API，以及 Codex 重放的推理历史含有 DeepSeek 不支持字段等问题。DeepSeek 目录原先同时声明搜索工具和未指定工具模式，导致 app-server 延迟 MCP 工具并让模型反复发出无意义命令；当前目录关闭该模型不具备的搜索工具能力，使 MCP 从第一轮以直接命名空间暴露。真实 B 原先把所有场景堆在一个长任务中，压缩后的累计上下文会先撞到 Token 阈值；当前按工具、历史、压缩、宿主四个独立任务运行。

MCP 回归固定 `never` 下写入拒绝无副作用和只读工具实际执行两条路径，宿主 URL 使用明确的回环 HTTP 契约；网页来源回归同时固定官方正例和仿冒/无关反例；第三方历史回归实际经过官方 app-server 和内置 DeepSeek 路由，覆盖真实推理项、工具历史、恢复、分叉和压缩。修复针对共享数据流和测试边界，并有实际失效断言。

发布版本为 `0.1.208`，Widget 运行时 `123`，中继协议 `54`；持久化结构未改变，因此账号存储版本仍为 `2`。源码版本和日常 Codex 实际加载版本分别记录，只有 lifecycle 报告中的正式包哈希及中继 generation 能证明本次加载。
