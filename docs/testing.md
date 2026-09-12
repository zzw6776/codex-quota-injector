# 测试入口与验收边界

只分两批：**A 免费回归，B 真实模型和桌面宿主验收**。B 最后用独立生命周期监督器处理关闭、重启、进程接管、安装更新和真实账号切换。测试当前平台，不要求其他平台同时通过。

最近一次完整 A：2026-09-12，macOS arm64，`codex-cli 0.154.0-alpha.6.2`、Chrome `153.0.8010.36`、Node `26.7.0`，**236 项通过，0 失败、0 跳过**；其中基础测试 194 项，实际官方运行时/浏览器 42 项，共约 71.9 秒。代码摘要为 `7626b73fd13a40d2ddff4cda68c3f789a91a6e3195beb49c5359aa81bb68d704`。全部 70 项索引都有通过的免费证据，其中 67 项仍按各自适用条件保留真实 B 验收要求；免费证据不等于真实宿主或模型验收完成。

同一代码摘要下，B 后台按四个独立阶段完成真实测试。官方配置各阶段起始选择 `gpt-5.6-luna`，文件/命令/补丁与 MCP、历史恢复与分叉、显式压缩与压缩后续接、动态网页/浏览器适配、识图、原生 `webSearch` 和用户输入回调均通过，共观测 337,757 Token、11 个常规轮次。历史阶段的最小 `thread/fork` RPC 未携带模型参数，分叉首轮由 app-server 选择当前官方默认 `gpt-6-astra`；因此该项证明官方分叉和历史保留可用，不把它表述为 Luna 精确继承。DeepSeek `deepseek-v4-flash` 的同类适用场景均通过，共观测 639,731 Token、9 个常规轮次，恢复、分叉和压缩后请求均继续路由到 DeepSeek；该模型不声明图片能力，也不运行官方专属 `webSearch`。TokenHub Responses、TokenHub Chat 按本机环境限制未运行，结果保持 `NOT_RUN`，既不计为通过也不计为失败。

真实 OAuth 账号还通过隔离的官方 app-server 完成一次最小唤醒请求并取得预期回复。该辅助链不切换账号、不写入日常配置，也不替代主入口验收。

当前桌面主入口还实际完成了 `web.run` 的 search/open/find、Codex App 的项目与额度只读调用、一次不占用当前任务的独立自动化调度、真实图片生成，以及 computer use 对回环 HTTP 材料的读取、输入、单次提交、截图和下载事件；自动化与服务端产物的随机标记均由独立文件核对，图片产物也已直接查看。临时自动化在首次成功后已经暂停并删除，没有重复运行。该宿主证据确认相应工具可调用，但后台报告仍保持 `desktop-host-not-verified`，不能据此宣称当前源码的桌面主入口全部通过。详见 `.runtime/test-results/desktop-host.md`。

首次生命周期实测把正式包 `0.1.202` 和中继协议 `52` 加载进日常 Codex；正式包验签与更新、进程接管、重复启动单实例、中继自动重连、关闭后重开均通过。切换到第二个 OAuth 账号后，唯一一次最小模型冒烟收到该账号的用量上限错误，因此整批保留为失败；监督器随后成功回切原账号、恢复安装前 `0.1.167`，并从当前源码重新启动。当前只读计划确认源码 `0.1.203`、中继协议 `53` 已由开发入口加载且就绪；它仍需下一次生命周期报告验证 `0.1.203` 正式安装包和第二账号冒烟。

## 日常怎么运行

