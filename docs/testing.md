# 测试入口与验收边界

固定分三批：**A 免费回归；B 消耗 Token 的真实模型和桌面宿主验收；C 涉及关闭或重启 Codex 的生命周期验收**。B 再分为只测 Codex 官方模型的 B1 和只测 DeepSeek 的 B2，分别计划、分别确认、分别报告。测试当前平台，不要求其他平台同时通过；Windows 原生与 WSL 原生属于同一平台内两套独立运行环境，也不能互相继承结果。

最近一次完整 A：2026-09-13，macOS arm64，`codex-cli 0.154.0-alpha.6.2`、Chrome `153.0.8010.36`、Node `26.7.0`，**301 项通过，0 失败、0 跳过**；`A-common` 271 项、`A-macos-native-relay` 30 项，汇总测试时长约 77.7 秒。代码摘要为 `9cae108f67b627f9b15c3a891622e1c6737f7365bac5d2cc8158d1a5242c010a`，属于当前 `0.1.216` 源码；本次选择、当前运行环境与 macOS 全部支持环境均为 `passed`。全部 69 项索引仍按各自适用条件保留真实 B/C 验收要求；免费证据不等于真实桌面任务、模型或生命周期验收完成。

Windows x64 的最近一次完整 A 于 2026-09-13 针对 `0.1.219` 运行：`A-common` 322 项、`A-windows-native-relay` 33 项、`A-wsl-native-relay` 33 项，共 **388 项通过，0 失败、0 跳过**；代码摘要为 `adce0c69780ab1941817fd109a97a12e36eaf56e083f7cf98321c64110c6b49e`。当前 WSL 原生运行环境与 Windows 全部支持环境均为 `passed`，桌面主入口仍按 B/C 独立裁决。

此前绑定 `0.1.203` 源码的 B 后台按四个独立阶段完成真实测试。官方配置各阶段起始选择 `gpt-5.6-luna`，文件/命令/补丁与 MCP、历史恢复与分叉、显式压缩与压缩后续接、动态网页/浏览器适配、识图、原生 `webSearch` 和用户输入回调均通过，共观测 337,757 Token、11 个常规轮次。历史阶段的最小 `thread/fork` RPC 未携带模型参数，分叉首轮由 app-server 选择当时的官方默认 `gpt-6-astra`；因此该项证明官方分叉和历史保留可用，不把它表述为 Luna 精确继承。DeepSeek `deepseek-v4-flash` 的同类适用场景均通过，共观测 639,731 Token、9 个常规轮次，恢复、分叉和压缩后请求均继续路由到 DeepSeek；该模型不声明图片能力，也不运行官方专属 `webSearch`。TokenHub Responses、TokenHub Chat 按本机环境限制未运行，结果保持 `NOT_RUN`，既不计为通过也不计为失败。这些 B 结果不自动继承为 `0.1.219`、Windows 原生或 WSL 原生的通过结论。

真实 OAuth 账号还通过隔离的官方 app-server 完成一次最小唤醒请求并取得预期回复。该辅助链不切换账号、不写入日常配置，也不替代主入口验收。

此前的 macOS 桌面主入口还实际完成了 `web.run` 的 search/open/find、Codex App 的项目与额度只读调用、一次不占用当前任务的独立自动化调度、真实图片生成，以及 computer use 对回环 HTTP 材料的读取、输入、单次提交、截图和下载事件；自动化与服务端产物的随机标记均由独立文件核对，图片产物也已直接查看。临时自动化在首次成功后已经暂停并删除，没有重复运行。该宿主证据确认当时相应工具可调用，但不能据此宣称当前源码或 Windows 桌面主入口全部通过。详见 `.runtime/test-results/desktop-host.md`。

