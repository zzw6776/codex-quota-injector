# 项目规则

- 使用中文回答。
- 修改已有逻辑前必须完整阅读相关代码，禁止基于猜测改动；必要时进行反编译确认。
- 优先使用 CLI 操作。
- 探测可执行文件版本时只能运行已确认是 CLI 的具体路径；禁止通过通配扫描批量执行 `.exe --version`，图形主程序必须使用文件元数据或已有日志识别，避免意外启动或重启桌面应用。
- 桌面宿主、官方 app-server 或动态工具出现异常时，先核对 rollout 与 SQLite 等权威数据，再用同版本官方 app-server、同一数据和同一原生环境分别执行无 Relay 直连与正式 Relay 对照，逐层区分官方 app-server、Relay 和官方桌面封装。官方直连与 Relay 返回一致、仅桌面封装异常时记为官方上游阻断；只有 Relay 改变结果或已有其他可验证证据定位到项目代码时才修改项目。对照必须记录实际运行二进制版本；长期任务 rollout 的 session_meta 仅表示创建任务时的 CLI，不能代替本轮运行时版本。
- 处理 Windows 问题时，进入项目代码修复前必须先判断是否可能来自 OpenAI/Codex 官方组件、Windows 平台限制或官方安全策略。能够建立对照时，必须使用同版本官方上游、同一原生运行环境和同一测试材料执行无 Relay 对照；官方对照得到同类失败时记录为上游阻断，不修改项目代码规避或绕过，无法建立有效对照时保持 `BLOCKED` 并明确归因未确认。只有官方对照通过而项目链路失败，或已有可验证证据把根因定位到项目代码时，才进行根因修复并补充覆盖真实失效机制的回归测试和对应 Windows 链路验收。
- 新增功能或改变既有行为时，必须新增或更新有意义的自动化测试，覆盖新增契约和真实失效机制；修复缺陷时必须补充能复现根因的回归测试。不得为追求数量或覆盖率添加只复述实现、没有业务断言、只覆盖极端低价值场景的测试。
- 确实无法自动化的页面布局、系统交互或平台行为，应测试可分离的底层契约，并明确说明仍需人工确认的部分；不得用无意义测试代替。
- 测试固定分为三个顶层批次：A 免费回归；B 消耗 Token 的真实模型验收，其中 B1 只测 Codex 官方模型、B2 只测 DeepSeek；C 涉及关闭或重启 Codex 的生命周期验收。三个批次的报告和通过结论必须分开，旧版本或另一平台的结果不能继承。
- A 批入口为 `npm run test:offline`，包含 `npm test`、实际官方 app-server、生产中继/Router、临时浏览器的点击、输入和截图；使用临时 HOME、测试凭据和本地可观测模型端点，不操作日常账号或消耗模型 Token。A 固定拆成只运行一次的 `A-common` 和平台原生中继组件：macOS 为 `A-macos-native-relay`，Windows 为相互独立的 `A-windows-native-relay` 与 `A-wsl-native-relay`。同一桌面宿主共用的 Widget、浏览器和页面契约放在公共组件；各运行环境的官方 CLI/app-server、动态工具往返及 Relay 链必须在原生组件中分别覆盖。Windows 默认完整 A 必须分别使用 Windows Node.js/依赖/官方 CLI/PE Relay 与 WSL Linux Node.js/独立依赖/WSL 官方 CLI/ELF Relay 执行，两套结果不能互相继承；报告同时给出当前桌面运行环境与当前平台全部支持环境的状态。代码、配置、测试或规则改动后不自动运行或重跑 A；只有用户明确要求执行 A 时才运行用户指定的范围。`--runtime=current|windows-native|wsl-native` 仅用于开发定位，不能代替用户要求的 Windows 最终完整 A。当前适配器支持 macOS arm64/x64 与 Windows x64（含 WSL）；其他平台缺少适配时必须报告阻塞。
- A 批通过后，必须主动展示并区分 B1、B2、C 的计划，询问用户分别执行哪些批次，不等待用户追问。计划命令不发送模型请求也不重启：`npm run test:live:official -- --plan`、`npm run test:desktop -- --profile=official --plan`、`npm run test:live:deepseek -- --plan`、`npm run test:desktop -- --profile=deepseek --plan`、`npm run test:lifecycle -- --plan`。可以在同一条消息中并列询问，但用户答复必须能明确区分三个范围；A 失败或报告已过期时先修复并重跑 A，不执行后续批次。
- B1/B2 各自固定拆成后台和桌面两个组件。B1 后台使用 `npm run test:live:official -- --confirm-token-use`，B2 后台使用 `npm run test:live:deepseek -- --confirm-token-use`；后台内部阶段为 `tools`、`history`、`compaction`、`callbacks`。后台通过后，桌面组件使用 `npm run test:desktop -- --profile=official|deepseek --confirm-token-use`，由已选择对应模型的真实 Codex 桌面测试任务执行固定宿主链，执行器从 rollout、当前中继/Widget 和独立材料服务判定。只有两个组件属于同一源码、平台、运行环境和供应商且都通过，对应 B 批才是 `passed`；后台单独通过保持 `incomplete`。两批分别使用当前机器账号或供应商 Key 并产生模型用量，必须分别取得本次明确同意；同意其中一批不代表同意另一批，也不沿用以前对后续付费测试的概括授权。B1/B2 每次只绑定一个运行环境，默认自动读取当前桌面设置，也可用 `--runtime=macos-native|windows-native|wsl-native` 明确选择；脚本不会为 B 修改桌面运行方式，且必须要求该环境对应的 A 组件通过。执行器必须拒绝未指定 profile 或选择 `--runtime=all` 的付费执行。TokenHub 或其他供应商不并入 B1/B2，只有用户另行点名后才单独计划。
- C 使用 `npm run test:lifecycle -- --confirm-restart`，必须最后执行并单独取得本次明确同意。C 会构建或安装正式包、接管进程、关闭重开 Codex、验证单实例和中继重连，并在条件满足时切换/恢复真实账号和发送一次已在计划中披露的官方模型冒烟。Windows C 必须由脚本自动依次验证正式包中的 Windows 原生 Relay 与 WSL 原生 Relay，再逐字节恢复测试前的桌面运行配置；用户不手动切换。任何可能关闭 Codex、注入器或 Relay 的步骤，包括安装接管和失败回滚，都必须先等待官方会话记录中的活动回合完成或中止并稳定落盘；固定延时不能作为会话安全条件。调度时必须记录发起 C 的任务和回合；首次关闭前检查 rollout 序号连续、每个旧回合存在终态、当前运行环境的分页投影追平文件。已知的重复序号或缺失中断终态只能在桌面和 app-server 停止、完整备份原 rollout 及 Windows/WSL SQLite 后自动修复，并只清空目标任务的派生投影；无法证明对话内容保持不变的损坏必须停止为 `BLOCKED`。每套运行环境启动后必须确认发起回合已进入该环境的投影，未追平时不得继续下一次重启或判定通过。重复启动的单实例断言只比较桌面主进程、注入器和 Relay，独立轮换的 app-server PID 仅作诊断证据。Codex 在启动期间写入其他配置时必须保留这些写入，只恢复测试负责的运行方式字段；运行方式字段被外部改写、配置被删除或无法确认所有权时拒绝覆盖。上一次 C 未完成或回滚失败时拒绝开始新任务并显示恢复命令。调度前必须成功打开独立的实时报告页面；macOS 由 launchd、Windows 由带登录恢复触发器的任务计划程序监督，保证 Codex 关闭或控制器中断后仍能继续记录、回滚和显示最终状态。
- 真实桌面宿主的 functions.exec、web.run 和 computer use 由 `test:desktop` 固定留证；执行器还必须从模型请求层记录只含类型、名称和命名空间的脱敏工具清单，逐项区分 `passed`、`unsupported`、`not-executed` 与 `failed`。B1 的 web.run 是必需能力；B2 只有独立 `web.run` 工具时才执行该项，DeepSeek Responses 请求中存在但供应商会忽略的 Hosted `web_search` 描述不能算可调用能力，应按 `unsupported` 留证并阻断 B2 桌面组件，不反复诱导模型重试。通过跨任务委托驱动验收时可用 `--trigger-mode=delegated`。`read_thread` 必须读取 list_threads 返回的正确任务，且返回页中的每个 completed 回合都同时包含真实 userMessage 和 agentMessage；当前 inProgress 回合可以为空。随机标记由 rollout 独立绑定，不要求 read_thread 回显尚未完成的当前输入。Apps、语音、媒体、自动化等条件能力按 `docs/testing-desktop-host.md` 归入其所使用模型对应的 B1 或 B2 并单独保留状态。自有动态工具、后台 app-server 或固定桌面链通过都不能把未执行的条件能力标绿。审批允许/拒绝弹窗不属于测试项，项目固定使用 `never` 策略。
- 禁止轮询、持续等待或使用 watch 命令跟踪 GitHub Actions、Release 或其他 CI/CD 任务；触发任务后应立即向用户提供对应的 GitHub 页面链接，由用户自行查看进度和结果。
- 每次提交代码、配置或文档改动前都必须升级项目版本号，并同步修改 `package.json` 与 `package-lock.json`；用户未指定版本时默认递增补丁版本。GitHub 安装包文件名、Release 标签和 Release 标题必须以该项目版本号为准。