| 命令 | 作用 |
| --- | --- |
| `npm test` | 免费基础契约、状态机和故障回归；可以在 CI 运行 |
| `npm run test:offline` | 当前平台完整 A：基础测试 + 实际官方运行时 + 生产 shim/Router/Chat 代理 + 隔离浏览器操作 |
| `npm run test:live -- --plan` | 免费读取本机启用的供应商配置，列出 B 的模型、协议和停止阈值；不读取账号凭据或发模型请求 |
| `npm run test:live -- --confirm-token-use` | 当前代码的 A 通过并获当次明确同意后，执行 B 后台链路 |
| 上述命令追加 `--profile=<配置 ID>` | 只计划或执行一个配置的完整 B 场景，独立写入 `live-<配置 ID>.json`，用于失败后续测而不重复消耗已通过配置 |
| 上述命令追加 `--stage=tools\|history\|compaction\|host` | 只运行一个隔离阶段；四阶段各自启动 app-server 并单独应用停止阈值，避免长任务累计上下文干扰后续场景 |
| 上条命令追加 `--wakeup` | 后台链路通过后，再执行一次独立的真实账号唤醒 |
| [桌面宿主步骤](testing-desktop-host.md) | B 的另一部分：当前 Codex 实际调用 web.run、computer use 等；不是第三批测试 |
| `npm run test:lifecycle -- --plan` | 只读列出本机 Codex、注入器、已安装包、中继协议和可用账号条件；不重启、不切换、不发模型请求 |
| `npm run test:lifecycle -- --confirm-restart` | A 属于当前源码后，构建并验签正式包；先在 Safari 打开每秒更新的独立进度页，再由 launchd 监督器执行重启、接管、断线恢复、安装更新与账号往返；账号切换后发送一次最低价官方模型冒烟 |
| `npm run test:lifecycle -- --status` | 读取最近一次持久化报告；也可追加 `=<run-id>` 指定报告。监督器中断后用 `--resume=<run-id>` 按检查点恢复，并重新打开进度页 |

公共链路、模型目录、Widget 和测试运行器有改动时执行完整 A；局部修改先跑相关免费用例。没有新改动或疑点时不重复测试。B 失败后停止后续配置，不自动重试整套付费用例。

## A 实际执行了什么

当前官方运行时和浏览器适配器针对 **macOS**。使用已安装的 Codex CLI、Xcode Command Line Tools 的 Swift 编译器和 Chrome/Edge；可用 `CODEX_TEST_CLI`、`CODEX_TEST_BROWSER` 指定路径。缺少工具或当前平台未适配时报告阻塞，不跳过后宣称通过。基础 `npm test` 仍可在其他平台运行。

A 中实际官方运行时、工具和浏览器子进程通过 macOS 系统沙箱限制为仅访问本机端口及本地 Unix 通信；有实际公网连接被 `EPERM` 拒绝的断言。官方 CLI 使用临时 HOME、CODEX_HOME、XDG 目录和测试凭据，模型端点是本地脚本服务。隔离 Chrome/Edge 使用临时用户目录；macOS 启动参数固定包含 `--use-mock-keychain`，不读取或弹窗请求日常 Chrome 钥匙串。官方解析、命令、补丁、PTY、MCP、Hooks、文件、Git 和浏览器执行都是真实的；模型响应由固定材料提供，不产生模型 Token。

基础契约沿用 `npm test` 的临时材料和假凭据，不启动真实模型；它需要调用 macOS `/bin/ps` 核对进程身份，该系统程序不能在 Seatbelt 内执行，因此运行器先执行基础契约，再在出站受限的环境执行官方/浏览器组合。macOS 也不允许嵌套 Chrome 渲染器沙箱，只有临时浏览器使用 `--no-sandbox`，外围系统网络隔离保留；不改变用户浏览器设置。B 的真实工具改用官方 `workspace-write` 文件沙箱，执行结果需由 B 实测。