2026-09-13 的 Windows 非浏览器 Computer Use 复测使用每轮动态编译的原生 WinForms 材料。无 Relay 官方基线和 Windows 原生 Relay 都实际完成应用启动、唯一窗口选择、辅助功能读取随机标记、输入及标准 Enter 单次提交；两份独立清单都证明 `launchCount = 1`、正确提交恰好一次。对同一材料调用截图和按元素点击时，两条链路都分别返回 `SetIsBorderRequired ... 0x80004002` 与 `coordinate input geometry is unavailable`，因此基础交互通过，截图和坐标点击子能力记 `BLOCKED_UPSTREAM`，不能归因于注入器。浏览器子链也已用同一个隔离 Chrome 窗口、同一回环页面和同一 `@oai/sky` 分别执行官方无 Relay 与 Relay 对照，两边逐字返回相同的 Windows URL 可信度安全终止；该结果保留为 `BLOCKED_UPSTREAM` 历史证据，不作为 Windows TOOL-06 的验收范围。完整证据和裁决见 `.runtime/test-results/desktop-host.md`。

2026-09-13 使用 `codex-cli 0.153.4` 对 Windows Hooks 建立了同版本原生 direct 对照。`UserPromptSubmit` 在官方事件中从 `hook/started` 进入 `hook/completed`，但完成事件的 `entries` 为空，钩子 stdout 未进入随后发送给模型的输入；Windows Relay 对照同样缺少该上下文。因此 Windows 的 EXT-01 Hook 上下文注入当前记为 `BLOCKED_UPSTREAM`，不修改 Relay 或测试材料绕过；WSL 原生结果独立裁决，不能继承此结论。

2026-09-13 的 `20260913115517-a602e775` 报告把 `0.1.211` 的 Windows 原生、WSL 原生、运行方式恢复、账号往返和官方冒烟都记录为通过，但该版本没有验收发起任务的历史存活。事后审计确认更早的 C 在活动回合尚未终止时关闭 Codex，rollout 留下重复 ordinal 和三个缺失的中断终态；Windows 与 WSL 的官方分页投影都停在 ordinal `9410`，所以后续重启持续显示旧索引。原始消息仍完整保存在 rollout，同版本官方无 Relay app-server 在隔离副本上经结构修复和目标任务投影重建后可检索缺失消息。该报告的 C 通过结论因此作废，审计见 `.runtime/test-results/lifecycle/20260913115517-a602e775/history-audit.json`；只有加入历史门禁后的新 C 真机报告才能重新给出通过结论。

Windows C 报告 `20260913145459-aaa2312f` 曾在 `0.1.212`、中继协议 `55` 上把 18 个步骤记录为通过。事后审计发现它在 `launch-windows-native` 已启动桌面后，仍通过正式 Relay 发送 `thread/resume` 启动第二个 app-server 重建历史；这违反桌面历史写入的单实例边界，也使该报告不能证明重启后的会话读取可靠，因此原通过结论作废。当前实现把需要的重建移到桌面启动前，重建进程退出后才启动桌面；启动后的门禁只读检查投影和消息内容。当前合并源码为 `0.1.219`、中继协议 `58`，若要重新给出 C 通过结论，必须取得本次重启同意后执行当前版本 C。

2026-09-14 对 B1 WSL 桌面报告的 `read_thread` 空 `items` 重新逐层对照。rollout 和 WSL SQLite 中两个完成回合内容完整；本轮实际运行的官方 `codex-cli 0.154.0-alpha.6.2` 在隔离目录中无 Relay 直连返回 79/140 个 item，同一数据经正式 WSL Relay 仍返回 79/140，但官方 Codex Desktop 的 `read_thread` 封装对同两个回合返回 0/0，较小的旧回合可正常返回。因此该项定位为官方桌面 `read_thread` 封装层的上游阻断，不归因于 Relay，也不通过修改项目数据绕过。报告中的 `0.153.4` 来自长期任务创建时的 `session_meta`；官方桌面日志证明该报告运行前已启动 `0.154.0-alpha.6.2`，故对照必须以实际进程版本为准。当前机器可读证据为 `.runtime/probes/official-read-thread-wrapper-20260914.json`。

