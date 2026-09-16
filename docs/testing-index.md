# 测试总索引

本页统一列出测试组件、平台原生环境、执行入口与结果来源。详细业务场景见[69项场景索引](testing-scenarios.json)和[兼容性场景矩阵](codex-compatibility-test-plan.md)；具体执行边界见[测试说明](testing.md)与[桌面验收说明](testing-desktop-host.md)。

## 总览：6个组件 × 3套运行环境

测试按类型和模型分为6个固定组件，每个组件还必须区分以下3套运行环境，共18个验收位置。这里统计的是覆盖位置，不是自动化用例数或独立启动命令数。macOS是独立平台；Windows原生与WSL原生是Windows平台内的两套环境。WSL桌面组件使用Windows上的同一个Codex桌面宿主，后台CLI、app-server、Relay、依赖与历史数据链绑定WSL。

| 测试组件 | macOS原生 `macos-native` | Windows原生 `windows-native` | WSL原生 `wsl-native` |
| --- | --- | --- | --- |
| 免费回归 - 模拟模型 | 公共组件 + macOS原生Relay | 公共组件 + Windows原生Relay | 同宿主公共组件 + WSL原生Relay |
| 后台功能测试 - Codex 官方模型 | 官方后台 / macOS原生 | 官方后台 / Windows原生 | 官方后台 / WSL原生 |
| 后台功能测试 - DeepSeek Flash | DeepSeek后台 / macOS原生 | DeepSeek后台 / Windows原生 | DeepSeek后台 / WSL原生 |
| 桌面集成测试 - Codex 官方模型 | 官方桌面 / macOS原生 | 官方桌面 / Windows原生 | 官方桌面 / WSL原生 |
| 桌面集成测试 - DeepSeek Flash | DeepSeek桌面 / macOS原生 | DeepSeek桌面 / Windows原生 | DeepSeek桌面 / WSL原生 |
| 启停恢复测试 - Codex 官方模型 | macOS正式包启停恢复 | Windows正式包原生阶段 | 同一Windows正式包测试的WSL阶段 |

支持的宿主架构为macOS arm64/x64和Windows x64（含WSL）。报告还必须记录实际架构；另一架构、平台或环境的通过结论不能继承。没有对应工具链、凭据或材料时记录未执行或阻断及原因，不能因为索引列有该位置就宣称已通过。发布版本变化不等于该环境全部未测试，按下节的执行输入证据复用。

按执行授权仍分为免费回归、真实模型测试、启停恢复3类；按测试类型为免费回归、后台功能、桌面集成、启停恢复4种。6个组件、18个环境验收位置和69项业务场景是不同层级，不能混算。

## 修改后测什么：按实际影响复用

原来的全仓摘要包含所有源码、用例、部分文档和三处发布版本；后台/桌面直接比较它，导致无关修改也把报告视为过期。现在原始摘要只保留追溯与WSL复制完整性，行为有效性使用分组件、分环境的输入摘要。`package.json`、锁文件顶层和锁文件根包的发布版本被排除，依赖包版本与其他配置仍纳入。文档不影响执行输入；机器可读场景/协议索引仍影响免费回归。

| 修改范围 | 需要验证的范围 | 保留的行为结果 |
| --- | --- | --- |
| 仅说明文档或发布版本号 | 文档引用/版本一致性；正式发布时检查新包 | 全部未受影响的行为结果，不重跑真实模型或启停恢复 |
| Widget页面模块、桌面验收提示/判据 | 对应免费契约或页面/桌面验收 | 模型后台和启停编排结果；页面变化另做新包检查 |
| 独立免费用例或材料 | 对应免费用例/环境；完整免费执行时发现新增用例 | 未改变的模型后台、桌面与启停结果 |
| 后台模型验收材料 | 相应后台组件/阶段及材料契约 | 未改变的桌面与启停编排结果；共享供应商配置另含桌面 |
| 启停编排、安装材料 | 相应免费契约及启停/安装验收 | 未改变的模型后台与桌面行为结果 |
| Router、依赖、共享真实模型材料、正式原生Relay构建或未细分的新模块 | 保守列出受影响组件，读代码后可进一步缩小用例范围 | 经证据确认未受影响的环境/组件 |
| 官方CLI、Node、浏览器等运行时升级 | 对应环境和能力的运行时验收 | 其他独立环境结果；不把跨环境结果继承 |

