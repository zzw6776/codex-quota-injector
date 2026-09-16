import assert from "node:assert/strict";
import test from "node:test";
import { classifyNetworkLatency, ModelRouterManager } from "../src/model-router.mjs";
import { reusableRouterIdentityFromRelayConfig } from "../src/codex-bridge.mjs";
import { startHttpServer } from "./helpers.mjs";
import { routerSettings } from "./model-router/support.mjs";

test("网络 RTT 以近期中位数识别明显波动", () => {
  assert.equal(classifyNetworkLatency([], 48), "stable");
  assert.equal(classifyNetworkLatency([40, 42, 38], 45), "stable");
  assert.equal(classifyNetworkLatency([40, 42, 38], 180), "fluctuating");
  assert.equal(classifyNetworkLatency([40, 42, 38], Number.NaN), "fluctuating");
});

test("Router 跨注入器版本复用原端点，端口被占用时才生成新身份", async (t) => {
  const upstream = await startHttpServer(t, (_request, response) => response.end("ok"));
  const owner = new ModelRouterManager();
  const conflicting = new ModelRouterManager({ endpointReuseWaitMs: 0 });
  const replacement = new ModelRouterManager();
  t.after(async () => Promise.all([
    owner.close(),
    conflicting.close(),
    replacement.close(),
  ]));

  const original = await owner.configure(routerSettings(upstream.origin));
  const identity = reusableRouterIdentityFromRelayConfig({
    version: 6,
    generation: `catalog:usage-events-v40:${original.instanceId}`,
    router: {
      baseUrl: original.baseUrl,
      tokenEnv: original.tokenEnv,
      tokenHeader: original.tokenHeader,
    },
  });
  assert.deepEqual(identity, {
    port: Number(new URL(original.baseUrl).port),
    token: original.token,
    instanceId: original.instanceId,
  });

  const fallback = await conflicting.configure({
    ...routerSettings(upstream.origin),
    reusableIdentity: identity,
  });
  assert.notEqual(fallback.baseUrl, original.baseUrl);
  assert.notEqual(fallback.instanceId, original.instanceId);

  const releaseTimer = setTimeout(() => void owner.close(), 75);
  const reused = await replacement.configure({
    ...routerSettings(upstream.origin),
    reusableIdentity: identity,
  });
  clearTimeout(releaseTimer);
  assert.equal(reused.baseUrl, original.baseUrl);
  assert.equal(reused.token, original.token);
  assert.equal(reused.instanceId, original.instanceId);

  assert.equal(reusableRouterIdentityFromRelayConfig({
    version: 5,
    generation: `catalog:${original.instanceId}`,
    router: {
      baseUrl: original.baseUrl.replace("127.0.0.1", "localhost"),
      tokenEnv: original.tokenEnv,
      tokenHeader: original.tokenHeader,
    },
  }), null);
});