2026-09-14 新建的 Windows 原生 B1 桌面任务实际完成 `functions.exec` 成功与退出码 23 失败续接、`codex_app` 四个只读入口、`web.run` 以及 WinForms Computer Use 的唯一窗口选择、标记输入和单次提交。截图返回 `SetIsBorderRequired ... 0x80004002`；同一官方 CLI、同一 `@oai/sky`、正确 Windows cwd 且完全移除 Relay 的独立对照返回相同错误，机器可读证据为 `.runtime/official-computer-use-screenshot-control-windows.json`，因此截图仍为 `BLOCKED_UPSTREAM`。该轮正式报告没有通过：新任务启动了第二个 app-server Relay，第二实例覆盖共享状态后在退出时删除状态，使仍存活的主 Relay 被误报为断开。中继协议 59 改为由一个存活实例持有状态，其他实例退出不再清理主实例，并在所有者退出后自动接管；修复已通过并发实例定向测试和 Windows SEA 构建，但尚未经用户同意重启桌面加载，B1 正式桌面报告仍需重跑。

## 日常怎么运行

| 命令 | 作用 |
| --- | --- |
| `npm test` | 免费基础契约、状态机和故障回归；可以在 CI 运行 |
| `npm run test:offline` | 当前平台完整 A：`A-common` + 本平台全部原生 Relay 组件；Windows 会分别执行 Windows 原生和 WSL 原生链路 |
| `npm run test:offline -- --runtime=current\|windows-native\|wsl-native` | 开发定位时只执行所选 Relay 组件及 `A-common`；不能作为 Windows 完整 A 结论 |
| `npm run test:live:official -- --plan` | 免费列出 B1 Codex 官方模型后台组件、桌面组件、场景和停止阈值；不发模型请求 |
| `npm run test:live:official -- --confirm-token-use` | 当前代码和运行环境的 A 组件通过并获得 B1 当次同意后，执行 `B1-official-backend` |
| `npm run test:live:deepseek -- --plan` | 免费列出 B2 DeepSeek 后台组件、桌面组件、场景和停止阈值；不发模型请求 |
| `npm run test:live:deepseek -- --confirm-token-use` | 当前代码和运行环境的 A 组件通过并获得 B2 当次同意后，执行 `B2-deepseek-backend` |
| `npm run test:live -- --plan` | 只读列出当前可用真实 profile 的总览；付费执行必须显式指定单个 profile，不能用该入口一次运行全部供应商 |
| B1/B2 后台命令追加 `--stage=tools\|history\|compaction\|callbacks` | 只运行一个隔离阶段；四阶段各自启动 app-server 并单独应用停止阈值；旧参数 `host` 仅作为 `callbacks` 的兼容别名 |
| B1/B2 命令追加 `--runtime=macos-native\|windows-native\|wsl-native` | 明确选择本平台一个运行环境；默认 `current`，不修改桌面设置，禁止 `all` |
| B1/B2 命令追加 `--wakeup` | 后台链路通过后，再执行一次独立的真实账号唤醒 |
| `npm run test:desktop -- --profile=official\|deepseek --plan` | 免费列出对应 B1/B2 桌面组件、证据绑定和实际操作；不发模型请求 |
| `npm run test:desktop -- --profile=official\|deepseek --confirm-token-use` | 后台组件通过后打开实时报告，并由目标模型的真实 Codex 桌面任务调用 functions.exec、web.run、computer use 和用户输入；跨任务委托驱动时追加 `--trigger-mode=delegated` |
| `npm run test:desktop -- --status=<run-id>` | 读取并刷新一次已有桌面报告 |
| `npm run test:lifecycle -- --plan` | 只读列出 C 批的本机 Codex、注入器、正式包、中继协议、账号条件和预计一次官方冒烟；不重启、不切换、不发模型请求 |
| `npm run test:lifecycle -- --confirm-restart` | 完整 A 属于当前源码并获得 C 当次明确同意后，构建并验证正式包；Windows 记录发起任务和回合，在首次关闭前检查 rollout 连续性、回合终态及分页投影，备份后自动修复可证明不改变对话内容的已知损坏并定向重建 Windows/WSL 目标任务投影；每套运行环境只在桌面停止期间由对应正式 Relay 显式恢复落后的目标任务，重建退出后才启动桌面，启动后仅以只读门禁验证投影和消息内容；随后逐套验证 Windows 原生、WSL 原生的重启、接管、桌面主进程单实例和断线恢复；最后恢复测试前的运行方式、保留 Codex 同期写入的其他设置并执行账号往返 |
| `npm run test:lifecycle -- --status` | 读取最近一次持久化报告；也可追加 `=<run-id>` 指定报告。监督器中断后用 `--resume=<run-id>` 按检查点恢复；回滚失败后用 `--recover=<run-id>` 只重试失败的回滚。两者都会重新打开进度页 |
| `npm run test:lifecycle -- --recover=<run-id>` | 由外部监督器只重试该次 C 报告里失败的回滚；恢复成功后原 C 仍保留为失败，不会改写成通过 |