执行输入分类由 `scripts/test-impact.mjs` 定义，不根据模型名称猜测代码影响；Windows/WSL共享宿主路径保守覆盖两套环境，macOS专用实现独立判定。当前自动判定粒度是组件与环境，组件内部需要结合真实变更选择阶段或定向用例。未知执行输入保守纳入相关范围，不凭主观“看起来没影响”放行。

查看影响计划：`npm run test:impact -- --base=<Git提交>`，默认与HEAD比较并包含未提交及未跟踪文件；也可用 `npm run test:impact -- --baseline=<测试报告路径>` 比较报告保存的输入清单。只输出变更、受影响/不受影响的18个位置与独立包检查要求，不执行测试、不发送模型请求、不重启。计划不代表这些位置已经有通过证据。

新报告保留每个输入文件的摘要、组件/环境摘要、实际运行时与原始发布版本。结果有效性另列 `reusable`（可复用）、`needs-retest`（对应输入改变）和 `review-required`（证据不足需审核），不覆盖原始 `passed`、`failed`、`blocked-upstream` 等执行结果。旧报告没有输入清单时先审核真实变更，不自动要求全量重跑，不将旧失败自动转为通过。

桌面仍检查Widget运行时版本、Relay协议、实际环境与宿主就绪。只有全部生产源码与运行依赖输入一致，才允许继续使用后台测试原发布版本的已加载桌面；不能仅因组件摘要相同就接受尚未加载的生产修改。新正式包仍须核对本次发布版本、构建和资源，包验证与完整启停恢复是不同要求。

## 免费回归：公共部分与原生部分

| 内部组件ID | 所属宿主/环境 | 执行关系 |
| --- | --- | --- |
| `free-common` | 当前macOS或Windows桌面宿主 | 每次免费回归调度只运行一次，结果绑定本次宿主和源码 |
| `free-macos-native-relay` | macOS原生 | macOS完整免费回归必测 |
| `free-windows-native-relay` | Windows原生 | Windows完整免费回归必测 |
| `free-wsl-native-relay` | WSL原生 | Windows完整免费回归必测；Linux工具链与依赖独立准备 |

在相应宿主执行 `npm run test:offline`：macOS覆盖公共与macOS原生部分；Windows覆盖公共、Windows原生与WSL原生部分。Windows和WSL共用的公共结果只计一次，不复制成两份测试数。当前桌面环境状态和Windows全部支持环境状态分别报告。

开发定位可用 `npm run test:offline -- --runtime=macos-native|windows-native|wsl-native`，其中竖线表示选择一个值；也支持 `current`。指定环境只覆盖公共部分及选中的原生部分，不能替代Windows完整免费回归。

免费报告已取消作为其他测试的前置门禁。缺失、失败或过期的免费报告不会阻断真实模型或启停恢复测试，也不会自动触发免费回归重跑。免费回归仍只在用户明确要求的范围内执行。

## 真实模型：12个独立环境组件

下表每行都分别有macOS原生、Windows原生、WSL原生3份验收结果，共12个独立环境组件。`<runtime>`为上述三个具体环境之一；不能使用 `all` 执行付费测试。

| 测试组件 | 内部组件ID | 执行入口 |
| --- | --- | --- |
| 后台功能测试 - Codex 官方模型 | `model-official-backend/<runtime>` | `npm run test:live:official -- --runtime=<runtime> --confirm-token-use` |
| 后台功能测试 - DeepSeek Flash | `model-deepseek-backend/<runtime>` | `npm run test:live:deepseek -- --runtime=<runtime> --confirm-token-use` |
| 桌面集成测试 - Codex 官方模型 | `model-official-desktop/<runtime>` | `npm run test:desktop -- --profile=official --runtime=<runtime> --confirm-token-use` |
| 桌面集成测试 - DeepSeek Flash | `model-deepseek-desktop/<runtime>` | `npm run test:desktop -- --profile=deepseek --runtime=<runtime> --confirm-token-use` |

查看计划时把 `--confirm-token-use` 换成 `--plan`，不发送模型请求。默认环境为当前桌面配置；显式选择只能选择本平台环境。后台可独立准备对应环境，桌面验收还必须与当前桌面配置一致；真实模型执行器不会自动切换桌面运行方式。用户要求某模型/环境测试后按该范围执行，不因总索引列出其他环境而扩大付费范围。

