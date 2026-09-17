# 启停恢复测试 - Codex 官方模型

归档日期：2026-09-17；环境：macOS / arm64 / macos-native。

原始组件结果：**10/10，passed**。当前代码适用性：**review-required（待差异审核）**。

原始 10 个步骤通过，包含正式包校验、启停、单实例、中继重连和账号往返；模型冒烟为 gpt-5.6-luna。本次仅归档历史报告，没有执行重启。

原始材料位置与 SHA-256 见下方；原始 JSON、日志和截图仅保留在执行机器，未上传完整材料。归档只包含可分享的字段，不包含账号、任务正文、凭据和本机绝对路径。

```json
{
  "archiveSchema": 1,
  "archivedAt": "2026-09-17",
  "name": "启停恢复测试 - Codex 官方模型",
  "scope": "lifecycle",
  "profile": "official",
  "platform": "darwin",
  "arch": "arm64",
  "runtimeTarget": "macos-native",
  "runId": "20260916123504-ccbb7036",
  "startedAt": "2026-09-16T12:35:20.132Z",
  "finishedAt": "2026-09-16T12:39:26.132Z",
  "originalStatus": "passed",
  "componentStatus": "passed",
  "counts": {
    "passed": 10,
    "total": 10
  },
  "reportedProjectVersion": "0.1.270",
  "associatedProjectVersion": null,
  "source": {
    "path": ".runtime/test-results/lifecycle/20260916123504-ccbb7036/report.json",
    "sha256": "84c3240c65055aae8f11a757379152fbae548d0e10ab702b60233ec831189dc1",
    "availability": "local-only"
  },
  "sourceSnapshot": {
    "sha256": "ae88554893f32231c633f3f48538b66d9b4a6c45056cfb08c1550b20333f42a1",
    "fileCount": 314
  },
  "validity": {
    "status": "review-required",
    "reason": "原报告只有全仓摘要，没有分文件/组件输入清单；需差异审核后判断当前适用性，不能自动要求全量重测。",
    "reviewedAgainstCurrentCode": false
  },
  "runtime": {
    "relayProtocol": 80,
    "actualCliBinaryVersion": null
  },
  "packageEvidence": {
    "version": "0.1.270",
    "architecture": "arm64",
    "architectureNames": [
      [
        "arm64"
      ],
      [
        "arm64"
      ],
      [
        "arm64"
      ]
    ],
    "executableSha256": "bbabfb476f774ebb501979bbfeecb9136b6e04c64a660b83c8a019eed06d9467",
    "workerSha256": "0d0c37fe99ce1e2718ed6b9bceefa598539ebdcaf831d37456a7381ac8675977",
    "shimSha256": "0cfe1c8fb24495eb9d032e650b6374d0e83df6d9d7fb1f483cf8242bc5ced61a"
  },
  "checks": [
    {
      "id": "verify-package",
      "status": "passed",
      "startedAt": "2026-09-16T12:35:22.273Z",
      "finishedAt": "2026-09-16T12:35:23.133Z",
      "error": null
    },
    {
      "id": "wait-desktop-idle",
      "status": "passed",
      "startedAt": "2026-09-16T12:35:23.134Z",
      "finishedAt": "2026-09-16T12:35:37.508Z",
      "error": null
    },
    {
      "id": "install-update",
      "status": "passed",
      "startedAt": "2026-09-16T12:35:37.512Z",
      "finishedAt": "2026-09-16T12:35:45.369Z",
      "error": null
    },
    {
      "id": "launch-updated",
      "status": "passed",
      "startedAt": "2026-09-16T12:35:45.376Z",
      "finishedAt": "2026-09-16T12:36:00.242Z",
      "error": null
    },
    {
      "id": "repeat-launch",
      "status": "passed",
      "startedAt": "2026-09-16T12:36:00.245Z",
      "finishedAt": "2026-09-16T12:36:20.957Z",
      "error": null
    },
    {
      "id": "relay-reconnect",
      "status": "passed",
      "startedAt": "2026-09-16T12:36:20.960Z",
      "finishedAt": "2026-09-16T12:36:38.507Z",
      "error": null
    },
    {
      "id": "close-reopen",
      "status": "passed",
      "startedAt": "2026-09-16T12:36:38.512Z",
      "finishedAt": "2026-09-16T12:37:24.751Z",
      "error": null
    },
    {
      "id": "switch-account",
      "status": "passed",
      "startedAt": "2026-09-16T12:37:24.791Z",
      "finishedAt": "2026-09-16T12:38:30.723Z",
      "error": null,
      "modelSmoke": {
        "status": "passed",
        "model": "gpt-5.6-luna"
      }
    },
    {
      "id": "restore-account",
      "status": "passed",
      "startedAt": "2026-09-16T12:38:30.725Z",
      "finishedAt": "2026-09-16T12:39:21.154Z",
      "error": null
    },
    {
      "id": "final-state",
      "status": "passed",
      "startedAt": "2026-09-16T12:39:21.177Z",
      "finishedAt": "2026-09-16T12:39:26.130Z",
      "error": null
    }
  ]
}
```