代码、配置、测试或规则改动后不自动执行或重跑 A；只有用户明确要求执行 A 时才运行用户指定的范围。局部免费用例只用于开发中快速定位。A 通过后必须主动展示 B1、B2、C 三份计划并询问用户分别执行哪些批次。B1、B2 或 C 失败后保留首次证据，不自动重试收费或重启场景。

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
| [DeepSeek Flash 历史兼容](../runtime-tests/deepseek-history.test.mjs) | 实际官方 app-server 经模型管理的 DeepSeek Flash 预设路由恢复并分叉任务，按当前实测的 `responses-full` 能力保留 `reasoning_text`、`summary` 与 `encrypted_content`，同时保留消息和工具调用/结果关联，并验证恢复、分叉、压缩及压缩后续接 |
| [DeepSeek 工具链](../runtime-tests/deepseek-tools.test.mjs) | 实际官方 app-server 经当前平台生产中继入口连接本地 Responses/MCP；首个请求直接暴露 MCP 命名空间，不依赖 `tool_search`，在 `never` 下执行只读 MCP 并验证独立事件与工具结果续接 |
| [任务状态](../runtime-tests/official-task-state.test.mjs) | 目标实际执行文件任务并完成、官方自动压缩、时间线分页、分组/删除、会话式文件搜索 |
| [扩展](../runtime-tests/official-extensions.test.mjs) | 默认和实验协议 Schema 摘要核对；当前平台设备验证状态的实际只读判定；本地插件实际安装/停用/卸载；Git 真实差异审查 |
| [Widget 浏览器](../runtime-tests/widget-browser.test.mjs) | 真实 DOM 注入/替换/销毁、点击/输入、全部面板动作、表单到配置管理器、不同尺寸/主题/任务节点变化、原生输入及工具按钮仍可操作 |
| [工具宿主组合](../runtime-tests/browser-host.test.mjs)、[桌面材料](../runtime-tests/desktop-fixture.test.mjs)、[Windows 原生 Computer Use 材料](../runtime-tests/windows-computer-use-fixture.test.mjs) | 同一桌面宿主的浏览器契约由公共组件运行一次；原生组件另行覆盖各自官方 CLI/app-server 的动态工具往返。Windows 还动态编译非浏览器 WinForms 材料并验证随机标记、单次提交和独立证据；CDP 断开后仍回收测试浏览器；免费材料不冒充真实桌面 web.run/CUA |
| [协议回归](../test/relay-protocol.test.mjs)、[Responses 工具适配](../test/responses-tool-adapter.test.mjs)、[Chat 工具契约](../test/chat-tool-contracts.test.mjs)、[新增格式](../test/chat-protocol-tools.test.mjs)、[路由恢复](../test/model-router-recovery.test.mjs) | 双向请求/ID/分页/大消息，Responses Lite/custom/namespace 的选择性转换与 SSE 还原，历史关联、指定工具、预热/断流/错误/取消、不同供应商隔离与观察故障 |
| [账号可靠性](../test/account-reliability.test.mjs)、[OAuth](../test/account-oauth.test.mjs)、[账号迁移](../test/account-transfer.test.mjs)、[唤醒进程](../test/wakeup-client.test.mjs) | 并发/写入和 rename 失败/损坏数据保护；测试 OAuth 的 PKCE/state、端口冲突/超时/取消，以及迁移前刷新、源端状态、目标接管和恢复；真实子进程的最低价选择、刷新、异常和清理 |
| [基础测试目录](../test)、[测试边界](../test/testing-boundaries.test.mjs) | 原有账号、模型配置、计价、计量、CDP、单实例等契约继续执行；未授权 B 不读取账号或启动模型，场景索引不能漏项 |

关闭的是本轮自己创建的测试 CLI、终端和浏览器。没有启动第二个桌面 Codex 去操作日常 Codex，也没有调用生产的全局停止、重启、账号切换或接管入口。

