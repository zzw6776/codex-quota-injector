# WSL 开发启动：主中继标记未转发

2026-09-16 在官方桌面 `26.908.40834`、实际官方 Linux CLI `0.154.0-alpha.6.2` 上确认。项目修复版本 `0.1.279`，中继启动协议 `81`。

## 根因与证据

Windows 桥接设置 `CODEX_QUOTA_PRIMARY_APP_SERVER=1`，却没有将该变量加入 `WSLENV`。官方桌面构造 WSL 环境时合并已有转发声明并补充官方变量，不会自动转发项目自定义变量。专用 ELF 入口可自行识别 WSL Relay 角色，但它无法替代主中继所有权标记。

现场 WSL Relay PID 为 `6857`，其初始环境没有主标记；Windows 状态文件仍保留此前 Windows Relay PID `26332`，且没有 Linux `bootId`、`processStartTicks`。`shouldPublishHostState` 在缺标记时返回 false，因此真实 WSL Relay不认领或更新桌面状态。

Windows 就绪检查在 WSL 查询 `/proc/26332/stat`，返回 1，最终报告“WSL 进程查询失败：1”。同一查询脚本改用真实 WSL Relay PID 返回 0。Windows 环境中仅设置主标记、未声明转发时 WSL 读取为 unset；声明转发后读取为 1。两种进程查询均出现相同的 fstab 警告，所以该警告不是本次退出码 1 的根因。

脱敏现场证据保存在 `.runtime/wsl-startup-investigation/result.json`，不包含账号凭据。

## 修复与验收

仅 WSL 启动链将主标记以 `/u`（Windows 到 WSL）合并进 `WSLENV`，保留其他变量及路径标志，并替换同名旧声明。Windows PE、macOS 启动链不增加此声明。主标记仍由 Relay 在创建官方上游前清除，辅助进程继续隔离；不改变状态文件结构。

`test/wsl-relay-launch.test.mjs` 覆盖声明合并、旧方向标志、原生 ELF 状态认领、真实 PID 就绪检查、辅助 RPC 往返与退出后主状态保持，以及同版本官方 app-server 无 Relay/Relay 初始化对照。原生验收需显式指定当前源码构建的 ELF 和官方 CLI：

```powershell
$env:CODEX_TEST_WSL_RELAY_EXECUTABLE = '/mnt/d/code/codex-quota-injector/build/codex-quota-relay-wsl-0.1.279'
$env:CODEX_TEST_WSL_OFFICIAL_CLI = '<已确认的官方 Linux CLI 具体路径>'
node --test test/wsl-relay-launch.test.mjs
```

依赖、SEA 准备和产物均在隔离的 Linux 工程内由 Linux 工具链完成；通过后可以复制到共享 build 目录。本次验收使用临时 HOME、临时配置和空自定义供应商，不发送模型请求、不重启日常桌面。该启动契约需要下一次真实桌面启动才能生效，隔离验收通过不等同于当前桌面已经加载修复。
