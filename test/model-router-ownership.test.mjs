import assert from "node:assert/strict";
import test from "node:test";
import { ModelRouterManager } from "../src/model-router.mjs";
import { startHttpServer, readJsonRequest } from "./helpers.mjs";
import { routerSettings } from "./model-router/support.mjs";

test("自定义模型能力约束和同任务供应商锁在访问上游前生效", async (t) => {
  let requests = 0;
  const upstream = await startHttpServer(t, (_request, response) => {
    requests += 1;
    response.end("{}");
  });
  const manager = new ModelRouterManager();
  t.after(() => manager.close());
  const settings = routerSettings(upstream.origin);
  settings.extraModels.platforms.push({
    ...settings.extraModels.platforms[0],
    id: "123e4567-e89b-42d3-a456-426614174001",
    name: "Second Platform",
    models: [{
      ...settings.extraModels.platforms[0].models[0],
      id: "second-model",
      supportsImage: true,
    }],
  });
  const config = await manager.configure(settings);
  const post = (body) => fetch(new URL("responses", config.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", "thread-id": "locked-thread" },
    body: JSON.stringify(body),
  });

  const image = await post({
    model: "custom-model",
    input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }] }],
  });
  assert.equal(image.status, 400);
  assert.match((await image.json()).error.message, /当前配置未启用图片输入/);

  const effort = await post({ model: "custom-model", input: "hi", reasoning: { effort: "max" } });
  assert.equal(effort.status, 400);
  assert.match((await effort.json()).error.message, /推理深度/);

  const first = await post({ model: "custom-model", input: "hi" });
  assert.equal(first.status, 200);
  const rerouted = await post({ model: "second-model", input: "hi" });
  assert.equal(rerouted.status, 409);
  assert.equal(requests, 1);
});

test("无生成预热不会抢占任务供应商，首个被接受的真实请求才建立锁", async (t) => {
  const requests = [];
  const upstream = await startHttpServer(t, async (request, response) => {
    requests.push(await readJsonRequest(request));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: `resp_${requests.length}`, status: "completed", output: [] }));
  });
  const manager = new ModelRouterManager({
    officialApiBaseUrl: `${upstream.origin}/v1/`,
    officialCodexBaseUrl: `${upstream.origin}/v1/`,
  });
  t.after(() => manager.close());
  const settings = routerSettings(upstream.origin);
  settings.extraModels.platforms = [{
    id: "d33f5ee0-0000-4000-8000-000000000001",
    preset: "deepseek",
    name: "DeepSeek",
    baseUrl: `${upstream.origin}/v1/`,
    apiKey: "deepseek-secret",
    enabled: true,
    models: [{
      id: "deepseek-flash",
      displayName: "DeepSeek Flash",
      compatibility: {
        protocol: "responses",
        historyMode: "reasoning-text-only",
        supportsImage: true,
      },
      reasoningEfforts: ["low", "high", "max"],
      defaultReasoningEffort: "high",
    }],
  }];
  const config = await manager.configure(settings);
  const post = (body) => fetch(new URL("responses", config.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", "thread-id": "prewarm-task" },
    body: JSON.stringify(body),
  });

  const prewarm = await post({ model: "deepseek-v4-flash", generate: false, input: [] });
  assert.equal(prewarm.status, 200);
  assert.equal(requests[0].model, "deepseek-flash", "旧模型 ID 必须只用于恢复并改写为当前别名");
  const official = await post({ model: "official-model", input: "real turn" });
  assert.equal(official.status, 200);
  const rerouted = await post({ model: "deepseek-v4-flash", input: "must reject" });
  assert.equal(rerouted.status, 409);
  assert.equal(requests.length, 2);
});