| 证据文件 | 核对内容 |
| --- | --- |
| [官方工作流](../runtime-tests/official-workflows.test.mjs) | 官方直接路径、Swift shim、官方经 Router、第三方 Responses/Chat、生产生成目录；文件读写/补丁/并行失败命令、2 MiB 内容、PTY、历史/分叉/归档恢复、输入队列恰好执行一次 |
| [交互](../runtime-tests/official-interactions.test.mjs) | MCP 发现/资源/实际调用/错误/elicitation；写入型 MCP 在 `never` 下拒绝且无副作用、在隔离审批后执行；批准与拒绝的文件差异、Plan 用户输入、动态工具回调、中断与再继续、Skills 和项目 |
| [上下文](../runtime-tests/official-context.test.mjs) | 官方手动压缩、压缩后状态与用量；有效图片/附件/产物；steer、设置、历史注入；真实加载和信任后的 Hooks 执行 |
| [第三方历史兼容](../runtime-tests/deepseek-history.test.mjs) | 实际官方 app-server 经内置 DeepSeek 路由恢复并分叉任务，模拟真实 `reasoning_text` 流并保留消息和工具调用/结果关联；恢复、分叉、压缩及压缩后续接请求剥离 Codex 私有消息元数据和 DeepSeek 不支持的推理字段 |
| [DeepSeek 工具链](../runtime-tests/deepseek-tools.test.mjs) | 实际官方 app-server 经生产 macOS shim、中继和 Router 连接本地 Responses/MCP；首个请求直接暴露 MCP 命名空间，不依赖 `tool_search`，精确审批一次并验证真实副作用与工具结果续接 |
| [任务状态](../runtime-tests/official-task-state.test.mjs) | 目标实际执行文件任务并完成、官方自动压缩、时间线分页、分组/删除、会话式文件搜索 |
| [扩展](../runtime-tests/official-extensions.test.mjs) | 默认和实验协议 Schema 摘要核对；当前平台设备验证状态的实际只读判定；本地插件实际安装/停用/卸载；Git 真实差异审查 |
| [Widget 浏览器](../runtime-tests/widget-browser.test.mjs) | 真实 DOM 注入/替换/销毁、点击/输入、全部面板动作、表单到配置管理器、不同尺寸/主题/任务节点变化、原生输入及工具按钮仍可操作 |
| [工具宿主组合](../runtime-tests/browser-host.test.mjs)、[桌面材料](../runtime-tests/desktop-fixture.test.mjs) | app-server → 动态工具 → 本地网页/浏览器 → 独立服务或页面状态 → 模型续接；实际 data URL 导航、输入、点击及下载文件；CDP 断开后仍回收测试浏览器；不冒充桌面 web.run/CUA |
| [协议回归](../test/relay-protocol.test.mjs)、[Chat 工具契约](../test/chat-tool-contracts.test.mjs)、[新增格式](../test/chat-protocol-tools.test.mjs)、[路由恢复](../test/model-router-recovery.test.mjs) | 双向请求/ID/分页/大消息，Responses Lite/custom/namespace，历史关联、指定工具、预热/断流/错误/取消、不同供应商隔离与观察故障 |
| [账号可靠性](../test/account-reliability.test.mjs)、[OAuth](../test/account-oauth.test.mjs)、[唤醒进程](../test/wakeup-client.test.mjs) | 并发/写入和 rename 失败/损坏数据保护；测试 OAuth 的 PKCE/state、端口冲突/超时/取消、导入导出；真实子进程的最低价选择、刷新、异常和清理 |
| [基础测试目录](../test)、[测试边界](../test/testing-boundaries.test.mjs) | 原有账号、模型配置、计价、计量、CDP、单实例等契约继续执行；未授权 B 不读取账号或启动模型，场景索引不能漏项 |

关闭的是本轮自己创建的测试 CLI、终端和浏览器。没有启动第二个桌面 Codex 去操作日常 Codex，也没有调用生产的全局停止、重启、账号切换或接管入口。

当前桌面宿主的 in-app Browser Use 已成功打开只绑定 `127.0.0.1` 的 HTTP 材料，完成读取、输入、点击、结果读取、截图和下载事件。隔离 Chrome 的自包含页面继续验证底层 DOM 与文件契约；两类证据分别记录，不能相互冒充。`file://` 在页面加载前被 URL 策略拒绝属于正常安全边界，不再作为注入或 computer use 失效证据。

## B 的真实判据与成本

后台 B 使用当前凭据登录临时、仅内存保存认证的官方 app-server，再经过生产 shim、目录生成器、Router/Chat 代理。当前账号的 auth.json、Keychain、日常配置及任务不被写入。认证过期而需要未实现的桌面刷新交互时失败，不改写日常账号来绕过。

对官方模型和每个启用供应商的不同协议各选一个明确列出的模型，核对真实文件修改、MCP 标记、历史恢复/分叉、压缩后口令、动态工具结果、用户输入回调；声明支持图片的模型额外识图，官方模型额外执行原生网页搜索。网页搜索必须产生官方 `webSearch` 事件，并返回路径属于 app-server 的 OpenAI 文档站或 `openai/codex` 官方仓库链接，不能只按单一站点域名判断。写入型 MCP 使用 `on-request`，执行器只接受服务名、审批种类和本轮随机标记全部匹配的一次隔离审批；其他宿主请求立即失败。这不等于目录中每一个模型都已单独测试。

每个隔离阶段的默认停止阈值为观察到 500,000 Token 或启动 40 个常规轮次；可用 `CODEX_TEST_LIVE_MAX_TOKENS`、`CODEX_TEST_LIVE_MAX_TURNS` 调低。它们是停止条件，**不是预估费用或严格账单上限**，在途请求、压缩与工具费用可能超出；实际唤醒单独增加一次最小请求。首次真实运行前必须展示计划，由用户明确同意；已有明确覆盖后续运行的持续授权时沿用该授权。

