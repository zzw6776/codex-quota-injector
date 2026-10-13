# AI 发布日志与 CI 强制校验

- 日期：2026-10-12；应用源码 0.1.323，macOS arm64，Node v26.7.0。
- 范围：免费回归 - 模拟模型 / macos-native 的发布流程定向契约子集。执行工作流中的实际内联校验及发布命令；GitHub 命令由本地函数替代，零真实发布请求。

## 改动

AGENTS.md 约束 AI 在准备提交或发布时，根据最近已发布版本以来的实际改动编写中文版本说明。本次说明为 `docs/releases/0.1.323.md`，包含此前未发布的确认页日志展示和当前发布流程改进。

CI 新增独立校验任务，检查当前版本对应文件、版本标题和非空中文条目；macOS、Windows 可执行文件及 WSL Relay 构建均依赖校验成功。新建 Release 使用 `--notes-file`；重跑已有 Release 时同步更新正文，不再使用 `--generate-notes`。

## 验证

- 最终定向契约 5/5，通过：当前版本正文、CRLF、缺失/空白/错误版本/无中文条目拒绝、新建和重跑正文原样发布、错误标签在 GitHub 写入前停止。
- YAML 解析通过；三个原始构建任务均明确依赖 `release-notes`，Windows 安装包和 Release 发布通过既有依赖链继承门禁。
- 版本与锁文件两处版本一致，`git diff --check` 通过。
- 保留首次 2/5 和第二次 4/5 的原始失败。原因分别为测试夹具提取发布命令时误截断空行，以及漏传 `GITHUB_REF_NAME`；修正夹具后通过，不归因为生产发布流程错误。

Windows 主机上跳过模拟 Ubuntu Bash 发布的三项；Node 内联校验的两项仍执行。未执行远端 GitHub Actions、CI 固定 Node 22.23.1 或 Windows/WSL 原生复测，本机结果不代替这些环境证据。

此前确认页日志展示的生产模块和浏览器测试输入未改变，保留原 0.1.322 的 25/25 契约和 2/2 浏览器结果，不重复验证。版本号变化不等于源码已在日常应用加载；本次未打包、安装、重启、提交、推送或发布。

私有材料：`.runtime/release-notes-ci-20261012/` 保存最终及两次初始契约输出、源码输入清单。

| 材料 | SHA-256 |
| --- | --- |
| inputs.json | `cacdd2529bb2689951747dc7de431f65b42e5a5ab1f996847dd04a50ac8e8248` |
| contracts-first.tap | `507a83e6495a75163ade0ef6f2f2b003ccfc771bd5de067fc8ed8882620d880c` |
| contracts-second.tap | `93fbd4c85d7a0a893489827178981ebe24365dc4d39d23a54e5b1bdfb1c2759a` |
| contracts.tap | `75f4fc24692deb45121e95d5648bc6a1fe7e2bba4bdafc3f53bbe236752dbd8a` |
