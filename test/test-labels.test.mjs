import assert from "node:assert/strict";
import test from "node:test";
import { backendTestCounts, testCountsText } from "../scripts/test-labels.mjs";

test("后台统计只计测试结果，失败后的未执行阶段不能算通过，重复汇总事件不重复计数", () => {
  const events = [
    { type: "test:pass", nesting: 0 },
    { type: "test:summary", counts: { tests: 1, passed: 1 } },
    { type: "test:summary", counts: { tests: 1, passed: 1 } },
    { type: "test:fail", nesting: 0 },
  ];
  const counts = backendTestCounts(events, 4);
  assert.deepEqual(counts, { tests: 4, passed: 1, failed: 1, skipped: 0, notRun: 2 });
  assert.equal(testCountsText(counts), "通过 1/4；失败 1；未执行 2；跳过 0");
  assert.deepEqual(backendTestCounts([], 4),
    { tests: 4, passed: 0, failed: 0, skipped: 0, notRun: 4 });
});
