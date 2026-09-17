# 桌面集成测试 - DeepSeek Flash

归档日期：2026-09-17；环境：macOS / arm64 / macos-native。

原始组件结果：**13/16，blocked**。当前代码适用性：**review-required（待差异审核）**。

原始状态 blocked、13/16 保留。web.run search/open/find 三项 unsupported；已有单独规则复核，见同目录 deepseek-desktop-review 报告。不能把不支持项改写为真实执行通过。

原始材料位置与 SHA-256 见下方；原始 JSON、日志和截图仅保留在执行机器，未上传完整材料。归档只包含可分享的字段，不包含账号、任务正文、凭据和本机绝对路径。

```json
{
  "archiveSchema": 1,
  "archivedAt": "2026-09-17",
  "name": "桌面集成测试 - DeepSeek Flash",
  "scope": "desktop",
  "profile": "deepseek",
  "platform": "darwin",
  "arch": "arm64",
  "runtimeTarget": "macos-native",
  "runId": "20260916105636-80cffb4b",
  "startedAt": "2026-09-16T10:56:36.144Z",
  "finishedAt": "2026-09-16T10:58:36.951Z",
  "originalStatus": "blocked",
  "componentStatus": "blocked",
  "counts": {
    "unit": "桌面验收项",
    "passed": 13,
    "total": 16
  },
  "reportedProjectVersion": "0.1.270",
  "associatedProjectVersion": null,
  "source": {
    "path": ".runtime/test-results/desktop-host/20260916105636-80cffb4b/report.json",
    "sha256": "ef5a2f120791059b09ea2c0e2a2f44d96a11229c52bf7bf5f2b33e2ab945272b",
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
  "actualModel": "deepseek-flash",
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
      "label": "任务实际使用 DeepSeek",
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
      "status": "unsupported"
    },
    {
      "id": "web-open",
      "label": "web.run open/click 导航",
      "status": "unsupported"
    },
    {
      "id": "web-find",
      "label": "web.run find 及官方正文",
      "status": "unsupported"
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
  "blockedReason": "目标模型任务已结束，能力不可用或未执行：web.run search(unsupported)、web.run open/click 导航(unsupported)、web.run find 及官方正文(unsupported)"
}
```
