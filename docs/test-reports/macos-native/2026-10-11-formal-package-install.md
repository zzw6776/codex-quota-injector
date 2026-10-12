# 0.1.307 正式包构建与应用文件替换

- 日期：2026-10-11（America/Los_Angeles）；macOS arm64。
- 用户授权：打包正式版并替换应用程序中的正式版本。执行范围为文件替换，没有启动、关闭或接管日常进程。
- 版本：应用 0.1.307 / Widget 189 / Relay 96。
- 结果：passed；正式构建、镜像只读挂载核验及已安装包核验均通过。

## 构建与安装证据

- 使用官方 Node 22.23.1 arm64 生成 SEA Worker，编译生产 Swift launcher/shim，构建 DMG。复用当前源码定向测试结果，没有重跑完整测试、真实模型或启停恢复。
- 构建前记录 216 个源码、构建脚本、资源和包配置文件的 SHA-256，安装前再次核对输入未变化。
- DMG 校验及只读挂载通过；镜像包含 `Applications -> /Applications`、图标和 Node 许可证。
- 候选包、镜像中的包和已安装包均为 0.1.307；三个可执行文件均为 arm64，`codesign --verify --deep --strict` 通过（ad-hoc 签名）。
- 在应用程序目录暂存并验签候选包，再替换目标应用；没有备份旧安装或调度回滚。
- 已安装 launcher、Worker、shim 的 SHA-256 均与候选构建相同。
- 替换前后桌面、app-server 及注入器 PID 相同；注入器为 `dev / 0.1.307 / ready`。这代表用户已经启动开发版，不代表本轮启动了正式应用。
- 本次是构建和安装文件核验，不计为正式版运行时或完整启停恢复验收。

| 产物 | SHA-256 |
| --- | --- |
| DMG（42,601,919 字节） | `1aa871642f3dbf667f022de152303dabf77c4691f51a9e2d9af87676aef93d0f` |
| Launcher | `d0a72105e55e365c73dbd7a2575871364d901d0004f990277848e66e8b2c1fe0` |
| Worker | `6bbf46f530d5170f100a604cae4d423de570de0fddcbf7b9dc756981b06e9391` |
| Shim | `8c1fd9dda345e25fc0169027cb610b8d442df930181129d056655a6e69c87eef` |
| 原始报告 | `994aa6a732aa1830cd181ec9a17c5e4ff99af9933179da81f8f59aa0507ee63a` |

DMG：`release/macos-arm64-0.1.307/Codex-Quota-Injector-0.1.307-macos-arm64.dmg`。

原始私有材料：`.runtime/deployments/20261011-0.1.307-files-only/`，包括输入清单、候选包和最终 `report.json`。没有上传 GitHub Release。
