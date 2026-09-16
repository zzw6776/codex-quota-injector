const TYPES = {
  free: "免费回归",
  backend: "后台功能测试",
  desktop: "桌面集成测试",
  lifecycle: "启停恢复测试",
};

export function testName(type, profile = "official") {
  const model = type === "free" ? "模拟模型"
    : profile === "official" ? "Codex 官方模型"
    : profile === "deepseek" ? "DeepSeek Flash"
    : profile || "模型总览";
  return `${TYPES[type]} - ${model}`;
}

export function testCountsText(counts) {
  if (!counts) return "通过数/总数：待统计";
  return `通过 ${counts.passed ?? 0}/${counts.tests ?? 0}；失败 ${counts.failed ?? 0}；未执行 ${counts.notRun ?? 0}；跳过 ${counts.skipped ?? 0}`;
}

// Backend files each execute one top-level case. Summary events may be duplicated
// by Node's reporter, so count case outcomes and keep unstarted stages visible.
export function backendTestCounts(events, plannedTests) {
  const results = (events ?? []).filter(event =>
    ["test:pass", "test:fail"].includes(event.type) && (event.nesting ?? 0) === 0);
  return {
    tests: plannedTests,
    passed: results.filter(event => event.type === "test:pass" && !event.skip).length,
    failed: results.filter(event => event.type === "test:fail").length,
    skipped: results.filter(event => event.skip).length,
    notRun: Math.max(0, plannedTests - results.length),
  };
}
