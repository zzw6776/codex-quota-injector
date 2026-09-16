import assert from "node:assert/strict";
import test from "node:test";
import { MODEL_CAPABILITY_PROBE_VERSION } from "../src/model-capability-probe.mjs";
import { useTempDir } from "./helpers.mjs";
import { readFile } from "node:fs/promises";
import { customPlatform, detectedCompatibility, extraModelManager } from "./model-configuration/support.mjs";

test("检测日志关联请求且重载后保留独立图片结论，不误记整体通过为图片通过", async t => {
  const logs = [];
  t.mock.method(console, "log", (...args) => logs.push(args));
  const dataDir = await useTempDir(t);
  const manager = extraModelManager(dataDir, { probeModel: async ({ onDiagnostic }) => {
    onDiagnostic({ event: "request-start", sequence: 1, stage: "image", protocol: "responses" });
    onDiagnostic({ event: "request-end", sequence: 1, stage: "image", ok: true, answerChars: 0 });
    return detectedCompatibility({ supportsImage: null, imageStatus: "inconclusive",
      imageDetail: "图片检测未完成：未返回完整的最终答案" });
  } });
  await manager.initialize();
  await manager.savePlatform(customPlatform());
  const platform = manager.getViewModel().platforms.find(item => item.name === "Local Provider");
  await manager.detectModel(platform, "custom-model", { requestId: "diagnostic-round" });
  const records = logs.filter(args => args[0] === "[model-probe]").map(args => args[1]);
  assert.deepEqual(records.map(item => item.event), ["detection-start", "request-start", "request-end", "detection-end"]);
  assert.ok(records.every(item => item.requestId === "diagnostic-round" && item.platformId === platform.id && item.modelId === "custom-model"));
  const reloaded = extraModelManager(dataDir);
  const restored = (await reloaded.initialize()).platforms.find(item => item.id === platform.id);
  const report = restored.models[0].lastDetection;
  assert.equal(report.status, "passed");
  assert.equal(report.requestCount, 1);
  assert.equal(report.requestId, "diagnostic-round");
  assert.equal(report.probeVersion, MODEL_CAPABILITY_PROBE_VERSION);
  assert.deepEqual(report.image, { status: "inconclusive", supportsImage: null,
    protocol: "responses", detail: "图片检测未完成：未返回完整的最终答案" });
});

test("并行检测独立推进且同时保存、乱序完成不会覆盖配置或报告", async t => {
  const controls = new Map();
  const manager = extraModelManager(await useTempDir(t), { probeModel: ({ modelId, onProgress }) =>
    new Promise((resolve, reject) => controls.set(modelId, { resolve, reject, onProgress })) });
  await manager.initialize();
  await manager.savePlatform(customPlatform({ enabled: false, models: ['alpha', 'beta', 'gamma'].map(id => ({
    ...customPlatform().models[0], id,
  })) }));
  const platform = manager.getViewModel().platforms.find(item => item.name === 'Local Provider');
  const probes = platform.models.map(model => manager.detectModel(platform, model.id, { requestId: model.id }));
  assert.equal(controls.size, 3, '三个请求都必须在任何一个结束前启动');
  controls.get('alpha').onProgress({ stage: 'image', message: 'alpha image', current: 7, total: 8 });
  controls.get('beta').onProgress({ stage: 'reasoning', message: 'beta reasoning', current: 4, total: 8 });
  const running = manager.getViewModel().modelDetections;
  assert.equal(running.find(item => item.modelId === 'alpha').operation.detail, 'alpha image');
  assert.equal(running.find(item => item.modelId === 'beta').operation.detail, 'beta reasoning');
  const save = manager.savePlatform({ ...platform, name: 'Edited while probing', models: platform.models.map(model => ({
    ...model, contextWindow: 256000,
  })) });
  controls.get('beta').reject(new Error('beta unavailable'));
  controls.get('gamma').resolve(detectedCompatibility());
  controls.get('alpha').resolve(detectedCompatibility());
  await Promise.all([save, ...probes]);
  const view = manager.getViewModel();
  assert.equal(view.modelDetections.filter(item => item.status === 'passed').length, 2);
  assert.equal(view.modelDetections.find(item => item.modelId === 'beta').status, 'failed');
  const reloaded = extraModelManager(manager.dataDir);
  await reloaded.initialize();
  const restored = reloaded.getViewModel().platforms.find(item => item.id === platform.id);
  assert.equal(restored.name, 'Edited while probing');
  assert.ok(restored.models.every(model => model.contextWindow === 256000));
  assert.ok(restored.models.every(model => model.compatibility.status !== 'verified'), '检测不能自动保存参数');
  assert.deepEqual(restored.models.map(model => model.lastDetection.status), ['passed', 'failed', 'passed']);
});

test("同一模型再次检测后旧请求的进度和失败不能覆盖新结果", async t => {
  const controls = [];
  const manager = extraModelManager(await useTempDir(t), { probeModel: ({ onProgress }) =>
    new Promise((resolve, reject) => controls.push({ resolve, reject, onProgress })) });
  await manager.initialize();
  await manager.savePlatform(customPlatform());
  const platform = manager.getViewModel().platforms.find(item => item.name === 'Local Provider');
  const old = manager.detectModel(platform, 'custom-model', { requestId: 'old' });
  const latest = manager.detectModel(platform, 'custom-model', { requestId: 'latest' });
  assert.equal(controls.length, 2);
  controls[1].resolve(detectedCompatibility());
  await latest;
  controls[0].onProgress({ stage: 'image', message: 'stale progress', current: 7, total: 8 });
  controls[0].reject(new Error('stale failure'));
  await old;
  const detection = manager.getViewModel().modelDetections[0];
  assert.equal(detection.requestId, 'latest');
  assert.equal(detection.status, 'passed');
  assert.equal(detection.operation, null);
  const persisted = JSON.parse(await readFile(manager.settingsPath, 'utf8'));
  assert.equal(persisted.detectionReports.find(item => item.modelId === 'custom-model').status, 'passed');
});
