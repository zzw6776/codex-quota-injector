# 后台功能测试 - Codex 官方模型

归档日期：2026-09-17；环境：macOS / arm64 / macos-native。

原始组件结果：**4/4，passed**。当前代码适用性：**review-required（待差异审核）**。

只读取 backendStatus 作为后台状态。四阶段各一个自动化用例，不能与桌面验收项合并计数。原报告未记录实际官方模型标识，不能用桌面模型推定。发布版本由相同源码摘要的关联桌面报告确认；旧 freeComponent 中运行时摘要仅为关联证据。

原始材料位置与 SHA-256 见下方；原始 JSON、日志和截图仅保留在执行机器，未上传完整材料。归档只包含可分享的字段，不包含账号、任务正文、凭据和本机绝对路径。

```json
{
  "archiveSchema": 1,
  "archivedAt": "2026-09-17",
  "name": "后台功能测试 - Codex 官方模型",
  "scope": "backend",
  "profile": "official",
  "platform": "darwin",
  "arch": "arm64",
  "runtimeTarget": "macos-native",
  "runId": "2026-09-16T10:53:29.037Z",
  "startedAt": "2026-09-16T10:53:29.037Z",
  "finishedAt": "2026-09-16T10:55:53.029Z",
  "originalStatus": "passed",
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
    "path": ".runtime/test-results/live-official-macos-native.json",
    "sha256": "57ef386808e58cdbefc5eadd805414586efa93a03f740144ba71fcc3fb56e84c",
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
    "path": ".runtime/test-results/desktop-host/20260916105636-b60d6078/report.json",
    "sha256": "fe4e915f0d58ae7544b89f357210e684ccec3a66ab892ba6481b45b86aa85e8e",
    "sameSourceSha256": true
  },
  "configuredModels": [
    {
      "id": "official",
      "model": null
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
      "label": "[MOD-03 TOOL-01 TOOL-03 TOOL-07] official 真实工作区与 MCP 工具",
      "status": "passed"
    },
    {
      "label": "[MOD-03 SES-01 SES-02] official 真实历史恢复与分叉",
      "status": "passed"
    },
    {
      "label": "[MOD-03 SES-06] official 真实显式压缩与恢复",
      "status": "passed"
    },
    {
      "label": "[TOOL-04 IO-01 IO-03 INT-02] official 真实 app-server 回调与用户输入",
      "status": "passed"
    }
  ]
}
```
