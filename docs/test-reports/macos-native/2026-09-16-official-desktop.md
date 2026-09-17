# 桌面集成测试 - Codex 官方模型

归档日期：2026-09-17；环境：macOS / arm64 / macos-native。

原始组件结果：**16/16，passed**。当前代码适用性：**review-required（待差异审核）**。

本次 read_thread 项实际通过，无需接受上游阻断。rollout 中 CLI 版本属于会话元数据，不能单独证明本轮运行二进制版本。Apps、语音、媒体等条件能力不在本次固定链通过结论内。

原始材料位置与 SHA-256 见下方；原始 JSON、日志和截图仅保留在执行机器，未上传完整材料。归档只包含可分享的字段，不包含账号、任务正文、凭据和本机绝对路径。

```json
{
  "archiveSchema": 1,
  "archivedAt": "2026-09-17",
  "name": "桌面集成测试 - Codex 官方模型",
  "scope": "desktop",
  "profile": "official",
  "platform": "darwin",
  "arch": "arm64",
  "runtimeTarget": "macos-native",
  "runId": "20260916105636-b60d6078",
  "startedAt": "2026-09-16T10:56:36.141Z",
  "finishedAt": "2026-09-16T10:59:37.138Z",
  "originalStatus": "passed",
  "componentStatus": "passed",
  "counts": {
    "unit": "桌面验收项",
    "passed": 16,
    "total": 16
  },
  "reportedProjectVersion": "0.1.270",
  "associatedProjectVersion": null,
  "source": {
    "path": ".runtime/test-results/desktop-host/20260916105636-b60d6078/report.json",
    "sha256": "fe4e915f0d58ae7544b89f357210e684ccec3a66ab892ba6481b45b86aa85e8e",
    "availability": "local-only"
  },
  "sourceSnapshot": {
    "sha256": "54117db38e01094116bc1353070714af1c0f7e92d52a03822d472988db502f99",
    "fileCount": 314
  },
  "validity": {
    "status": "review-required",
    "reason": "原报告只有全仓摘要，没有分文件/组件输入清单；需差异审核后判断当前适用性，不能自动要求全量重测。",
    "reviewedAgainstCurrentCode": false
  },
  "actualModel": "gpt-5.6-luna",
  "runtime": {
    "relayProtocol": 80,
    "widgetRuntime": 171,
    "footerVersion": "v0.1.270.dev",
    "rolloutSessionCliVersion": "0.154.0-alpha.6.2",
    "actualCliBinaryVersion": null
  },
  "checks": [
    {
      "id": "source",
      "label": "源码摘要保持一致",
      "status": "passed"
    },
    {
      "id": "runtime",
      "label": "桌面版本、中继协议与运行环境",
      "status": "passed"
    },
    {
      "id": "model",
      "label": "任务实际使用 Codex 官方模型",
      "status": "passed"
    },
    {
      "id": "model-turn",
      "label": "目标模型任务正常结束",
      "status": "passed"
    },
    {
      "id": "functions-exec",
      "label": "functions.exec 成功命令与真实输出",
      "status": "passed"
    },
    {
      "id": "functions-exec-failure",
      "label": "functions.exec 失败退出码及任务续接",
      "status": "passed"
    },
    {
      "id": "codex-app-list-threads",
      "label": "codex_app list_threads 返回当前任务",
      "status": "passed"
    },
    {
      "id": "codex-app-read-thread",
      "label": "codex_app read_thread 读取当前任务且完成回合内容完整",
      "status": "passed"
    },
    {
      "id": "codex-app-list-projects",
      "label": "codex_app list_projects 返回项目目录",
      "status": "passed"
    },
    {
      "id": "codex-app-get-usage-limits",
      "label": "codex_app get_usage_limits 返回账号用量",
      "status": "passed"
    },
    {
      "id": "web-search",
      "label": "web.run search",
      "status": "passed"
    },
    {
      "id": "web-open",
      "label": "web.run open/click 导航",
      "status": "passed"
    },
    {
      "id": "web-find",
      "label": "web.run find 及官方正文",
      "status": "passed"
    },
    {
      "id": "computer-use",
      "label": "computer use 打开、输入并单次提交",
      "status": "passed"
    },
    {
      "id": "computer-screenshot",
      "label": "computer use 截图",
      "status": "passed"
    },
    {
      "id": "download",
      "label": "浏览器下载测试产物",
      "status": "passed"
    }
  ],
  "blockedReason": null
}
```