当前桌面宿主的 in-app Browser Use 已成功打开只绑定 `127.0.0.1` 的 HTTP 材料，完成读取、输入、点击、结果读取、截图和下载事件。隔离 Chrome 的自包含页面继续验证底层 DOM 与文件契约；两类证据分别记录，不能相互冒充。`file://` 在页面加载前被 URL 策略拒绝属于正常安全边界，不再作为注入或 computer use 失效证据。

## B1/B2 的真实判据与成本

后台 B 使用当前凭据登录临时、仅内存保存认证的官方 app-server，再经过所选运行环境的生产 Relay、目录生成器、Router/Chat 代理。当前账号的 auth.json、Keychain、日常配置及任务不被写入。B 默认读取当前桌面运行环境，也可显式选择本平台一个运行环境；它不切换桌面设置。认证过期而需要未实现的桌面刷新交互时失败，不改写日常账号来绕过。

B1 只选择 Codex 官方模型；B2 只从模型管理中读取已启用、完成当前版本兼容检测的 DeepSeek 预设 `deepseek-flash`。B2 的隔离运行时不得携带 DeepSeek Pro、其他自定义平台或 TokenHub；这些供应商和模型只有用户另行点名时才单独计划。两批都核对真实文件修改、只读 MCP 结果、历史恢复/分叉、压缩后口令、动态工具结果和用户输入回调。声明支持图片的模型额外识图，官方模型额外执行原生网页搜索。网页搜索必须产生官方 `webSearch` 事件，并返回路径属于 app-server 的 OpenAI 文档站或 `openai/codex` 官方仓库链接，不能只按单一站点域名判断。MCP 使用 `never` 策略下可执行的只读工具，先直调预检，再由模型调用，并核对两次独立事件。审批允许/拒绝弹窗不属于测试项。

每个隔离阶段的默认停止阈值为观察到 500,000 Token 或启动 40 个常规轮次；可用 `CODEX_TEST_LIVE_MAX_TOKENS`、`CODEX_TEST_LIVE_MAX_TURNS` 调低。它们是停止条件，**不是预估费用或严格账单上限**，在途请求、压缩与工具费用可能超出；实际唤醒单独增加一次最小请求。每次运行前都必须展示对应计划并取得当次明确同意；B1 的同意不覆盖 B2，B1/B2 的同意也不覆盖 C。

后台进程没有桌面特有的 web.run、computer use、Apps、语音、自动化和远程宿主。每个 B 批固定拆为 `B*-backend/<runtime>` 和 `B*-desktop/<runtime>`：后台组件通过而桌面组件未运行时，整批保持 `incomplete`；只有两者绑定同一源码、平台、运行环境和供应商且都通过时才是 `passed`。桌面组件由[桌面入口执行器](testing-desktop-host.md)核对实际模型与工具调用 ID、模型请求层的脱敏工具清单、当前中继/Widget，以及独立平台材料记录；Windows 使用原生 WinForms 清单，macOS 使用本机 HTTP 材料。B1 必须实际完成 web 搜索；B2 缺少独立 `web.run` 时记录 `unsupported`，不能把 DeepSeek 会忽略的 Hosted `web_search` 请求描述当作已支持。条件能力缺少配置或权限时必须写明原因，不能把未执行改成通过。

## 报告和以后怎么防止漏测