## 版本号更新规则

- 项目有 3 个需要随功能改动判断是否升级的主版本号：
  1. 应用发布版本：`package.json` 与 `package-lock.json` 中的 `version`，两处必须一致。任何准备提交的代码、配置或文档改动都必须升级；默认递增补丁版本。
  2. 页面注入运行时版本：`src/widget.mjs` 中的 `WIDGET_RUNTIME_VERSION`。只要注入页面的 DOM、样式、交互、展示数据或事件处理发生变化就必须升级；纯后端、中继或文档改动不升级。
  3. 中继协议版本：`src/relay-contract.mjs` 中的 `RELAY_PROTOCOL_VERSION`。只要中继启动契约、模型目录、供应商路由、请求/响应改写、模型能力映射或用量事件协议发生变化就必须升级，以触发 Codex app-server 使用新协议重启；纯页面、计价或注入器外围逻辑改动不升级。
- 本地数据和缓存还各自有内部结构版本，例如 `STORE_VERSION`、`CACHE_VERSION`、`COST_CACHE_VERSION`、`ROLLOUT_PARSER_VERSION`、`RELAY_CONFIG_VERSION`。新增、删除、重命名持久化字段，改变缓存内容语义、解析结果语义或配置文件契约时，必须升级对应版本；仅修改兼容旧结构的运行逻辑时不升级。内部结构版本不替代应用发布版本。
- 模型目录中的 `minimal_client_version`、`multi_agent_version` 等字段属于 Codex 模型能力契约，不是本项目发布版本；只有对应能力契约确实变化时才修改，不能用于标记本项目发版。