每个后台组件包含 `tools`、`history`、`compaction`、`callbacks` 四个阶段；定向执行支持 `--stage=<阶段>`，结果只能代表所测阶段。每个桌面组件验证真实模型、源码与运行版本、functions.exec成功/失败续接、四个codex_app只读入口、web.run和computer use。具体适用项总数从本轮报告读取；DeepSeek没有独立可调用web.run时，对应三项明确记为不适用并排除。

只有同一平台、架构、环境和供应商的后台与桌面均通过，且各自受测输入对当前变更仍有效，才能给出该模型在该环境的完整通过结论。原始执行版本可以不同，但必须保存组件输入等价的复用依据。只完成后台时整体验收仍不完整；定向补测只能更新明确覆盖的项，不能把未验证的影响范围标绿。

## 启停恢复：2个宿主调度，3套环境覆盖

| 调度宿主 | 计划入口 | 执行入口 | 必须覆盖的环境 |
| --- | --- | --- | --- |
| macOS | `npm run test:lifecycle -- --plan` | `npm run test:lifecycle -- --confirm-restart` | macOS原生 |
| Windows | `npm run test:lifecycle -- --plan` | `npm run test:lifecycle -- --confirm-restart` | 自动依次验证Windows原生与WSL原生，再恢复原运行设置 |

启停恢复不接受 `--runtime=`，不能把Windows和WSL写成两个独立的付费启动命令。Windows一次调度包含正式包公共部分、两套原生环境及切换/恢复检查，各部分单独保留结果；仅一套通过不能判整个Windows启停恢复通过。Windows执行还要求已准备并验证的正式安装包，可通过 `--installer=<路径>` 指定，具体前置条件以计划为准。

该类必须最后执行并取得本次明确重启授权，包括会话安全、正式包、单实例、重连、账号往返与计划披露的官方模型冒烟。普通安全重启不等于完整启停恢复验收。

## 结果总表与证据来源

每次汇总必须使用上述6行 × 3列，逐格记录“实际通过数/适用总数、状态、失败或阻断原因、报告链接”。另列源码摘要/项目版本、平台、架构、实际运行环境、运行时版本与实际模型。不支持数量单列；未执行与上游阻断不能隐藏。公共用例数、后台用例数、桌面验收项数和启停恢复步骤数分别统计。

本页是完整覆盖索引，不将历史报告固定写成当前通过状态。每个位置先查实际结果再判输入有效性；没有任何证据才标未执行，有旧结果时列原始执行版本以及可复用/需局部重测/待审核，不因版本号不同一律标未执行。其他环境报告不能代替本环境结果。用户接受已确认上游阻断的验收决定另列，保留原始执行状态和计数。

| 结果来源 | 环境绑定与读取方式 |
| --- | --- |
| `.runtime/test-results/offline.json` | 用 `platform`、`arch`、源码摘要和 `components` 区分公共与原生部分；同一路径会被后续批次覆盖，历史汇总应保留副本 |
| `.runtime/test-results/live-<profile>-<runtime>[-<stage>].json` | `profile`为 `official` 或 `deepseek`；分别读取 `backendStatus`、后台计数及绑定的桌面报告，不能把顶层模型整体验收状态当后台结果 |
| `.runtime/test-results/desktop-host/<run-id>/report.json` | 根据 `profile`、`runtimeTarget`、源码摘要和实际模型绑定总表位置；读取适用项计数、逐项状态与不适用数量 |
| `.runtime/test-results/lifecycle/<run-id>/report.json` | 按宿主、正式包与源码绑定；Windows分别读取原生、WSL与公共/恢复部分，macOS读取本机步骤证据 |

Apps、语音、媒体生成、自动化和远程宿主等条件能力归入所使用模型及环境的桌面组件，另列配置条件与真实状态，不增为第7种固定组件，也不能因固定链通过而全部标绿。具体条件见[桌面能力说明](testing-desktop-host.md#报告与其他桌面能力)。`npm test`、覆盖率测试和单文件定向测试是开发验证入口，属于固定组件的证据或子集，不另算完整环境验收。