test("模型管理中的 DeepSeek 预设合并旧 Flash 别名但保留 Pro API 入口", async (t) => {
  const received = [];
  const upstream = await startHttpServer(t, async (request, response) => {
    received.push({
      headers: request.headers,
      body: await readJsonRequest(request),
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "resp-deepseek-preset", status: "completed", output: [] }));
  });
  const manager = new ModelRouterManager();
  t.after(() => manager.close());
  const settings = routerSettings(upstream.origin);
  settings.extraModels.platforms = [{
    id: "d33f5ee0-0000-4000-8000-000000000001",
    preset: "deepseek",
    name: "DeepSeek",
    baseUrl: `${upstream.origin}/v1/`,
    apiKey: "preset-secret",
    enabled: true,
    models: [{
      id: "deepseek-flash",
      displayName: "DeepSeek Flash",
      compatibility: {
        status: "verified",
        protocol: "responses",
        historyMode: "reasoning-text-only",
        toolContinuation: true,
        supportsImage: false,
        imageStatus: "unsupported",
        checkedAt: 1,
        probeVersion: 3,
        targetFingerprint: "stale-fixture",
      },
      documentedSupportsImage: true,
      reasoningEfforts: ["low", "high", "max"],
      defaultReasoningEffort: "high",
    }, {
      id: "deepseek-v4-pro",
      displayName: "DeepSeek Pro",
      compatibility: {
        status: "verified",
        protocol: "responses",
        historyMode: "reasoning-text-only",
        toolContinuation: true,
        supportsImage: false,
        imageStatus: "unsupported",
        checkedAt: 1,
        probeVersion: 5,
        targetFingerprint: "fixture",
      },
      documentedSupportsImage: false,
      reasoningEfforts: ["low", "high", "max"],
      defaultReasoningEffort: "high",
    }],
  }];
  const config = await manager.configure(settings);
  const response = await fetch(new URL("responses", config.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-flash-vision-exp",
      input: [{ role: "user", content: [{
        type: "input_image",
        image_url: "data:image/png;base64,AA==",
      }] }],
    }),
  });
  const proResponse = await fetch(new URL("responses", config.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-v4-pro", input: "pro request" }),
  });

  assert.equal(response.status, 200);
  assert.equal(proResponse.status, 200);
  assert.equal(received[0].headers.authorization, "Bearer preset-secret");
  assert.equal(received[0].body.model, "deepseek-flash");
  assert.equal(received[0].body.input[0].content[0].type, "input_image");
  assert.equal(received[1].body.model, "deepseek-v4-pro");
});

test("本地校验失败和上游拒绝均不会留下任务供应商锁", async (t) => {
  const requests = [];
  const upstream = await startHttpServer(t, async (request, response) => {
    const body = await readJsonRequest(request);
    requests.push(body);
    const status = body.model === "custom-model" ? 400 : 200;
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(status === 200
      ? { id: `resp_${requests.length}`, status: "completed", output: [] }
      : { error: { message: "fixture rejection" } }));
  });
  const manager = new ModelRouterManager();
  t.after(() => manager.close());
  const settings = routerSettings(upstream.origin);
  settings.extraModels.platforms.push({
    ...settings.extraModels.platforms[0],
    id: "123e4567-e89b-42d3-a456-426614174001",
    name: "Second Platform",
    models: [{
      ...settings.extraModels.platforms[0].models[0],
      id: "second-model",
      supportsImage: true,
    }],
  });
  const config = await manager.configure(settings);
  const post = (threadId, body) => fetch(new URL("responses", config.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", "thread-id": threadId },
    body: JSON.stringify(body),
  });

  const invalid = await post("validation-task", {
    model: "custom-model",
    input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }] }],
  });
  assert.equal(invalid.status, 400);
  assert.equal((await post("validation-task", { model: "second-model", input: "accepted" })).status, 200);

  assert.equal((await post("rejected-task", { model: "custom-model", input: "reject" })).status, 400);
  assert.equal((await post("rejected-task", { model: "second-model", input: "accepted" })).status, 200);
  assert.deepEqual(requests.map((body) => body.model), ["second-model", "custom-model", "second-model"]);
});
