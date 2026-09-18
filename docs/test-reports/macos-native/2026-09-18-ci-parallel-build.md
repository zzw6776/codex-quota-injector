# CI 平台并行构建定向核验

- 源码版本：0.1.289；只调整 GitHub Actions 任务拆分，Widget 174、Relay 87 不变。
- 本机只做配置定向核验；零模型请求、零安装、零重启，不运行完整业务回归。

## 调度与产物契约

测试矩阵通过后，macOS DMG、Windows 原生二进制、WSL Relay 三个构建分支并行调度。Windows Setup 仅等待 Windows 二进制和 WSL Relay；Release 等待 macOS DMG 和 Windows Setup。Windows 构建、打包均不依赖 macOS。

Windows 编译任务上传后台 EXE、专用 Windows Relay EXE 和 Node LICENSE，统一从 `build/native` 传递。独立打包任务把两份中间产物下载到该目录；许可证参数改为传递后的 `build/native/NODE_LICENSE.txt`。中间产物名不匹配 Release 的 `codex-quota-injector-*` 下载规则，保留一天；最终包的上传和发布契约不变。

## 已核验与边界

- Ruby YAML 解析通过；依赖断言确认三个构建分支都只依赖测试，Windows Setup 汇合两个构建，Release 依赖两类最终包。
- 与 HEAD 配置逐项比对：原 Windows 下载/编译命令、NSIS 安装、安装/重装/卸载及专用 Relay 验证、最终包上传均保持原内容；打包命令仅改变许可证路径。测试、macOS、WSL、Release 任务保持原内容。
- Windows 中间产物文件清单、上传/下载名称和目标目录断言通过；应用与 lock 两处版本一致；`git diff --check` 通过。
- 未在本机执行 Windows 原生构建，不把配置核验计入业务测试通过数。实际并行调度、产物下载与安装验证以新 CI 为准。增加一个 Windows runner 和一次产物传递会有开销，不预先承诺总耗时缩短。
