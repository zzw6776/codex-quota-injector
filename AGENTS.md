# 项目规则

- 使用中文回答。
- 修改已有逻辑前必须完整阅读相关代码，禁止基于猜测改动；必要时进行反编译确认。
- 优先使用 CLI 操作。
- 新增功能或改变既有行为时，必须新增或更新有意义的自动化测试，覆盖新增契约和真实失效机制；修复缺陷时必须补充能复现根因的回归测试。不得为追求数量或覆盖率添加只复述实现、没有业务断言、只覆盖极端低价值场景的测试。
- 确实无法自动化的页面布局、系统交互或平台行为，应测试可分离的底层契约，并明确说明仍需人工确认的部分；不得用无意义测试代替。
- 测试固定分为三个顶层批次：A 免费回归；B 消耗 Token 的真实模型验收，其中 B1 只测 Codex 官方模型、B2 只测 DeepSeek；C 涉及关闭或重启 Codex 的生命周期验收。三个批次的报告和通过结论必须分开，旧版本或另一平台的结果不能继承。
- A 批入口为 `npm run test:offline`，包含 `npm test`、实际官方 app-server、生产中继/Router、临时浏览器的点击、输入和截图；使用临时 HOME、测试凭据和本地可观测模型端点，不操作日常账号或消耗模型 Token。A 固定拆成只运行一次的 `A-common` 和平台原生中继组件：macOS 为 `A-macos-native-relay`，Windows 为相互独立的 `A-windows-native-relay` 与 `A-wsl-native-relay`。同一桌面宿主共用的 Widget、浏览器和页面契约放在公共组件；各运行环境的官方 CLI/app-server、动态工具往返及 Relay 链必须在原生组件中分别覆盖。Windows 默认完整 A 必须分别使用 Windows Node.js/依赖/官方 CLI/PE Relay 与 WSL Linux Node.js/独立依赖/WSL 官方 CLI/ELF Relay 执行，两套结果不能互相继承；报告同时给出当前桌面运行环境与当前平台全部支持环境的状态。除纯文档且不改变测试规则或行为的修改外，代码、配置或测试完成后默认自动运行完整 A，不询问用户；`--runtime=current|windows-native|wsl-native` 仅用于开发定位，不能代替 Windows 最终完整 A。当前适配器支持 macOS arm64/x64 与 Windows x64（含 WSL）；其他平台缺少适配时必须报告阻塞。
- A 批通过后，必须主动展示并区分 B1、B2、C 的计划，询问用户分别执行哪些批次，不等待用户追问。计划命令不发送模型请求也不重启：`npm run test:live:official -- --plan`、`npm run test:live:deepseek -- --plan`、`npm run test:lifecycle -- --plan`。可以在同一条消息中并列询问，但用户答复必须能明确区分三个范围；A 失败或报告已过期时先修复并重跑 A，不执行后续批次。
- B1 使用 `npm run test:live:official -- --confirm-token-use`，B2 使用 `npm run test:live:deepseek -- --confirm-token-use`。两批分别使用当前机器账号或供应商 Key 并产生模型用量，必须分别取得本次明确同意；同意其中一批不代表同意另一批，也不沿用以前对后续付费测试的概括授权。B1/B2 每次只绑定一个运行环境，默认自动读取当前桌面设置，也可用 `--runtime=macos-native|windows-native|wsl-native` 明确选择；脚本不会为 B 修改桌面运行方式，且必须要求该环境对应的 A 组件通过。执行器必须拒绝未指定 profile 或选择 `--runtime=all` 的付费执行。TokenHub 或其他供应商不并入 B1/B2，只有用户另行点名后才单独计划。
- C 使用 `npm run test:lifecycle -- --confirm-restart`，必须最后执行并单独取得本次明确同意。C 会构建或安装正式包、接管进程、关闭重开 Codex、验证单实例和中继重连，并在条件满足时切换/恢复真实账号和发送一次已在计划中披露的官方模型冒烟。Windows C 必须由脚本自动依次验证正式包中的 Windows 原生 Relay 与 WSL 原生 Relay，再逐字节恢复测试前的桌面运行配置；用户不手动切换。发现配置被外部修改时拒绝覆盖，上一次 C 未完成或回滚失败时拒绝开始新任务并显示恢复命令。调度前必须成功打开独立的实时报告页面；macOS 由 launchd、Windows 由带登录恢复触发器的任务计划程序监督，保证 Codex 关闭或控制器中断后仍能继续记录、回滚和显示最终状态。
- 真实桌面宿主的 web.run、computer use、Apps、语音、媒体和自动化按 `docs/testing-desktop-host.md` 归入其所使用模型对应的 B1 或 B2；自有动态工具或后台 app-server 通过不能标为桌面主入口全部通过。审批允许/拒绝弹窗不属于测试项，项目固定使用 `never` 策略。
- 禁止轮询、持续等待或使用 watch 命令跟踪 GitHub Actions、Release 或其他 CI/CD 任务；触发任务后应立即向用户提供对应的 GitHub 页面链接，由用户自行查看进度和结果。
- 每次提交代码、配置或文档改动前都必须升级项目版本号，并同步修改 `package.json` 与 `package-lock.json`；用户未指定版本时默认递增补丁版本。GitHub 安装包文件名、Release 标签和 Release 标题必须以该项目版本号为准。

## 版本号更新规则

- 项目有 3 个需要随功能改动判断是否升级的主版本号：
  1. 应用发布版本：`package.json` 与 `package-lock.json` 中的 `version`，两处必须一致。任何准备提交的代码、配置或文档改动都必须升级；默认递增补丁版本。
  2. 页面注入运行时版本：`src/widget.mjs` 中的 `WIDGET_RUNTIME_VERSION`。只要注入页面的 DOM、样式、交互、展示数据或事件处理发生变化就必须升级；纯后端、中继或文档改动不升级。
  3. 中继协议版本：`src/relay-contract.mjs` 中的 `RELAY_PROTOCOL_VERSION`。只要中继启动契约、模型目录、供应商路由、请求/响应改写、模型能力映射或用量事件协议发生变化就必须升级，以触发 Codex app-server 使用新协议重启；纯页面、计价或注入器外围逻辑改动不升级。
- 本地数据和缓存还各自有内部结构版本，例如 `STORE_VERSION`、`CACHE_VERSION`、`COST_CACHE_VERSION`、`ROLLOUT_PARSER_VERSION`、`RELAY_CONFIG_VERSION`。新增、删除、重命名持久化字段，改变缓存内容语义、解析结果语义或配置文件契约时，必须升级对应版本；仅修改兼容旧结构的运行逻辑时不升级。内部结构版本不替代应用发布版本。
- 模型目录中的 `minimal_client_version`、`multi_agent_version` 等字段属于 Codex 模型能力契约，不是本项目发布版本；只有对应能力契约确实变化时才修改，不能用于标记本项目发版。