后台进程没有桌面特有的 web.run、computer use、Apps、语音、自动化和远程宿主。B 后台成功状态为 `desktop-host-not-verified`，再按[桌面宿主步骤](testing-desktop-host.md)留下实际调用和独立结果。缺少能力、配置或权限必须写原因；不能把未执行改成通过。

## 报告和以后怎么防止漏测

- `.runtime/test-results/offline.json`：本次平台、Node、实际 CLI/浏览器版本和可执行文件摘要、源码摘要、用例结果，以及全部 70 个场景的证据状态。
- `offline-events.jsonl` 与 `browser-*.png`：逐项事件和浏览器截图；错误保留首次异常。截图来自临时页面。
- `live-<配置 ID>.json` 与 `live-<阶段>-<配置 ID>-events.jsonl`：真实计划和后台结果；失败时保留阶段、用量、工具状态、脱敏错误和 MCP 参数形状，不复制提示词或工具正文。当前通过报告为 `live-official.json` 与 `live-deepseek.json`；TokenHub 两条没有运行报告。
- `lifecycle/<run-id>/report.json`：正式包哈希、每次 Codex/注入器/中继 PID、协议版本、恢复方式和脱敏账号指纹。相邻的 `progress.html` 从该报告生成，测试开始前在 Safari 打开，显示当前步骤、失败和回滚状态；它不触发操作，也不参与通过判定。`control.json` 权限为 `0600`，只为中断恢复保存两个账号 ID，不保存 Token；公开报告不写账号 ID、邮箱或 Router 私密地址。
- [场景索引](testing-scenarios.json)逐一对应[70 项矩阵](codex-compatibility-test-plan.md)。`free-evidence-passed` 只表示列出的免费证据通过，仍保留 `liveStatus: not-run` 和每项限制；不能把它当完整验收。
- [协议清单](testing-protocol-inventory.json)覆盖当前 CLI 的默认及实验协议。字段、方法或类型变化会使 A 失败，要求重新审核清单和补测试，不能默默复用上次绿灯。
- B 启动前核对本次平台、源码/测试文件摘要及实际 CLI/浏览器摘要。旧代码、运行时升级或测试期间文件改变的报告无效。
- A/B 不依赖当前对话在失败后继续作答。后台模型测试由 Node 控制程序落盘；生命周期测试由 launchd 托管的一次性 Node 监督器落盘，并由独立 Safari 页面展示同一份脱敏报告。页面无法打开时不调度重启；步骤开始前写检查点，已核实完成的副作用不重复，模型请求结果未知时拒绝自动重放并先恢复原账号。

## 补测发现并修复的问题

本轮回归复现并修复了 Responses Lite/命名空间/原始文本工具无法正确转换、WS 本地预热丢失增量历史、账号写入失败留下虚假内存状态、取消 OAuth 后仍可能保存授权、唤醒进程继承日常 HOME、Widget 主题切换不同步、隔离 Chrome 误探测日常 macOS 钥匙串、真实测试错误拒绝写入型 MCP 工具、原生网页搜索错误排除 OpenAI 官方仓库来源、Codex 私有历史元数据被转发给第三方 Responses API，以及 Codex 重放的推理历史含有 DeepSeek 不支持字段等问题。DeepSeek 目录原先同时声明搜索工具和未指定工具模式，导致 app-server 延迟 MCP 工具并让模型反复发出无意义命令；当前目录关闭该模型不具备的搜索工具能力，使 MCP 从第一轮以直接命名空间暴露。真实 B 原先把所有场景堆在一个长任务中，压缩后的累计上下文会先撞到 Token 阈值；当前按工具、历史、压缩、宿主四个独立任务运行。

MCP 回归同时固定拒绝与批准两条策略路径，宿主 URL 改用明确的回环 HTTP 契约；网页来源回归同时固定官方正例和仿冒/无关反例；第三方历史回归实际经过官方 app-server 和内置 DeepSeek 路由，覆盖真实推理项、工具历史、恢复、分叉和压缩。修复针对共享数据流和测试隔离边界，并有实际失效断言。

发布版本为 `0.1.203`，Widget 运行时 `123`，中继协议 `53`；持久化结构未改变，因此账号存储版本仍为 `2`。源码版本和日常 Codex 实际加载版本分别记录，只有 lifecycle 报告中的正式包哈希及中继 generation 能证明本次加载。
