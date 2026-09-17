# 官方模型与 DeepSeek Flash 测试：真实桌面入口验收

报告版本16起按[组件输入影响规则](testing-index.md#修改后测什么按实际影响复用)复用后台与桌面证据。原始全仓摘要和执行发布版本继续留证，不作为全部组件失效的依据；行为复用按对应受测输入等价判断。文档、发布版本和无关免费用例变化不强制重新消耗后台模型Token。已完成报告的状态查询只展示执行结果与当前有效性，不重写历史结论。

全部6个测试组件及macOS原生、Windows原生、WSL原生的18个验收位置见[测试总索引](testing-index.md)。本页只说明其中两个模型的桌面链与后台绑定条件。

官方模型测试和 DeepSeek Flash 测试各自由两个必须分开保存的组件组成：

| 组件 | 运行位置 | 固定验证范围 |
| --- | --- | --- |
| `model-official-backend/<runtime>` / `model-deepseek-backend/<runtime>` | 隔离的官方 app-server | 真实模型路由、文件/命令/MCP、历史、分叉、压缩及 app-server 回调 |
| `model-official-desktop/<runtime>` / `model-deepseek-desktop/<runtime>` | 当前 Codex 桌面任务 | 实际模型、codex_app 会话读取、functions.exec、web.run、computer use、当前 Widget/中继/运行环境 |

同一平台、运行环境和供应商的两个组件受测输入仍有效且均为 `passed` 时，原始功能执行总状态为 `passed`；已确认且符合复用条件的官方/兼容性阻断另存接受报告并计验收通过，详见[验收口径](desktop-known-issues.md#通过报告口径)。后台通过而桌面组件未运行时，总状态是 `incomplete`；不再使用容易被误解为整批通过的后台结果代替桌面结论。

## 执行顺序

无需免费回归报告作为前置条件。后台直接准备本次原生 Relay，桌面入口直接读取本次源码摘要并核对对应后台报告；旧免费报告缺失、失败或过期都不阻断。测试期间受测输入变化时，按影响范围判定对应组件有效性。

计划命令不会发送模型请求：

```sh
npm run test:live:official -- --plan
npm run test:desktop -- --profile=official --plan

npm run test:live:deepseek -- --plan
npm run test:desktop -- --profile=deepseek --plan
```

用户要求该模型的整体验收后，按项目的长期用量授权直接运行后台组件：

```sh
npm run test:live:official -- --confirm-token-use
# 或
npm run test:live:deepseek -- --confirm-token-use
```

后台组件通过后，从独立终端启动同一供应商的桌面组件：

```sh
npm run test:desktop -- --profile=official --confirm-token-use
# 或
npm run test:desktop -- --profile=deepseek --confirm-token-use
```

由另一个 Codex 任务通过任务工具发送验收文本时，追加 `--trigger-mode=delegated`；人工直接在目标任务中粘贴或输入时保持默认 `direct`。这个参数记录触发来源，不改变模型、运行环境或工具通过标准。

桌面执行器会先创建报告、启动只监听 `127.0.0.1` 的随机材料服务，并打开可见的 `progress.html`，然后输出一段带验收编号和随机标记的任务文本。把这段文本发送到已经选择目标模型的真实 Codex 桌面测试任务中。不启动第二个 Codex，也不让一个 Codex 通过 UI 控制另一个 Codex。审批允许/拒绝弹窗不属于测试项，项目继续使用 `never`。

执行器每两秒从本机证据刷新报告，完成后自动退出。也可读取已有任务状态：

```sh
npm run test:desktop -- --status=<run-id>
```

验收任务应使用短历史：先让已获授权的专用任务完成一轮简短输入与回复，再发送完整验收提示。`read_thread` 固定读取两轮，保留 `includeOutputs: true` 和 `maxOutputCharsPerItem: 20000`，以覆盖前一完成回合与当前活动回合。不要反复复用已积累大量浏览器、命令和嵌套读取输出的失败任务；过大的工具返回仍可能受宿主总输出预算截断。按项目规则自动创建所需的专用测试任务，不再询问新建任务授权。

所有必需工具必须在随机标记绑定的同一回合内实际执行。失败后允许在该回合重试，成功命令必须同时返回标记和退出码 0；后续回合的补做不能拼入原报告。模型文字称“完成”不改变缺项判定。连续出现执行遗漏时停止重复付费尝试，记录缺项，不靠增加提示次数保证通过。

## 并行调度

已纳入用户测试请求范围、前置条件满足且使用独立隔离运行时的官方模型与 DeepSeek Flash 后台测试默认并行。各模型的桌面测试在自己的后台通过后即可启动，不以另一模型整批完成为条件；同一模型内部已有阶段顺序和失败停止条件保持有效。

桌面测试按资源安排并发：

- 命令、只读任务工具、网页工具等互不干扰的步骤并行；每个模型使用独立任务、随机标记、材料服务和报告，不共用可写测试材料。
- 浏览器分别绑定自己的标签页，Windows 原生交互分别绑定自己的材料窗口。只有确认操作不争用全局焦点、键鼠或可变配置时才并行；独立标签页本身不能证明焦点隔离。
- 需要共享焦点或键鼠的交互只在该步骤排队，完成后立即释放；其他独立步骤继续运行。不得默认让一个模型等待另一个模型整批结束。串行前说明具体冲突资源及串行范围。
- 步骤排队仍在本次标记绑定的同一回合内完成，不拆到后续回合拼证据。计划并发前确认实际工具的隔离方式；若无法在同回合内安全协调，说明限制和必要的串行范围。

并行不增加模型、平台或场景范围；用户请求范围内的真实用量和测试任务创建按项目长期授权执行，预算、停止阈值和结果独立保存要求保持不变。用户只要求补测指定项时，仅安排这些项。

## 固定判据

桌面组件逐项核对：

1. 对应组件执行输入在测试期间未变化；实际 Widget 显示当前项目版本，或满足全部生产输入等价的版本复用条件，实际中继协议与源码一致；接管 app-server 时，`codex_app` 健康状态必须为 `ready`。
2. 当前桌面运行环境与报告一致。macOS、Windows 原生 Relay、WSL 原生 Relay 的结果不能互相继承。
3. rollout 中任务实际使用官方模型测试的官方模型或 DeepSeek Flash 测试的 `deepseek-flash`，并记录任务 ID、轮次 ID 和各工具调用 ID。
4. `functions.exec` 的成功命令返回随机标记；另一命令返回随机标记和退出码 23，且同一任务随后继续调用其他工具。
5. 实际 `codex_app.list_threads` 返回当前任务，再以该任务 ID 调用 `codex_app.read_thread`。调用时设置 `includeOutputs: true`、`maxOutputCharsPerItem: 20000`，因为默认返回会隐藏委托正文。返回页中的每个 `completed` 回合都必须同时包含真实输入和 `agentMessage`：输入允许 `userMessage`，或 `namespace: codex_app`、`name: create_thread|send_message_to_thread` 的 `functionCallOutput`，后者必须有完整 `codex_delegation`、非空 `source_thread_id` 和 `input` 正文。官方输出包装 `{text, truncated}` 与完整字符串都可识别，截断或仅有工具名称不能通过。只检查匹配任务中的回合，不能跨任务或跨回合拼凑输入与回复；任一完成回合的 `items` 为空或缺失都不能通过；当前 `inProgress` 回合可以为空，`interrupted` 按官方单独行为留证。当前活动输入在回合完成前不会进入 read_thread 投影，因此随机标记只由 rollout 独立绑定，不要求 read_thread 重复回显。随后实际调用 `codex_app.list_projects` 与 `codex_app.get_usage_limits` 并正常返回。四个调用分别记录调用 ID，本地读取 rollout 不能代替。
6. 目标模型回合必须正常结束；`task_complete.error`（包括 `usage_limit_exceeded`）单独写入报告并判定失败，不能被后续 Relay 恢复掩盖。桌面或 app-server 在回合终态附近轮换时，运行时检查会等待同代 Relay 有界恢复后再判定，避免把瞬时切换误报为 Relay 根因。
7. 执行器从中继收到的真实模型请求记录脱敏工具清单，只保留工具类型、名称、命名空间和 MCP server label，不保存提示词、参数、Schema、工具输出或凭据。实际 `web.run` 完成 `search_query`、`open` 或 `click` 导航、`find`，结果来自 OpenAI 官方 Codex 文档或 `openai/codex` 仓库并包含 `thread/fork`。官方模型测试可使用独立 `web.run` 或官方 Hosted Search；DeepSeek Flash 测试只有独立 `web.run` 才视为可调用，DeepSeek Responses 请求中存在但供应商忽略的 Hosted `web_search` 描述单独记录为 `unsupported`（不适用），不影响支持范围内的整体验收通过，不继续无效重试。已支持但任务结束仍未调用记为 `not-executed`，调用后返回错误记为 `failed`。
8. Windows 上实际 computer use 启动本轮动态生成的 WinForms 原生应用，通过辅助功能读取随机标记、输入并只提交一次，同时调用一次截图；原生清单独立记录启动次数和提交值。macOS 使用本机 HTTP 材料并额外核对下载事件。调用发生但返回错误不能算通过；模型文字说明不参与判定。

`file://` 会在 Browser Use 页面加载前被 URL 安全策略拒绝，这是正常边界。桌面材料固定使用本机 HTTP；如果当前宿主仍拒绝回环地址，报告保留原始结果并标记未通过，不修改系统网络策略或加入防火墙规则。

## Windows 非浏览器 Computer Use 基线

Windows 的 TOOL-06 以每轮动态生成的 WinForms 原生应用为验收材料，浏览器或 HTTP 页面不能替代。材料入口为：

```sh
node scripts/test-computer-use-windows.mjs
```

WSL 会把材料生成和证据监督完整交给 Windows Node.js。`test:desktop` 已在 Windows 接入该原生清单，并拒绝重复启动、重复提交、错误标记以及只发生调用但返回错误的 Computer Use 结果。Relay 出错时还必须用同版本官方上游、同一原生环境和同一材料建立无 Relay 对照后再归因。当前官方 Computer Use 不能把 WSL 的 `/mnt/...` 工作目录映射为 Windows 本地 URI，因此 WSL 桌面任务保留 `BLOCKED_UPSTREAM`；Windows 原生 Relay 才是非浏览器应用完整交互的可执行链路。

## 平台和运行环境

默认 `--runtime=current` 只读取当前桌面设置，不修改它。也可显式指定本平台的一个环境：

```sh
npm run test:desktop -- --profile=official --runtime=macos-native --plan
npm run test:desktop -- --profile=official --runtime=windows-native --plan
npm run test:desktop -- --profile=official --runtime=wsl-native --plan
```

付费执行拒绝 `--runtime=all`。Windows 桌面若当前使用 WSL，执行器会从 WSL 的 Codex 会话目录读取本次随机标记所在的 rollout；Windows 和 WSL 的 Node.js、依赖、CLI、Relay、`codex_app` 健康状态及报告仍各自独立。测试脚本不会为了真实模型测试批自动切换桌面运行方式，自动切换和逐字节恢复只属于最后执行的启停恢复测试批。

## 报告与其他桌面能力

每次结果写入 `.runtime/test-results/desktop-host/<run-id>/report.json`，相邻 `progress.html` 只显示脱敏步骤和状态，不驱动测试，也不参与断言。后台报告同步记录桌面报告路径、两个组件状态和真实模型测试总状态。固定检查逐项使用 `passed`、`unsupported`、`not-executed`、`failed` 或执行中的 `not-run`；明确不支持的 `unsupported` 项作为“不适用”单列，并从适用项总数中排除；其余适用项全部通过时桌面组件为 `passed`。原始执行保留 `not-executed`、上游阻断和实际调用失败；已确认且符合复用条件的上游/兼容性问题在独立接受报告中计验收通过。普通遗漏仍未通过，不能将证据不足或未完成配置当作不支持。报告不保存提示正文之外的真实业务内容、工具输出正文或凭据。

`read_thread` 或其他官方宿主工具异常不能根据单次桌面结果直接归因。先检查已知问题并核对 rollout/SQLite。`read_thread` 的正确任务中出现 completed 回合空 items 时，第一排查方向是 `codex-desktop-read-thread-pagination-cursor`，按[证据复用说明](read-thread-pagination-investigation.md#再次出现时先做什么)核对适用条件；匹配时引用既有对照并注明本任务未重复对照，不因供应商或任务变化重复完整定位。首次出现或证据不匹配时，再以实际运行的同版本官方 app-server、同一数据分别运行无 Relay 直连和正式 Relay 对照。两个底层结果一致且桌面封装异常的证据齐全时才标记 `blocked-upstream`；对照不一致仍保持 `failed` 并继续定位。当前 read_thread 归因只匹配“正确任务已成功返回，完成回合全部为显式空 items”的现场形态；缺失 items 字段、委托正文不完整或其他读取错误不能套用这个阻断标签。

已确认的 macOS 桌面分页游标问题见 [read_thread 分页问题复现材料](read-thread-pagination-investigation.md)。委托输入判据修复不改变该问题的 `blocked-upstream` 状态，也不重写既有验收报告；后续执行生成报告版本 11 的新证据。

若 `read_thread` 返回的 JSON 中间出现 `…数字 tokens truncated…` 且已无法解析，报告单独说明工具输出被预算截断，仍保留失败；这不是空回合，不能套用分页游标归因，也不能靠补括号恢复成通过证据。2026-09-16 的只读复核确认，同一旧回合重新返回合法 JSON 时，先前截断处前后的内容逐字一致，中间 37,673 字符曾被 23 字符的截断标记替换。同一 macOS 环境、CLI `0.154.0-alpha.6.2` 对同一回合执行 `thread/items/list`，官方无 Relay 与生产 Relay 都返回 67 条内容，完整响应 SHA-256 一致。本地对照保存在 `.runtime/read-thread-investigation/output-budget-control-summary-20260916.json`。这些证据确认截断机制且未发现 Relay 改写读取结果；仍不能把工具总输出预算的具体施加位置归到某一层，报告不自动升级为已知上游阻断。

Windows Computer Use 截图失败也遵循同一规则。桌面执行器只读取 `.runtime/test-results/desktop-host/upstream-attributions-<runtime>.json` 中经过结构核验的归因；当前 rollout 必须出现对应失败，并且文件必须同时记录同运行环境的生产 Relay 失败与已移除 Relay 的官方对照失败，才允许将截图标记为 `blocked-upstream`。

兼容入口 `node scripts/test-desktop-host.mjs --serve` 仍可只启动免费材料服务，但它不选择模型、不读取 rollout，也不能生成真实模型测试桌面组件通过结论。

Apps、插件独特能力、媒体生成、自动化、远程环境和实时语音取决于当次桌面实际开放与配置，继续按[场景矩阵](codex-compatibility-test-plan.md)逐项记录 `PASS`、`FAIL`、`BLOCKED`、`NOT_RUN` 或有依据的 `OUT_OF_SCOPE`。固定桌面组件通过不会把这些条件场景自动标绿。关闭/重启、接管、单实例、断线恢复、正式包更新和真实账号往返以启停恢复测试批 `.runtime/test-results/lifecycle/<run-id>/report.json` 为准。

## 两项验收器修复与定向补测（报告版本 12）

网页检查采纳标记所在同一回合中的后续成功查找，要求真实搜索返回、导航返回及带官方文档来源和 `thread/fork` 正文的 find 返回依次存在；`open` 与 `click` 均可用于导航。首次未命中不阻止同回合后续成功，空返回、工具错误和 `No matching text found` 不能通过，也不能跨回合拼接。浏览器输入识别包含 computer use 的 Playwright `fill()`，仍要求真实成功返回及材料服务恰好一次正确提交。两项共用解析逻辑适用于 macOS 和 Windows，Windows 原生材料约束保持不变。

用户只授权补测指定项时，单独保存定向补测报告，列出源码摘要、任务/回合、调用 ID、独立材料证据和本次检查项；不能将其写成新源码的完整桌面或全量回归通过报告，也不覆盖历史报告。对应回归命令为 `node --test test/desktop-host-targeted.test.mjs`。DeepSeek 当前缺少独立 `web.run` 的三项保留 `unsupported`，按报告版本 13 计为不适用，不要求为通过测试补造该能力。

## 报告版本 13：按适用能力验收

通过比例只统计适用项，不适用数量单独展示，例如 DeepSeek 桌面 13/13 通过、3 项不适用；不支持的项目本身不标为 passed。基于旧执行证据重新应用此口径时，另存复核报告并记录原报告路径、原测试源码摘要、复核规则版本和时间，不覆盖原始执行报告，也不声明当前源码已重新完成全量测试。

## Windows 原生入口修复（报告版本 14）

2026-09-16 的官方模型桌面测试 `20260916132137-1ebdc41d` 使用项目 0.1.271、Windows 原生 Relay、实际模型 `gpt-5.6-sol` 与 CLI `0.154.0-alpha.6.2`，13/15 项通过。任务读取 Windows computer-use 技能后仍选择 `cua_repl`，调用 `cua.getApp` 返回 `cua.getApp is not a function`。原生材料没有启动或提交，截图调用为空；这与旧 `SetIsBorderRequired` 截图失败不同，不能继承旧上游归因。该入口返回的文档列出了 getApp，但实际对象没有提供它；项目不修改官方工具或增加兼容 API。

当前机器通过 `node_repl` 原生导入 `@oai/sky` 已确认 `target` 为 Windows，launch_app、get_window_state、type_text 和 click 均为函数。测试提示现在要求按当前 Windows computer-use 技能初始化这一专用入口，检查必要 API 后只启动一次材料，以返回的窗口对象读取辅助功能树、核对完整标记和焦点、输入并单次提交。截图固定在提交前独立执行，因为正确提交会自动关闭材料；截图失败后须重新观察辅助功能树，再完成仍可执行的提交。入口未开放或初始化失败时保留原始错误，不能改用浏览器或 shell 驱动，也不能记为不适用。

报告版本 14 将 cua/sky 的 `is not a function` 返回识别为 `native-api-unavailable` 并拒绝当成成功，失败交互项另列原因；未调用的截图仍保留 `not-executed`，不会自动归因上游。`node --test test/desktop-host-targeted.test.mjs test/desktop-host-evidence.test.mjs` 的定向回归覆盖入口引导、路径转义、窗口关闭前截图以及原始错误的判定。本次仅核对 API 与定向契约，没有重新执行真实桌面交互，旧 13/15 报告保持原状态。

## 截图统计修复（报告版本 15）

官方模型定向补测 `20260916133656-90633984` 中，原生材料独立记录启动一次、正确提交一次；实际窗口截图返回 `SetIsBorderRequired 0x80004002`。旧解析器把 `include_screenshot:false` 辅助功能读取和通用图片转发分支误计为成功截图，自动生成的 2/2 不作为通过依据；相邻 `targeted-reviewed-report.json` 保留 1/2、截图上游阻断的真实执行结论，`targeted-accepted-report.json` 单独记录用户接受该已确认上游阻断的本次验收决定。版本 15 只识别实际截图 API，排除禁用截图的读取与图片转发分支；不改变官方截图组件，不重写历史报告。
