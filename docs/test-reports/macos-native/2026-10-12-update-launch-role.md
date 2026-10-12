# macOS 更新身份污染正式启动入口

- 环境：2026-10-12，macOS arm64，Node v22.23.1。
- 修改：应用源码 0.1.321；Widget、Relay 协议没有变化。
- 范围：更新后启动与正式 GUI 重开入口的定向原生验证；没有完整免费回归、真实模型请求、正式安装或日常启停测试。

## 根因与证据

macOS `launchUpdatedApp` 从更新 Worker 调用 `/usr/bin/open`，没有设置清理后的环境。原生对照证明 `open` 会将调用进程的 `CODEX_QUOTA_ROLE=app-updater` 与 `CODEX_QUOTA_UPDATE_CONTROL` 传给启动外壳；旧 Swift 外壳再直接继承环境创建 `--explicit-start` Worker。`src/launcher.mjs` 的 updater 分支优先于 explicit-start，因此 Worker 进入 `runAppUpdater`，而非正常应用启动。

每次 `runAppUpdater` 都从控制文件重新创建 confirm 状态，不恢复原更新的执行状态。重复进入会使用同一个控制文件、同一个任务 ID，再启动确认页并覆盖登记。只存在一个下载控制目录并不能证明只启动过一个更新进程，也不能把原任务最后成功解释成截图时的重复窗口正常。

使用已安装 0.1.320 的真实 Swift 启动外壳复制到独立临时应用，替换 Worker 为仅记录指定环境的夹具：更新身份随第一次 `open` 进入；随后由干净调用者手动重开同一应用，第二个 Worker 仍继承同一 updater 身份及旧控制文件路径。`before-native.json` 的 `samePollution` 为 true。复现没有加载生产 Worker、下载或访问任务历史。

日常更新记录 `update-H0FN49` 为 0.1.312 → 0.1.320，最终 status 为 success；当前正式实例 PID 57893、版本 0.1.320、phase ready。该最终结果与上述中间重复确认问题可以同时存在。历史污染进程已结束，不能追溯读取其当时环境；归因依据是具体启动代码、同平台旧外壳的原生复现及同控制文件重复初始化机制。

## 修复

1. macOS 更新启动 `open` 与 Windows 一样，使用 `cleanUpdateEnvironment`，不传递 updater、Relay、动态工具等内部身份；数据目录与 CDP 端口通过已有 `--env` 参数保留。
2. Swift GUI 入口每次创建 Worker 时移除继承的 `CODEX_QUOTA_ROLE` 和 `CODEX_QUOTA_UPDATE_CONTROL`。即使外壳被污染，初次启动与手动重开都创建正常应用 Worker。其余环境及 `--explicit-start` 参数保留。

源头清理防止新外壳污染；GUI 入口负责保证自身 Worker 的身份。没有修改独立更新 Worker 的启动入口或成功后保留窗口的要求。

## 验证结果

| 材料 | 原始结果 | 覆盖 |
| --- | --- | --- |
| `before-native.json` | 缺陷已复现 | 旧正式外壳首次继承更新身份，干净调用者手动重开仍继承旧身份 |
| `native-after.tap` | 2/2，passed | 真实 `launchUpdatedApp` / `open` 环境清理；从修改后的 Swift 源码编译真实外壳，污染环境首次打开及同一外壳手动重开均清除更新身份，保留参数、数据目录与端口 |
| `contracts.tap` | 24/24，passed | 更新状态、取消、窗口、候选检查等已有契约回归 |

原生应用、Worker 夹具及端口均隔离。没有重启、接管或替换日常注入器，结束后无测试原生进程残留；日常 PID 57893 保持不变。正式应用仍为 0.1.320，本轮修复涉及编译的 Swift 启动外壳，不能热加载，需新正式包生效。未打包、提交或推送本轮修改。Windows/WSL 启动分支未改变，不将本机原生结果算作其新验收。

原始材料位于 `.runtime/update-role-20261012/`，输入清单包含修复源码、相关调度源码、用例与旧外壳二进制摘要。

| 材料 | SHA-256 |
| --- | --- |
| 输入清单 | `0273b2d3eabe21ba378dd3a734b972fd0c8490f2136e7b10086146df559cda07` |
| 旧外壳复现 | `28b9f40112826f9f1a403d57ef57310cff17c308e2b769ad535d80f493c9fac5` |
| 原生修复验证 | `cae5d1e81bda91513dc101849e2fcf86479fedac42e98e52c7fd887be5610db1` |
| 更新契约 | `61bca1ffcf7635e9db8ba0bb8a6f7815c35e7853c8de63864d577b299c235c01` |