- `.runtime/test-results/offline.json`：本次平台、Node、实际 CLI/浏览器/Relay 摘要、源码摘要、`A-common` 与各原生 Relay 组件结果、`selectedStatus`、`currentRuntimeStatus`、`allSupportedStatus`、用例结果，以及全部 69 个场景的证据状态。默认完整运行以 `allSupportedStatus` 为总状态；定向运行只允许 `selectedStatus` 通过。
- `offline-events.jsonl` 与 `browser-*.png`：逐项事件和浏览器截图；错误保留首次异常。截图来自临时页面。
- `live-<配置 ID>-<运行环境>[-<阶段>].json` 与 `live-<阶段>-<配置 ID>-<运行环境>-events.jsonl`：绑定一个真实 profile 和一个运行环境的后台计划及结果，分别保存 `backendStatus`、`desktopHostStatus` 和 `overallStatus`；失败时保留阶段、用量、工具状态、脱敏错误和 MCP 参数形状，不复制提示词或工具正文。TokenHub 两条没有运行报告。
- `desktop-host/<run-id>/report.json` 与相邻 `progress.html`：绑定真实桌面任务使用的模型、任务/轮次/工具调用 ID、源码摘要、平台、运行环境、项目/中继/Widget 版本，以及材料服务独立记录的提交和下载。实时页面只展示报告，不参与判定；完成后把桌面组件和 B 总状态同步回对应后台报告。
- `lifecycle/<run-id>/report.json`：正式包哈希、每次 Codex/注入器/中继 PID、协议版本、`C-package-common`/`C-windows-native`/`C-wsl-native`/自动切换恢复结果和脱敏账号指纹。相邻的 `progress.html` 从该报告生成，测试开始前在浏览器打开，显示当前步骤、失败和回滚状态；它不触发操作，也不参与通过判定。`control.json` 只为中断恢复保存两个账号 ID 和权限限制为当前用户的配置备份路径，不保存 Token；公开报告不写账号 ID、邮箱、配置正文或 Router 私密地址。配置副本留在对应私有 run 目录，供中断核对和人工恢复。
- [场景索引](testing-scenarios.json)逐一对应[69 项矩阵](codex-compatibility-test-plan.md)。`free-evidence-passed` 只表示列出的免费证据通过，仍保留 `liveStatus: not-run` 和每项限制；不能把它当完整验收。
- [协议清单](testing-protocol-inventory.json)覆盖当前 CLI 的默认及实验协议。字段、方法或类型变化会使 A 失败，要求重新审核清单和补测试，不能默默复用上次绿灯。
- B 启动前核对本次平台、源码/测试文件摘要及实际 CLI/浏览器摘要。旧代码、运行时升级或测试期间文件改变的报告无效。
- A/B/C 不依赖当前对话在失败后继续作答。后台模型测试由 Node 控制程序落盘；生命周期测试由 macOS launchd 或 Windows 任务计划程序托管的一次性 Node 监督器落盘，并由独立浏览器页面展示同一份脱敏报告。Windows 计划任务带登录触发和失败重启策略；页面无法打开时不调度重启。C 到达通过、失败或回滚失败终态后，监督器会重试将 Codex 窗口置前，并把窗口激活结果和发起任务 ID 写入报告；窗口激活不会启动新的模型回合，失败也不会改写测试结论。任何可能中断 Windows 桌面的步骤都先读取官方 rollout 事件，等待活动回合出现 `task_complete` 或 `turn_aborted` 并稳定落盘，超时则拒绝关闭；固定启动延时不承担会话保护。关闭 Codex 后还要等关闭前的注入器释放单实例监听，才能启动正式入口，避免重开请求被即将退出的旧进程吞掉。安装回滚在恢复入口重新就绪后才写回安装版本，并重新核对主程序、对应版本的两套 Relay 和注册表，文件与安装元数据不一致时不能标为回滚通过。Windows 还会检查发起回合所在 rollout 的 ordinal 连续性和分页投影进度：已知的重复 ordinal 或缺失中断终态在停止相关进程、备份原文件和两套 SQLite 后自动修复，只重建目标任务投影；内容摘要不一致或结构未知时保持阻塞。每套运行环境只在桌面停止期间通过对应正式 Relay 发送不启动回合的 `thread/resume` 来恢复落后的目标任务，并使用独立状态文件；重建进程退出后才启动桌面。启动后的门禁只读等待 SQLite 追平，同时要求发起回合已成为 `completed` 或 `interrupted`、首条用户消息存在，且完成回合的最终助手消息存在；不会再并发启动第二个 app-server。步骤开始前写检查点，已核实完成的副作用不重复，模型请求结果未知时拒绝自动重放并先恢复原账号；存在未完成或回滚失败的 C 时，新任务只展示恢复命令，不覆盖现场。

## 补测发现并修复的问题

macOS C 同样绑定发起任务和活动回合，外部监督器不再依赖固定 10 秒延时。安装、接管、关闭、重连、账号往返及失败回滚前先等待活动回合稳定结束，再核对 rollout 与本机 SQLite 分页投影；每次启动就绪后重新核验，投影落后时不继续下一次重启。实时报告中的“等待 Codex 活动回合完成并落盘”步骤显示这段等待。缺少会话绑定的旧控制记录不能恢复，仍在运行的监督器不能被重复启动中断。

