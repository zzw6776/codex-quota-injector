import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  ModelCatalogCoordinator,
  MODEL_CATALOG_REFRESH_MS,
  nextModelCatalogRefreshDelay,
} from "../src/model-catalog-coordinator.mjs";
import { CodexContextManager } from "../src/codex-context.mjs";
import { fetchOfficialModelCatalog } from "../src/official-model-catalog.mjs";
import { useTempDir } from "./helpers.mjs";

const OAUTH_RUNTIME = {
  executable: "/runtime/codex",
  clientVersion: "0.166.0-alpha.6",
  originator: "Codex Desktop",
};
const readFixtureRuntimeVersion = async () => OAUTH_RUNTIME.clientVersion;

function oauthAccount(overrides = {}) {
  return {
    id: "record-a",
    authMode: "oauth",
    accountId: "workspace-a",
    tokens: {
      idToken: "identity-a",
      accessToken: "access-a",
      refreshToken: "must-not-send",
    },
    ...overrides,
  };
}

function catalog(slug = "catalog-model") {
  return { models: [{ slug, display_name: slug }] };
}

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
}

function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.`;
}

test("OAuth 直接读取 OpenAI 账号目录，API Key 继续使用官方 CLI 内置目录", async (t) => {
  const directory = await useTempDir(t);
  const executable = join(directory, "fixture-codex");
  await writeFile(executable, "fixture");
  let request;
  const oauth = await fetchOfficialModelCatalog({
    ...OAUTH_RUNTIME,
    executable,
    clientVersion: null,
    readVersion: async (receivedExecutable) => {
      assert.equal(receivedExecutable, executable);
      return OAUTH_RUNTIME.clientVersion;
    },
    dataDir: directory,
    account: oauthAccount(),
    runCli: async () => assert.fail("OAuth 模型目录不应启动 CLI"),
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse(catalog());
    },
  });
  assert.equal(oauth.source, "online");
  assert.equal(request.url,
    "https://chatgpt.com/backend-api/codex/models?client_version=0.166.0-alpha.6");
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.headers.Authorization, "Bearer access-a");
  assert.equal(request.options.headers["ChatGPT-Account-Id"], "workspace-a");
  assert.equal(request.options.headers.originator, "Codex Desktop");
  assert.doesNotMatch(JSON.stringify(request), /must-not-send/);

  let captured;
  const apiKey = await fetchOfficialModelCatalog({
    executable,
    dataDir: directory,
    account: { authMode: "apiKey", openaiApiKey: "sk-local" },
    fetchImpl: async () => assert.fail("API Key 模式不应请求 OAuth 模型目录"),
    runCli: async (receivedExecutable, args, options) => {
      captured = {
        executable: receivedExecutable,
        args,
        auth: JSON.parse(await readFile(join(options.env.CODEX_HOME, "auth.json"), "utf8")),
      };
      return { stdout: JSON.stringify(catalog("bundled-model")), stderr: "" };
    },
  });
  assert.equal(apiKey.source, "bundled");
  assert.equal(captured.executable, executable);
  assert.equal(captured.auth.OPENAI_API_KEY, "sk-local");
  assert.deepEqual(captured.args, ["-c", "cli_auth_credentials_store=\"file\"", "debug", "models"]);
});

test("账号目录缓存一小时，并按 CLI 版本与 originator 隔离", async (t) => {
  const directory = await useTempDir(t);
  let time = Date.parse("2026-10-30T00:00:00Z");
  let calls = 0;
  const fetchImpl = async () => jsonResponse(catalog(`online-${++calls}`));
  const base = {
    ...OAUTH_RUNTIME,
    dataDir: directory,
    account: oauthAccount(),
    now: () => time,
    fetchImpl,
  };

  const first = await fetchOfficialModelCatalog({
    ...base,
    executable: "/runtime/0.165/codex",
    clientVersion: "0.165.0-alpha.1",
  });
  assert.equal(first.source, "online");
  assert.equal(calls, 1);

  time += 59 * 60_000;
  const cached = await fetchOfficialModelCatalog({
    ...base,
    executable: "/runtime/0.166/codex",
    clientVersion: "0.165.0-alpha.1",
    account: oauthAccount({
      tokens: { idToken: "rotated-id", accessToken: "rotated-access", refreshToken: "rotated-refresh" },
    }),
  });
  assert.equal(cached.source, "cache");
  assert.equal(cached.catalog.models[0].slug, "online-1");
  assert.equal(calls, 1);

  const refreshed = await fetchOfficialModelCatalog({
    ...base,
    executable: "/runtime/0.166/codex",
    clientVersion: "0.166.0-alpha.6",
  });
  assert.equal(refreshed.source, "online");
  assert.equal(refreshed.catalog.models[0].slug, "online-2");
  assert.equal(calls, 2);

  const differentOriginator = await fetchOfficialModelCatalog({
    ...base,
    executable: "/runtime/0.166/codex",
    clientVersion: "0.166.0-alpha.6",
    originator: "codex_cli_rs",
  });
  assert.equal(differentOriginator.source, "online");
  assert.equal(differentOriginator.catalog.models[0].slug, "online-3");
  assert.equal(calls, 3);
});

test("手动刷新会绕过当前账号的新鲜缓存", async (t) => {
  const directory = await useTempDir(t);
  let calls = 0;
  const options = {
    ...OAUTH_RUNTIME,
    dataDir: directory,
    account: oauthAccount(),
    fetchImpl: async () => jsonResponse(catalog(`manual-${++calls}`)),
  };

  const first = await fetchOfficialModelCatalog(options);
  const cached = await fetchOfficialModelCatalog(options);
  const refreshed = await fetchOfficialModelCatalog({ ...options, force: true });

  assert.equal(first.source, "online");
  assert.equal(cached.source, "cache");
  assert.equal(refreshed.source, "online");
  assert.equal(refreshed.catalog.models[0].slug, "manual-2");
  assert.equal(calls, 2);
});

test("账号目录缓存按账号隔离，不借用其他工作区的目录", async (t) => {
  const directory = await useTempDir(t);
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls++;
    return jsonResponse(catalog(options.headers.Authorization.endsWith("access-b") ? "model-b" : "model-a"));
  };
  const options = {
    ...OAUTH_RUNTIME,
    dataDir: directory,
    now: () => Date.parse("2026-10-30T00:00:00Z"),
    fetchImpl,
  };

  await fetchOfficialModelCatalog({ ...options, account: oauthAccount() });
  const second = await fetchOfficialModelCatalog({
    ...options,
    account: oauthAccount({
      id: "record-b",
      accountId: "workspace-b",
      tokens: { idToken: "identity-b", accessToken: "access-b", refreshToken: "refresh-b" },
    }),
  });
  assert.equal(second.catalog.models[0].slug, "model-b");
  assert.equal(calls, 2);

  const original = await fetchOfficialModelCatalog({
    ...options,
    account: oauthAccount({
      tokens: { idToken: "new-id-a", accessToken: "new-access-a", refreshToken: "new-refresh-a" },
    }),
  });
  assert.equal(original.source, "cache");
  assert.equal(original.catalog.models[0].slug, "model-a");
  assert.equal(calls, 2);
});

test("目录请求区分永久认证失败、限流重试时间和无效响应", async (t) => {
  const directory = await useTempDir(t);
  const base = { ...OAUTH_RUNTIME, dataDir: directory, account: oauthAccount() };

  await assert.rejects(
    fetchOfficialModelCatalog({
      ...base,
      fetchImpl: async () => new Response(null, { status: 401 }),
    }),
    (error) => error.catalogRetryable === false && /HTTP 401/.test(error.message),
  );

  await assert.rejects(
    fetchOfficialModelCatalog({
      ...base,
      fetchImpl: async () => new Response(null, {
        status: 429,
        headers: { "retry-after": "120" },
      }),
    }),
    (error) => error.catalogRetryable === true && error.catalogRetryAfterMs === 120_000,
  );

  await assert.rejects(
    fetchOfficialModelCatalog({
      ...base,
      fetchImpl: async () => new Response("not-json"),
    }),
    /不是有效 JSON/,
  );
  await assert.rejects(
    fetchOfficialModelCatalog({
      ...base,
      fetchImpl: async () => jsonResponse({ models: [{ slug: "same" }, { slug: "same" }] }),
    }),
    /重复模型/,
  );

  await assert.rejects(
    fetchOfficialModelCatalog({
      ...base,
      refreshTimeoutMs: 5,
      fetchImpl: async (_url, options) => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: () => new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("body aborted")), {
            once: true,
          });
        }),
      }),
    }),
    /请求超时/,
  );
});

test("在线刷新失败时只携带当前账号自己的过期缓存作为回退", async (t) => {
  const directory = await useTempDir(t);
  let time = Date.parse("2026-10-30T00:00:00Z");
  const options = {
    ...OAUTH_RUNTIME,
    dataDir: directory,
    account: oauthAccount(),
    now: () => time,
  };
  await fetchOfficialModelCatalog({
    ...options,
    fetchImpl: async () => jsonResponse(catalog("last-account-model")),
  });
  time += 2 * 60 * 60_000;
  await assert.rejects(
    fetchOfficialModelCatalog({
      ...options,
      fetchImpl: async () => new Response(null, { status: 503 }),
    }),
    (error) => error.catalogFallbackCatalog?.models[0]?.slug === "last-account-model",
  );
});

test("临期 Token 有缓存时延后，无缓存且仍可完成请求时建立首次缓存", async (t) => {
  const directory = await useTempDir(t);
  let time = Date.parse("2026-10-30T00:00:00Z");
  const futureToken = jwt({ exp: Math.floor(time / 1_000) + 7_260 });
  const account = oauthAccount({
    tokens: { idToken: "identity-a", accessToken: futureToken, refreshToken: "refresh-a" },
  });
  await fetchOfficialModelCatalog({
    ...OAUTH_RUNTIME,
    dataDir: directory,
    account,
    now: () => time,
    fetchImpl: async () => jsonResponse(catalog("last-account-model")),
  });

  time += 2 * 60 * 60_000;
  let calls = 0;
  const deferred = await fetchOfficialModelCatalog({
    ...OAUTH_RUNTIME,
    dataDir: directory,
    account,
    now: () => time,
    fetchImpl: async () => {
      calls++;
      return jsonResponse(catalog("must-not-fetch"));
    },
  });
  assert.equal(calls, 0);
  assert.equal(deferred.deferred, true);
  assert.equal(deferred.source, "cache");
  assert.equal(deferred.catalog.models[0].slug, "last-account-model");
  assert.equal(deferred.retryAfterMs, 5 * 60_000);

  const noCache = await fetchOfficialModelCatalog({
    ...OAUTH_RUNTIME,
    dataDir: directory,
    account: oauthAccount({
      id: "record-b",
      accountId: "workspace-b",
      tokens: { idToken: "identity-b", accessToken: jwt({ exp: Math.floor(time / 1_000) + 60 }) },
    }),
    now: () => time,
    fetchImpl: async () => {
      calls++;
      return jsonResponse(catalog("first-online-model"));
    },
  });
  assert.equal(calls, 1);
  assert.equal(noCache.deferred, undefined);
  assert.equal(noCache.catalog.models[0].slug, "first-online-model");
  assert.equal(noCache.source, "online");

  const expiredWithoutCache = await fetchOfficialModelCatalog({
    ...OAUTH_RUNTIME,
    dataDir: directory,
    account: oauthAccount({
      id: "record-c",
      accountId: "workspace-c",
      tokens: { idToken: "identity-c", accessToken: jwt({ exp: Math.floor(time / 1_000) - 1 }) },
    }),
    now: () => time,
    fetchImpl: async () => {
      calls++;
      return jsonResponse(catalog("must-not-fetch"));
    },
  });
  assert.equal(calls, 1);
  assert.equal(expiredWithoutCache.deferred, true);
  assert.equal(expiredWithoutCache.catalog, null);
  assert.equal(expiredWithoutCache.source, null);

  const tooShortWithoutCache = await fetchOfficialModelCatalog({
    ...OAUTH_RUNTIME,
    dataDir: directory,
    account: oauthAccount({
      id: "record-d",
      accountId: "workspace-d",
      tokens: { idToken: "identity-d", accessToken: jwt({ exp: Math.floor(time / 1_000) + 10 }) },
    }),
    now: () => time,
    fetchImpl: async () => {
      calls++;
      return jsonResponse(catalog("must-not-fetch"));
    },
  });
  assert.equal(calls, 1);
  assert.equal(tooShortWithoutCache.deferred, true);
});

test("协调器保留缓存来源，并把认证失败标记为停止自动重试", async (t) => {
  const directory = await useTempDir(t);
  const account = oauthAccount();
  await fetchOfficialModelCatalog({
    ...OAUTH_RUNTIME,
    dataDir: directory,
    account,
    fetchImpl: async () => jsonResponse(catalog("online-model")),
  });
  let applied;
  let appliedCatalog;
  const contextManager = {
    dataDir: directory,
    setModelCatalogScope: async () => {},
    useOfficialCatalog: async (_catalog, options) => {
      appliedCatalog = _catalog;
      applied = options;
      return { changed: false };
    },
  };
  const accountManager = {
    getCurrentModelCatalogAccount: async () => account,
  };

  const cachedCoordinator = new ModelCatalogCoordinator({
    accountManager,
    contextManager,
    readRuntimeVersion: readFixtureRuntimeVersion,
  });
  const cached = await cachedCoordinator.request({
    executable: "/different/runtime/codex",
    clientVersion: OAUTH_RUNTIME.clientVersion,
  });
  cachedCoordinator.close();
  assert.equal(cached.officialCatalogSource, "cache");
  assert.equal(cached.officialCatalogChecked, false);
  assert.deepEqual(applied, { source: "official-cache" });

  const deferredCoordinator = new ModelCatalogCoordinator({
    accountManager,
    contextManager,
    readRuntimeVersion: readFixtureRuntimeVersion,
    fetchModelCatalog: async () => ({
      catalog: catalog("last-account-model"),
      source: "cache",
      deferred: true,
      retryAfterMs: 5 * 60_000,
    }),
  });
  const deferred = await deferredCoordinator.request({
    executable: "/different/runtime/codex",
  });
  deferredCoordinator.close();
  assert.equal(deferred.officialCatalogDeferred, true);
  assert.equal(deferred.officialCatalogRetryAfterMs, 5 * 60_000);

  const fallbackCoordinator = new ModelCatalogCoordinator({
    accountManager,
    contextManager,
    readRuntimeVersion: readFixtureRuntimeVersion,
    fetchModelCatalog: async () => {
      const error = new Error("OpenAI 模型目录请求失败（HTTP 503）");
      error.catalogFallbackCatalog = catalog("last-account-model");
      throw error;
    },
  });
  const fallback = await fallbackCoordinator.request({
    executable: "/different/runtime/codex",
  });
  fallbackCoordinator.close();
  assert.equal(fallback.officialCatalogSource, "cache");
  assert.equal(appliedCatalog.models[0].slug, "last-account-model");
  assert.deepEqual(applied, { source: "official-cache" });

  const failedCoordinator = new ModelCatalogCoordinator({
    accountManager: {
      ...accountManager,
      getCurrentModelCatalogAccount: async () => oauthAccount({ id: "record-b", accountId: "workspace-b" }),
    },
    contextManager,
    readRuntimeVersion: readFixtureRuntimeVersion,
    fetchModelCatalog: async () => {
      const error = new Error("OpenAI 模型目录请求失败（HTTP 401）");
      error.catalogRetryable = false;
      throw error;
    },
  });
  const failed = await failedCoordinator.request({
    executable: "/different/runtime/codex",
  });
  failedCoordinator.close();
  assert.equal(failed.officialCatalogRetryable, false);
  assert.match(failed.officialCatalogError, /HTTP 401/);
});

test("刷新期间凭据变化会丢弃旧结果，并让原请求等待新凭据刷新", async () => {
  let account = oauthAccount();
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  const applied = [];
  const scopes = [];
  let calls = 0;
  const coordinator = new ModelCatalogCoordinator({
    accountManager: {
      getCurrentModelCatalogAccount: async () => account,
    },
    contextManager: {
      dataDir: "/data",
      setModelCatalogScope: async (scope) => { scopes.push(scope); },
      useOfficialCatalog: async (value) => {
        applied.push(value.models[0].slug);
        return { changed: true };
      },
    },
    readRuntimeVersion: readFixtureRuntimeVersion,
    fetchModelCatalog: async ({ account: requestedAccount }) => {
      calls++;
      if (calls === 1) {
        markFirstStarted();
        await firstBlocked;
      }
      return {
        catalog: catalog(requestedAccount.accountId),
        source: "online",
      };
    },
  });

  const originalRequest = coordinator.request({
    reason: "periodic",
    executable: "/runtime/codex",
  });
  await firstStarted;
  account = oauthAccount({
    id: "record-b",
    accountId: "workspace-b",
    tokens: { idToken: "identity-b", accessToken: "access-b" },
  });
  const credentialRequest = coordinator.request({
    reason: "credentials",
    executable: "/runtime/codex",
  });
  releaseFirst();

  const [originalResult, credentialResult] = await Promise.all([
    originalRequest,
    credentialRequest,
  ]);
  coordinator.close();
  assert.equal(calls, 2);
  assert.deepEqual(applied, ["workspace-b"], "旧账号请求完成后不能覆盖新账号目录");
  assert.equal(originalResult.officialCatalogError, null);
  assert.equal(credentialResult.officialCatalogError, null);
  assert.deepEqual(scopes.map((scope) => scope.resetTransient), [true, true]);
});

test("后台刷新期间的手动刷新会排队执行，不会被当前请求吞掉", async () => {
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  const applied = [];
  const forced = [];
  let calls = 0;
  const coordinator = new ModelCatalogCoordinator({
    accountManager: {
      getCurrentModelCatalogAccount: async () => oauthAccount(),
    },
    contextManager: {
      dataDir: "/data",
      setModelCatalogScope: async () => {},
      useOfficialCatalog: async (value) => {
        applied.push(value.models[0].slug);
        return { changed: true };
      },
    },
    readRuntimeVersion: readFixtureRuntimeVersion,
    fetchModelCatalog: async ({ force }) => {
      forced.push(force);
      calls++;
      if (calls === 1) {
        markFirstStarted();
        await firstBlocked;
      }
      return { catalog: catalog(`catalog-${calls}`), source: "online" };
    },
  });

  const background = coordinator.request({
    reason: "periodic",
    executable: "/runtime/codex",
  });
  await firstStarted;
  const manual = coordinator.request({
    reason: "manual",
    executable: "/runtime/codex",
    force: true,
  });
  releaseFirst();
  await Promise.all([background, manual]);
  coordinator.close();

  assert.equal(calls, 2);
  assert.deepEqual(forced, [false, true]);
  assert.deepEqual(applied, ["catalog-2"], "新请求到达后不再落地已过时的后台结果");
});

test("同一账号切换 CLI 版本后刷新失败不会保留旧版本内存目录", async (t) => {
  const directory = await useTempDir(t, "catalog-runtime-scope-");
  const contextManager = new CodexContextManager({
    codexHome: join(directory, "codex-home"),
    dataDir: join(directory, "data"),
  });
  await contextManager.initialize();
  let calls = 0;
  const coordinator = new ModelCatalogCoordinator({
    accountManager: {
      getCurrentModelCatalogAccount: async () => oauthAccount(),
    },
    contextManager,
    readRuntimeVersion: readFixtureRuntimeVersion,
    fetchModelCatalog: async ({ clientVersion }) => {
      calls++;
      if (calls === 1) {
        return { catalog: catalog(`runtime-${clientVersion}`), source: "online" };
      }
      throw new Error("fixture runtime-specific refresh failure");
    },
  });
  t.after(() => coordinator.close());

  await coordinator.request({
    executable: "/runtime/codex",
    clientVersion: "0.165.0",
  });
  assert.equal(contextManager.getEffectiveCatalog().models[0].slug, "runtime-0.165.0");

  const failed = await coordinator.request({
    executable: "/runtime/codex",
    clientVersion: "0.166.0",
  });
  assert.match(failed.officialCatalogError, /runtime-specific refresh failure/);
  assert.equal(contextManager.getEffectiveCatalog(), null,
    "新运行时没有同作用域缓存时不得继续使用旧版本目录");
});

test("目录刷新正常每小时一次，失败按 5 分钟、15 分钟、1 小时退避", () => {
  assert.equal(nextModelCatalogRefreshDelay(), MODEL_CATALOG_REFRESH_MS);
  assert.equal(nextModelCatalogRefreshDelay({ failureCount: 1 }), 5 * 60_000);
  assert.equal(nextModelCatalogRefreshDelay({ failureCount: 2 }), 15 * 60_000);
  assert.equal(nextModelCatalogRefreshDelay({ failureCount: 3 }), 60 * 60_000);
  assert.equal(nextModelCatalogRefreshDelay({ failureCount: 8 }), 60 * 60_000);
  assert.equal(nextModelCatalogRefreshDelay({ failureCount: 1, retryAfterMs: 2 * 60 * 60_000 }),
    2 * 60 * 60_000);
  assert.equal(nextModelCatalogRefreshDelay({ failureCount: 1, retryable: false }), null);

});
