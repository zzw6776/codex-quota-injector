# 后台功能测试 - DeepSeek Flash

归档日期：2026-09-17；环境：macOS / arm64 / macos-native。

原始组件结果：**4/4，passed**。当前代码适用性：**review-required（待差异审核）**。

后台四阶段全部通过；原文件的顶层 blocked 来自关联桌面报告，不能误记为后台失败。原报告配置模型为 deepseek-flash。发布版本由相同源码摘要的关联桌面报告确认；旧 freeComponent 中运行时摘要仅为关联证据。

原始材料位置与 SHA-256 见下方；原始 JSON、日志和截图仅保留在执行机器，未上传完整材料。归档只包含可分享的字段，不包含账号、任务正文、凭据和本机绝对路径。

```json
{
  "archiveSchema": 1,
  "archivedAt": "2026-09-17",
  "name": "后台功能测试 - DeepSeek Flash",
  "scope": "backend",
  "profile": "deepseek",
  "platform": "darwin",
  "arch": "arm64",
  "runtimeTarget": "macos-native",
  "runId": "2026-09-16T10:53:29.037Z",
  "startedAt": "2026-09-16T10:53:29.037Z",
  "finishedAt": "2026-09-16T10:55:36.266Z",
  "originalStatus": "blocked",
  "componentStatus": "passed",
  "counts": {
    "passed": 4,
    "total": 4,
    "failed": 0,
    "skipped": 0,
    "notRun": 0
  },
  "reportedProjectVersion": null,
  "associatedProjectVersion": "0.1.270",
  "source": {
    "path": ".runtime/test-results/live-deepseek-macos-native.json",
    "sha256": "23f2139f348ffff342752b8c4b396523b842415d1a647ae6f19ea1ab8a10fdc7",
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
  "versionEvidence": {
    "path": ".runtime/test-results/desktop-host/20260916105636-80cffb4b/report.json",
    "sha256": "ef5a2f120791059b09ea2c0e2a2f44d96a11229c52bf7bf5f2b33e2ab945272b",
    "sameSourceSha256": true
  },
  "configuredModels": [
    {
      "id": "deepseek",
      "model": "deepseek-flash"
    }
  ],
  "actualModel": null,
  "relatedRuntimeHashes": {
    "cli": {
      "sha256": "a1d2f191e70023ed7afd619bc70530f26067a085926e03bae50cf5c0f8298bcf"
    },
    "browser": {
      "sha256": "fc35930a1abb21bffb5acf3b01dda346cf1c1b3fbe96095eaa0174989b380608"
    },
    "cliBundleInfo": {
      "sha256": "f3f81abaedd92c2d52fcbd4e13569a3d14eb022a242929d02401c1fc13f16d39"
    },
    "browserBundleInfo": {
      "sha256": "88567515c3e24d7884078e6bb454624c3aa4ca48cc8ea2bfe1303a7e948fc5b6"
    }
  },
  "checks": [
    {
      "label": "[MOD-03 TOOL-01 TOOL-03 TOOL-07] deepseek 真实工作区与 MCP 工具",
      "status": "passed"
    },
    {
      "label": "[MOD-03 SES-01 SES-02] deepseek 真实历史恢复与分叉",
      "status": "passed"
    },
    {
      "label": "[MOD-03 SES-06] deepseek 真实显式压缩与恢复",
      "status": "passed"
    },
    {
      "label": "[TOOL-04 IO-01 IO-03 INT-02] deepseek 真实 app-server 回调与用户输入",
      "status": "passed"
    }
  ]
}
```