macOS 的历史门禁目前只读：检测到序号异常或旧回合缺少终态，在构建和安装之前阻断，不在线改写聊天记录，也不并发启动另一套 app-server 重建投影。分页分叉的 session_meta 若通过 history_base 与 forked_from_id / forked_from_ordinal_exclusive 一致声明继承边界，序号从该边界接续，检查器和离线修复器都保留该序号空间；不能要求所有文件从零开始，也不能无条件接受任意非零起点。此处不宣称已实现 Windows 的离线自动修复流程。C 脚本修改在下次命令执行时生效，无需重载日常 Widget；定向保护测试通过不代表真实 C 已通过，也不能继承修改前的 A/B 源码结论。

本轮回归复现并修复了 Responses Lite/命名空间/原始文本工具无法正确转换、WS 本地预热丢失增量历史、账号写入失败留下虚假内存状态、取消 OAuth 后仍可能保存授权、唤醒进程继承日常 HOME、Widget 主题切换不同步、隔离 Chrome 误探测日常 macOS 钥匙串、真实测试错误拒绝写入型 MCP 工具、原生网页搜索错误排除 OpenAI 官方仓库来源、Codex 私有历史元数据被转发给第三方 Responses API，以及 Codex 重放的推理历史含有 DeepSeek 不支持字段等问题。Codex 从 CLI `0.153.4` 升级到 `0.154.0-alpha.6.2` 后，动态 app tools 开始校验到进程祖父级，旧的 `ChatGPT → shim → Node RPC relay → 官方 codex` 拓扑会因未签名 Node 位于祖先链而返回 `missing-code-signing-identity`；当前 macOS shim 把 RPC relay 改成官方 app-server 的 sidecar，并原位启动官方 codex，保留官方签名链。此前启动门禁只核对进程和中继，也不消费 `codex_app` 启动终态或证明常用入口已注册；当前按会话、generation、PID 和运行环境持久化宿主健康状态，要求 `list_threads`、`read_thread`、`list_projects`、`get_usage_limits` 四个常用只读入口齐全。Widget 在所有面板关闭按钮左侧常驻显示无文字彩色状态点；正常悬浮只列易读功能名，异常悬浮只强调缺失项、处理建议与技术诊断。健康检查改为目录事件驱动：状态文件原子替换后 100 毫秒防抖刷新，正常状态每 30 秒兜底，启动中或异常状态每 3 秒自愈；监听不可用时回退到 3 秒轮询。检查时间不进入页面视图模型，避免刷新导致 Tooltip 闪烁；生命周期门禁继续拒绝未核验目录。DeepSeek 目录原先同时声明搜索工具和未指定工具模式，导致 app-server 延迟 MCP 工具并让模型反复发出无意义命令；当前目录关闭该模型不具备的搜索工具能力，使 MCP 从第一轮以直接命名空间暴露。真实 B 原先把所有场景堆在一个长任务中，压缩后的累计上下文会先撞到 Token 阈值；当前后台按工具、历史、压缩、app-server 回调四个独立任务运行，桌面入口作为另一个必需组件单独留证。

MCP 回归固定 `never` 下写入拒绝无副作用和只读工具实际执行两条路径，宿主 URL 使用明确的回环 HTTP 契约；网页来源回归同时固定官方正例和仿冒/无关反例；第三方历史回归实际经过官方 app-server 和模型管理的 DeepSeek 预设路由，覆盖真实推理项、工具历史、恢复、分叉和压缩。模型能力探针不再把任意 custom/namespace 的原生支持当作 Responses 准入条件：Responses 核心续接通过后，代理仅转换探针确认缺失的工具形态，并在返回 JSON、SSE 事件和后续工具结果中恢复 Codex 原始语义；转换后的工具续接、流式输出或组合请求明确不兼容时继续验证 Chat，认证、限流、网络或服务端临时故障则停止检测而不降级。Router 和无 Router 的直接 app-server Relay 共用同一请求能力策略，直接 Relay 只加载当前探针版本中已验证的能力矩阵。修复针对共享数据流和测试边界，并有实际失效断言。

