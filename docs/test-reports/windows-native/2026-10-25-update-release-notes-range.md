# 跨版本更新日志 CI 修复

## 范围

- 日期：2026-10-25 15:05（Asia/Shanghai）
- 版本：`0.1.331`
- 环境：Windows x64，Node.js `v22.23.2`
- 类型：GitHub Release 聚合、更新确认页及 CI 非 UI 合约验证
- 边界：未构建或安装正式包，未重启应用，未发送真实模型请求

## 原始失败

GitHub Actions 运行 [`40166936821`](https://github.com/zzw6776/codex-quota-injector/actions/runs/40166936821) 在 Windows、macOS 和 Ubuntu 的 `Run non-UI contract tests` 阶段全部失败，后续 Windows、WSL、macOS 构建及 Release 发布被跳过。

Windows 本机定向复现为 **28/29 通过、1 失败**。失败断言要求单个无正文 Release 的候选 `releaseNotes` 保持空字符串；初版聚合逻辑提前写入了“该版本暂无更新日志”，改变了既有内部契约。更新窗口本身已有缺失说明占位，不需要候选层重复生成。

## 修复

- 单个无正文 Release 继续返回空 `releaseNotes`，由窗口沿用既有占位显示。
- 多版本聚合时，仅为缺少正文的具体版本生成带版本标题的占位，保证版本边界完整。
- 新增当前版本排除、目标版本上限、稳定版本过滤、降序排列、缺失正文和 GitHub 分页约束。

## 验证

定向命令：

```text
C:\Program Files\nodejs\node.exe --test --test-concurrency=1 --test-timeout=120000 test/app-update.test.mjs test/release-notes-workflow.test.mjs
```

结果：**33 通过、0 失败、3 跳过，共 36 项**。

与 CI 相同的完整非 UI 合约命令：

```text
C:\Program Files\nodejs\node.exe --test --test-concurrency=1 --test-timeout=120000 --test-reporter=./scripts/ci-test-reporter.mjs --test-reporter=./scripts/ci-test-reporter.mjs --test-reporter-destination=stdout --test-reporter-destination=ci-contract-tests-local.log "test/*.test.mjs"
```

结果：**655 通过、0 失败、11 跳过，共 666 项**，耗时约 54.4 秒。跳过项为平台或外部 GitHub 写入条件用例。

## 输入 SHA-256

- `src/app-update/releases.mjs`: `5f9947192d91822fb6ee66bd3db2ba2a3e1d91f35bd76e1a773b2c2476e71261`
- `src/app-update/manager.mjs`: `91db9cbcb9c7e34f45a581d79edb6603668de287de51df224ec973024273e344`
- `test/app-update.test.mjs`: `eb3601424e812a106bfab2a1bc05ad3ce932e807149890f3411ea1cddc1873f6`
- `.github/workflows/build-packages.yml`: `479507bf91b02a01b1a95db9d3f94e293356c482e6192f05818301a09bdfd38c`
- `docs/releases/0.1.331.md`: `d36195614052283a000879a92a9e0d470a36b286ad64e26d191a3134c2f4c7c0`
