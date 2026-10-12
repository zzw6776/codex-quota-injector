# macOS arm64 DMG 预览包构建与镜像检查

- 执行日期：2026-09-22；macOS 27.0，arm64。构建宿主 Node v26.7.0，应用内嵌官方 Node 22.23.1 arm64；下载归档通过官方 `SHASUMS256.txt` 校验。
- 源码：Git HEAD `26b9fd1` 加本地未提交的 DMG 快捷方式修复；应用版本 0.1.294。`scripts/package-macos-dmg.mjs` SHA-256：`8e3877dc5d070d9742fb2a6a557093b367cc2446a390cf7c01c9201bad41f09d`；`scripts/package-macos.mjs`：`50dd318c7017ad8cd81e7c1f67fdb5ee52bdc4dd532516e1d551758a248c3fb9`；`scripts/build-sea.mjs`：`0150381bdfa98b7bcd16eecd603bd6d91c0634605c2e28c868c`；`package.json`：`4d69c406255695ff187583d5c977881241d4486a347cf05ec379239360dcf949`。
- 产物：`release/macos-arm64-preview-20260922/Codex-Quota-Injector-0.1.294-macos-arm64.dmg`，41 MiB，SHA-256：`5fd5391e816476783fe31eb86f9d2d858ebbf07b3d75ef68203e90c990d1d267`。本地路径仅用于定位，不是已上传的下载链接。
- 原始终端输出未另存文件，文件 SHA-256 无；包文件和构建输入仍在本机。

执行项目 `build:sea` 与 `package:macos` 正式入口，镜像创建与 `hdiutil verify` 成功。随后只读挂载实际预览包，镜像根目录同时包含 `Codex Quota Injector.app` 和 `Applications -> /Applications`。挂载后的应用 `CFBundleShortVersionString` 为 0.1.294；启动器、Worker、Shim 均为 arm64；`AppIcon.icns`、`NODE_LICENSE.txt` 存在；`codesign --verify --deep --strict` 通过。检查后已卸载镜像。

构建使用 ad-hoc 签名，未做 Developer ID 公证。未安装或启动应用，未执行启停恢复及模型测试；x64 包未构建。本包为本机预览产物，未上传 Release。