发布版本为 `0.1.235`，Widget 运行时 `150`，中继协议 `69`；账号存储版本为 `3`，模型配置存储版本为 `13`。源码版本和日常 Codex 实际加载版本分别记录，只有 lifecycle 报告中的正式包哈希及中继 generation 能证明本次加载。

### 2026-09-16：macOS C 历史预检归因

本次长任务为官方分页分叉，首序号 24658 与 session_meta 中父任务继承边界一致，文件内部没有断号。原检查器固定从零校验造成误报，现已按声明的分叉边界校验；新增回归覆盖合法边界、元数据不匹配、实际断号以及离线修复不重置继承序号。此项是测试基础设施问题，不是注入器造成聊天记录丢失。

另一个旧回合于 2026-09-15 07:50:39 UTC 开始，只保存了用户输入、没有助手输出；07:51:43 官方桌面日志记录停止 app-server，07:51:52 新桌面启动，随后开始下一回合。rollout 缺少旧回合终态，SQLite 同样保留 inProgress。不能仅凭这组历史证据断言是官方缺陷或注入器触发了重启，也未重新进行故障重现或官方直连/Relay 对照。排查时此后已有 32 个完成回合、3 个中止回合，没有新增缺失终态。按用户要求，将其作为原因未完全确认的历史重启遗留记录，不修改原历史、不新增生产兼容分支，不承诺未来绝不会复发。

该历史遗留不作为日常模型链路回归失败；当前长任务的严格 C 历史前置条件仍未通过，不能因此把 C 标绿或静默忽略缺失终态。以后出现新缺失时重新核对时间线与当前生命周期门禁证据，不因存在这条旧记录直接套用归因。

C 活动回合扫描以当前原生环境的官方 `threads.rollout_path` 为准：只有索引明确指向另一份存在的文件时，才排除被替换的旧 rollout；替代文件缺失或数据库读取失败保持阻断，不能仅按记录年龄忽略。恢复文件名的第二个 UUID 不是任务 ID。未被索引覆盖的新记录继续参与检查。2026-09-16 现场确认旧任务已有恢复文件及完成回合，旧文件残留 `task_started` 不代表仍有运行中的任务；检查器已补对应回归。

C 的发起输入与 B 桌面验收共用官方委托输入识别：同一回合 SQLite 中完整的 codex_app.create_thread / send_message_to_thread 委托输入可代替普通 userMessage；截断、空输入或另一回合的输出不能通过。完成回合仍必须保存最终 agentMessage。

macOS C 的就绪条件包含当前单实例监听者的启动状态（PID、版本、phase、revision）。端口监听早于初始化完成，不能用新监听者配旧 Codex/Relay 的暂态组合判定接管成功。正式入口复用请求进入队列即推进 revision 并置 starting，处理完毕才回到 ready；重复启动验收等待本次 revision 完成，同时持续保持原有 Codex、注入器和 Relay PID 不变，然后执行稳定性观察。报告保留 readiness 子项和启动状态，失败不会仅写“未就绪”。此状态查询只读，不触发接管或重启。

2026-09-16 C 的中继恢复健康误报：同版本官方 CLI `0.154.0-alpha.6.2` 的 `mcpServerStatus/list` 不传 threadId 时返回完整工具目录、runtimeStatus=null；指定已启动的任务时返回 connected。null 代表运行状态不可用，不能覆盖同一 Relay 会话已经收到的 ready 通知。健康检查必须同时具备启动就绪与必需工具目录证据；仅缓存目录、其他任务的有作用域响应、明确 starting/failed 状态或缺失工具均不能冒充就绪。A 原生组件保留同版本官方直连/生产 Relay 的隔离对照，不调用真实模型。

单实例 Socket 的连接重置只关闭该连接，不得导致注入器退出；A 使用真实 TCP RST 后再次查询状态留证。C 回滚若原包已恢复、仅运行时恢复失败，下次恢复应重新核对原包版本、架构和签名后保留原包，不因备份已移回而拒绝恢复；恢复源码版本和中继协议独立记录，不将新版恢复成功算成旧版 C 通过。
