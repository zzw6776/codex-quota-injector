import assert from "node:assert/strict";
import test from "node:test";

import {
  COMMON_COMPONENT,
  MACOS_NATIVE,
  WINDOWS_NATIVE,
  WSL_NATIVE,
  currentRuntimeTarget,
  resolveRuntimeSelection,
  runtimeComponentId,
  runtimeTargetsForPlatform,
  summarizeFinalStageEvents,
  summarizeSelectedRuntimeComponents,
  summarizeRuntimeComponents,
} from "../scripts/test-runtime-targets.mjs";

test("[A HAR-01 HAR-04] Windows 与 WSL 是独立运行环境，公共证据只复用一次", async () => {
  assert.deepEqual(runtimeTargetsForPlatform("darwin"), [MACOS_NATIVE]);
  assert.deepEqual(runtimeTargetsForPlatform("win32"), [WINDOWS_NATIVE, WSL_NATIVE]);
  assert.equal(await currentRuntimeTarget({ platform: "win32", windowsWslEnabled: false }), WINDOWS_NATIVE);
  assert.equal(await currentRuntimeTarget({ platform: "win32", windowsWslEnabled: true }), WSL_NATIVE);
  assert.deepEqual(resolveRuntimeSelection("all", {
    platform: "win32",
    currentTarget: WINDOWS_NATIVE,
  }), [WINDOWS_NATIVE, WSL_NATIVE]);
  assert.deepEqual(resolveRuntimeSelection("current", {
    platform: "win32",
    currentTarget: WSL_NATIVE,
    allowAll: false,
  }), [WSL_NATIVE]);
  assert.throws(() => resolveRuntimeSelection("all", {
    platform: "win32",
    currentTarget: WINDOWS_NATIVE,
    allowAll: false,
  }), /一次只能选择一个运行环境/);
});

test("[A HAR-04 OBS-03] 总报告只汇总每个执行阶段的最终 summary", () => {
  const events = [
    { type: "test:summary", component: "A-common", stage: "contracts", counts: { tests: 2, passed: 2 }, duration_ms: 2 },
    { type: "test:summary", component: "A-common", stage: "contracts", counts: { tests: 5, passed: 5 }, duration_ms: 5 },
    { type: "test:summary", component: "A-common", stage: "browser", counts: { tests: 3, passed: 3 }, duration_ms: 7 },
  ];
  assert.deepEqual(summarizeFinalStageEvents(events), {
    counts: { tests: 8, passed: 8 },
    duration_ms: 12,
  });
});

test("[A HAR-04] 当前环境通过与全部支持环境通过分别判定，结果不能互相继承", () => {
  const components = [
    { id: COMMON_COMPONENT, status: "passed" },
    { id: runtimeComponentId(WINDOWS_NATIVE), status: "passed" },
    { id: runtimeComponentId(WSL_NATIVE), status: "blocked" },
  ];
  assert.deepEqual(summarizeRuntimeComponents(components, {
    currentTarget: WINDOWS_NATIVE,
    supportedTargets: [WINDOWS_NATIVE, WSL_NATIVE],
  }), {
    currentRuntime: WINDOWS_NATIVE,
    currentRuntimeStatus: "passed",
    allSupportedStatus: "blocked",
  });
  assert.deepEqual(summarizeRuntimeComponents(components, {
    currentTarget: WSL_NATIVE,
    supportedTargets: [WINDOWS_NATIVE, WSL_NATIVE],
  }), {
    currentRuntime: WSL_NATIVE,
    currentRuntimeStatus: "blocked",
    allSupportedStatus: "blocked",
  });
  assert.equal(summarizeSelectedRuntimeComponents(components, [WINDOWS_NATIVE]), "passed");
  assert.equal(
    summarizeSelectedRuntimeComponents(components, [WINDOWS_NATIVE, WSL_NATIVE]),
    "blocked",
  );
});
