# CI 测试日志与超时保护定向验证

- 源码版本：0.1.287；仅 CI 测试输出和时限变化，Widget 174、Relay 87 不变。
- 执行环境：macOS arm64，Node 22.23.1。零模型请求、零重启；不运行完整免费或业务回归，不改本地安装。
- 旧运行 `35344524524` 已按授权取消，GitHub 终态为 `cancelled`；其失败不被新日志改动标记为通过。

## 已取得的旧日志

取消后取得 Windows 完整日志。首个失败位于 `test/lifecycle-progress.test.mjs` 的“报告更新后渲染器刷新页面，停止前写入最终状态”：`writeLifecycleReport` 替换 `report.json` 时返回 EPERM。失败发生在用例调用 `renderer.stop()` 之前，随后持续读取已经清理的临时目录并输出 ENOENT，测试进程不退出。这不是 DMG 打包耗时。

本轮按请求添加日志和超时保护，不修改报告文件替换逻辑；EPERM 的具体 Windows 文件占用来源尚未确定，不能宣称该失败本身已修复。

## 改动与结果

- 新 CI reporter 输出带 UTC 时间的文件/用例 START、PASS/FAIL、耗时、错误详情、标准输出/错误及汇总；开始事件不等用例结束后才输出。
- 同一 reporter 同时写 Actions 控制台与 `ci-contract-tests.log`；各平台通过 `always()` 步骤归档 7 天，不用管道覆盖 Node 失败退出码。
- Node 测试超时 120 秒；测试步骤上限 8 分钟，整个测试 job 上限 15 分钟。测试集合及单并发设置不变。
- 定向验证最终 2/2 通过：事件输出契约；真实子进程中“用例完成但定时器未清理”的场景由 Node 自身超时终止，输出对应文件、超时错误并非零退出。CI 的双输出参数实际执行同两项测试也为 2/2，不重复计数。
- 首次新增测试为 1/2：嵌套 Node 测试继承了 `NODE_TEST_CONTEXT`，没有作为独立测试运行。夹具显式清除该变量后按独立子进程验证通过；保留这项初始夹具失败说明。
- Workflow YAML 解析与 `git diff --check` 通过。Windows/Linux 的新执行结果以新 CI 为准，不以本机结果代替。

私有材料：`.runtime/ci-logging-20260918-Mzz84L/`。最终双输出日志 SHA-256：`acd1c6978e9ba6e3d2010a10467adf14d0ab9eba5e3c6a15b3eed088e3eedaf5`；旧 Windows 日志 SHA-256：`c1b361b2c78df6c8002fa523993eb81117295a4e7133e74118513a8631840abf`。

## 0.1.288：新增夹具的 Windows reporter 路径修复

运行 `35346111149` 的 Windows 测试约 71 秒完成：557 项中 553 通过、1 失败、3 跳过；Ubuntu/macOS 通过。唯一失败为本轮新增的超时子进程验证，实际退出码 7，而非预期超时失败码 1；原进度页用例这次通过，不把旧 EPERM 当成本次失败。

夹具把 `resolve()` 得到的 Windows `D:\\...` 路径直接作为 `--test-reporter`，而 Node 22.23.1 的内置实现把该参数传给 ESM import。带盘符的字符串被识别为 `d:` URL 协议；同版本 ESM 对照返回 `ERR_UNSUPPORTED_ESM_URL_SCHEME`。修复使用 `pathToFileURL(...).href`，保留严格退出码及超时错误检查，并在意外退出时打印子进程 stderr/stdout。远端旧日志未记录子进程 stderr，因此协议错误归因由代码及同版本加载器对照支持，Windows 实际恢复由新 CI 独立确认。

修复后 macOS arm64 / Node 22.23.1 定向 2/2 通过，`git diff --check` 通过。只改变测试夹具与发布版本，不重跑未受影响业务/打包测试、不安装或重启。修复后日志 SHA-256：`47d655dbe7f1f8572998d07cd86d34525e494539d43ac446aa4c58f1192d39af`；本次远端失败日志 SHA-256：`0c6ea22ba4fc3b175df9cef1a8ce45a851923a6a712aedf1f70a949a9f7120d0`。
