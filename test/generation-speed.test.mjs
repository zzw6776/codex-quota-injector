import assert from "node:assert/strict";
import test from "node:test";
import { assignOutputPhaseSpeed, generationSpeedWindow } from "../src/generation-speed.mjs";
import { createResponseObservation } from "../src/model-router.mjs";

test("请求生成窗口只合计输出阶段，并行重叠只计一次，缺失阶段不能只统计剩余部分", () => {
  const sample = {
    outputPhasesComplete: true,
    outputPhases: [
      { kind: "text", startLatencyMs: 1_000, durationMs: 1_000 },
      { kind: "tool", startLatencyMs: 4_000, durationMs: 2_000 },
      { kind: "tool", startLatencyMs: 5_000, durationMs: 3_000 },
    ],
    toolTiming: { durationMs: 90_000 },
  };
  assert.deepEqual(generationSpeedWindow(sample), { durationMs: 5_000, reason: null });
  assert.equal(generationSpeedWindow({ ...sample, outputPhasesComplete: false }).reason, "insufficient-data");
  assert.equal(generationSpeedWindow({ ...sample, outputPhases: [...sample.outputPhases, { kind: "tool", durationMs: null }] }).durationMs, 0);
  assert.equal(generationSpeedWindow({ hasVisibleText: true, hasNonTextOutput: true, generationDurationMs: 100 }).reason, "unattributed-output");
});

test("响应级 Token 只允许归属给唯一输出段，多段不能按字数或时间摊派", () => {
  for (const kind of ["text", "tool"]) {
    const detail = { outputPhasesComplete: true, outputPhases: [{ kind, durationMs: 1_000 }] };
    assignOutputPhaseSpeed(detail, 40);
    assert.equal(detail.outputPhases[0].outputSpeed, 40);
    detail.outputPhases.push({ kind: "text", durationMs: 100 });
    assignOutputPhaseSpeed(detail, 50);
    assert.ok(detail.outputPhases.every((phase) => phase.outputSpeed === undefined));
    detail.outputPhases.pop();
    detail.outputPhasesComplete = false;
    assignOutputPhaseSpeed(detail, 60);
    assert.equal(detail.outputPhases[0].outputSpeed, undefined);
  }
});

function observation() {
  let time = 10_000;
  let generation;
  const observer = createResponseObservation({
    requestStartedAt: time, requireCompleted: true, clock: () => time,
    onUsage: () => {}, onGeneration: (value) => { generation = value; },
  });
  return {
    send(offset, value) { time = 10_000 + offset; observer.recordPayload(value); },
    finish() { observer.finish(); return generation; },
  };
}

test("说明与工具参数按流式增量计时，重复完成事件和工具执行等待不拉长生成阶段", () => {
  const recorder = observation();
  recorder.send(100, { type: "response.created", response: { id: "resp-phases" } });
  recorder.send(200, { type: "response.output_item.added", item: { type: "reasoning", id: "r" } });
  recorder.send(1_000, { type: "response.output_item.added", item: { type: "message", id: "m", phase: "commentary", content: [] } });
  recorder.send(1_000, { type: "response.output_text.delta", item_id: "m", delta: "我先" });
  recorder.send(2_000, { type: "response.output_text.delta", item_id: "m", delta: "检查" });
  recorder.send(3_000, { type: "response.output_text.done", item_id: "m", text: "我先检查" });
  recorder.send(4_000, { type: "response.output_item.added", item: { type: "custom_tool_call", id: "t", call_id: "call-t", name: "arbitrary-mcp-tool" } });
  recorder.send(5_000, { type: "response.custom_tool_call_input.delta", item_id: "t", delta: "first" });
  recorder.send(7_000, { type: "response.custom_tool_call_input.delta", call_id: "call-t", delta: "second" });
  const output = [
    { type: "message", id: "m", phase: "commentary", content: [{ type: "output_text", text: "我先检查" }] },
    { type: "custom_tool_call", id: "t", call_id: "call-t", name: "arbitrary-mcp-tool", input: "firstsecond" },
  ];
  recorder.send(9_000, { type: "response.output_item.done", item: output[1] });
  recorder.send(20_000, { type: "response.completed", response: { id: "resp-phases", output } });
  const generation = recorder.finish();
  assert.equal(generation.outputPhasesComplete, true);
  assert.deepEqual(generation.outputPhases, [
    { kind: "text", textPhaseIndex: 0, startLatencyMs: 1_000, durationMs: 1_000 },
    { kind: "tool", startLatencyMs: 5_000, durationMs: 2_000 },
  ]);
  assert.equal(generation.textPhases[0].durationMs, 1_000);
  assert.equal(generationSpeedWindow(generation).durationMs, 3_000);
});

test("一次性工具内容或无可测生成阶段的其他输出，不伪造极高速率", () => {
  const recorder = observation();
  recorder.send(100, { type: "response.output_item.added", item: { type: "function_call", id: "t", call_id: "call" } });
  recorder.send(1_000, { type: "response.function_call_arguments.delta", item_id: "t", delta: "large single chunk" });
  recorder.send(8_000, { type: "response.completed", response: { id: "r", output: [{ type: "function_call", id: "t", call_id: "call", arguments: "large single chunk" }] } });
  const result = recorder.finish();
  assert.equal(result.outputPhasesComplete, false);
  assert.equal(result.outputPhases[0].durationMs, null);
  assert.equal(generationSpeedWindow(result).reason, "insufficient-data");
});
