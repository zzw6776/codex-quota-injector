# Turn-state 长度显示与 macOS arm64 安装包

- 日期：2026-09-23；macOS 27.0 / arm64；构建宿主 Node 26.7.0，打包 Node 22.23.1 arm64。
- 源码：HEAD `26b9fd1` 加本地未提交改动；应用 0.1.300 / Widget 183 / Relay 94 / Token 缓存 26。
- 范围：删除 `x-codex-turn-state` 长度与 292 的比较，以及事件、缓存和页面中的比较字段；保留实际长度、模型与观察时间。旧缓存 25 的长度可迁移到结构 26。

## 定向验证

| 范围 | 最终结果 |
| --- | --- |
| Router 采集与 HTTP/WebSocket、Token 用量、Widget 会话和显示 | 37/37 通过 |
| 缓存与运行时契约 | 31/31 通过 |
| Chrome 154 原生浏览器：780、292、未观察状态及无比较样式 | 1/1 通过；截图 `.runtime/test-results/browser-f5b376dba35c.png` |
| `git diff --check`、应用版本三处一致 | 通过 |

浏览器用例第一次执行因测试代码把 `aria-label` 当成 DOM 属性读取而失败；改用 `getAttribute` 后最终用例通过，产品代码未因此变更。两批单元测试和浏览器用例共 69 个最终通过；未运行完整免费回归、真实模型或启停恢复。

## 安装包

文件：`release/macos-arm64-0.1.300/Codex-Quota-Injector-0.1.300-macos-arm64.dmg`。

- 大小：42,601,622 字节；SHA-256：`bb0d464b8a1b43ac5ae9c0140f307fe85ca163c11ef660bd41f53d2df56920a2`。
- `hdiutil verify` 通过；只读挂载后应用版本为 0.1.300，三份可执行文件均为 arm64，Worker 哈希与本轮 SEA 构建一致。
- 镜像包含 `Applications -> /Applications`、图标和 Node 许可证；`codesign --verify --deep --strict` 通过（ad-hoc 签名），检查后已卸载。
- 构建输入 214 个文件保持不变；清单与包核验原始结果在 `.runtime/package-0.1.300-macos-arm64/`。构建保留既有 `import.meta`/CJS 警告，构建与镜像校验成功。
- 未安装或启动新包；当前日常进程的版本与新包版本分开判断。
