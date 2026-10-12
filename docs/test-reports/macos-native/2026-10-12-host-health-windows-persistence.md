# Windows 工具状态原子替换失败修复

- 日期：2026-10-12；源码应用 0.1.320 / Widget 194 / Relay 97。
- 原始失败：[Build Packages 38234570331](https://github.com/zzw6776/codex-quota-injector/actions/runs/38234570331)，提交 `8a80d8c6f31c719dfb1a64c3d55383c12fe392a9`，应用 0.1.319。
- Windows 契约测试原始结果：628 通过、1 失败、8 跳过。Ubuntu、macOS 测试 Job 成功；后续打包与发布 skipped。本轮不将旧失败改为通过。

## 失效机制与修复

Windows 日志中 `HostHealthTracker.persist` 的临时文件 rename 返回 EPERM；原实现清理临时文件并记录错误，直接丢弃该状态快照。双实例请求定向用例的第二个后台最后一次工具就绪状态未落盘，没有后续事件补发，等待 toolsVerified 超时。具体外部占用来源未确认。

Windows 的 EPERM、EACCES、EBUSY 最多重试四次，等待分别为 25/50/100/200ms；复用同一临时文件并保留原子替换，其他错误和平台不重试。等待后重新读取所属会话，接管或文件删除时终止旧写入，包括首次登记时的接管。失败保留旧文件，清理临时文件并记录诊断；后续状态更新仍可继续写入。持久化字段、Relay 协议和页面行为未改变，因此仅升级应用发布版本。

## 定向验证

- macOS 原生 arm64，Node v22.23.1，与 CI 的 Node 版本相同。
- 修复前的确定性用例 0/1：注入终态 rename EPERM 后，落盘 toolsVerified 仍为 false，确认真实丢更新机制。
- 修复后执行 `node --test --test-concurrency=1 test/host-health-persistence.test.mjs test/host-health.test.mjs test/host-health-instances.test.mjs`：30/30，通过，0 失败、0 跳过。
- 新增六项覆盖：连续三类临时错误后终态落盘、状态重试期间接管、首次登记重试期间接管、持续失败有限结束且后续更新可恢复、非临时错误不重试、非 Windows 不重试；核对临时文件清理与诊断。
- 错误注入仍使用真实临时文件和成功路径 rename；这是 macOS 上的 Windows 错误分支验证，不能替代 Windows 原生通过。新提交自动构建的 Windows 结果待确认，不轮询或 watch CI。
- 没有完整免费回归、模型请求、桌面或启停测试；没有安装或重启日常应用。后台新逻辑待下次启动加载。

原始日志和执行输入清单保存在 `.runtime/ci-fix-20261012/`，不上传私有材料。

| 材料 | SHA-256 |
| --- | --- |
| 输入清单 | `3eae73384e904e6fec7581da4ffeb16facc84c4c2109ace2ee539d083d63786d` |
| 原始 CI 失败日志 | `7b97411233d05b04b446018153c5695bf8347d04423a5516c335a27382913110` |
| 修复前用例失败 | `ec82a1c32781e4406dc86f2e43ae21d06823095a68a8ed8be43d54812ddf55bf` |
| 修复后定向结果 | `0e9b42507f308dee2e50d8601f1432256eded573c5b873dcb923bbe871536fd2` |
