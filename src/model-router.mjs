import { createServer, request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import {
  brotliDecompress, gunzip, inflate, zstdDecompress,
  createBrotliDecompress, createGunzip, createInflate,
} from "node:zlib";
import WebSocket, { WebSocketServer } from "ws";

import { startChatCompatibilityProxy } from "./chat-compat-proxy.mjs";
import { GENERATION_METRICS_VERSION } from "./relay-contract.mjs";
import { ResponsesHistory } from "./responses-history.mjs";

export const MODEL_ROUTER_PROVIDER_ID = "codex_quota_router";
export const MODEL_ROUTER_TOKEN_ENV = "CODEX_QUOTA_ROUTER_TOKEN";
export const MODEL_ROUTER_TOKEN_HEADER = "x-codex-quota-router-token";

const DEEPSEEK_MODEL = "deepseek-v4-flash";
const DEEPSEEK_PROVIDER = "deepseek";
const DEEPSEEK_API_BASE_URL = "https://api.deepseek.com/";
const CUSTOM_PROVIDER_PREFIX = "custom_";
const OPENAI_API_BASE_URL = "https://api.openai.com/v1/";
const CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex/";
const MAX_REQUEST_BYTES = 128 * 1024 * 1024;
const REQUEST_DECODERS = new Map([
  ["gzip", promisify(gunzip)],
  ["x-gzip", promisify(gunzip)],
  ["deflate", promisify(inflate)],
  ["br", promisify(brotliDecompress)],
  ["zstd", promisify(zstdDecompress)],
]);
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_REQUEST_START_SKEW_MS = 60 * 60 * 1000;
const THREAD_ROUTE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_THREAD_ROUTES = 4096;
const MAX_TURN_USAGE = 4096;
const MAX_PENDING_TOOL_BATCHES = 4096;
const DEFAULT_ENDPOINT_REUSE_WAIT_MS = 3_000;
const ENDPOINT_REUSE_RETRY_MS = 50;
const DEFAULT_NETWORK_PROBE_INTERVAL_MS = 10_000;
const DEFAULT_NETWORK_PROBE_TIMEOUT_MS = 5_000;
const MAX_NETWORK_SAMPLES = 120;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export class ModelRouterManager {
  constructor({
    officialApiBaseUrl = OPENAI_API_BASE_URL,
    officialCodexBaseUrl = CHATGPT_CODEX_BASE_URL,
    deepSeekBaseUrl = DEEPSEEK_API_BASE_URL,
    endpointReuseWaitMs = DEFAULT_ENDPOINT_REUSE_WAIT_MS,
    networkProbeIntervalMs = DEFAULT_NETWORK_PROBE_INTERVAL_MS,
    networkProbeTimeoutMs = DEFAULT_NETWORK_PROBE_TIMEOUT_MS,
    onRequestShape = null,
  } = {}) {
    this.server = null;
    this.webSocketServer = null;
    this.webSocketConnections = new Set();
    this.port = null;
    this.preferredPort = null;
    this.endpointReuseWaitMs = Math.max(0, Number(endpointReuseWaitMs) || 0);
    this.token = randomBytes(32).toString("base64url");
    this.instanceId = randomUUID();
    this.snapshot = null;
    this.snapshotSignature = null;
    this.chatCompatibilityProxy = null;
    this.usageWriter = null;
    this.usageEventPath = null;
    this.threadRoutes = new Map();
    this.turnUsage = new Map();
    this.pendingToolBatches = new Map();
    this.toolCallBatchKeys = new Map();
    this.networkConnections = new Map();
    this.networkListeners = new Set();
    this.networkState = unavailableNetworkState();
    this.networkRebuildPending = false;
    this.networkProbeIntervalMs = Math.max(10, Number(networkProbeIntervalMs) || 0);
    this.networkProbeTimeoutMs = Math.max(10, Number(networkProbeTimeoutMs) || 0);
    this.closed = false;
    this.officialBaseUrls = {
      apiKey: officialApiBaseUrl,
      oauth: officialCodexBaseUrl,
    };
    this.deepSeekBaseUrl = deepSeekBaseUrl;
    this.onRequestShape = typeof onRequestShape === "function"
      ? onRequestShape
      : null;
  }

  onNetworkChange(listener) {
    if (typeof listener !== "function") return () => {};
    this.networkListeners.add(listener);
    return () => this.networkListeners.delete(listener);
  }

  getNetworkViewModel() {
    return { ...this.networkState };
  }

  async configure({
    deepSeek,
    extraModels,
    officialAuthMode = null,
    usageEventPath = null,
    reusableIdentity = null,
  }) {
    if (this.closed) throw new Error("模型路由器已关闭");
    const normalized = normalizeRoutingConfiguration({
      deepSeek,
      extraModels,
      officialAuthMode,
      deepSeekBaseUrl: this.deepSeekBaseUrl,
    });
    if (normalized.targets.size === 0) {
      await this.disable();
      return null;
    }

    this.#reuseIdentity(reusableIdentity);
    await this.#ensureServer();
    await this.#ensureUsageWriter(usageEventPath);
    if (normalized.signature !== this.snapshotSignature) {
      const replacingSnapshot = this.snapshotSignature !== null;
      const nextCompatibilityProxy = await startChatCompatibilityProxy(normalized.platforms);
      const previousCompatibilityProxy = this.chatCompatibilityProxy;
      this.chatCompatibilityProxy = nextCompatibilityProxy;
      this.snapshot = buildRoutingSnapshot(normalized, nextCompatibilityProxy);
      this.snapshotSignature = normalized.signature;
      this.threadRoutes.clear();
      if (replacingSnapshot) {
        this.#closeWebSocketConnections(1012, "模型路由配置已更新");
      }
      if (previousCompatibilityProxy) {
        void previousCompatibilityProxy.close().catch((error) => {
          console.error(`[model-router] 旧 Chat 兼容代理关闭失败: ${error.message}`);
        });
      }
    } else if (this.snapshot) {
      const authModeChanged = this.snapshot.officialAuthMode !== normalized.officialAuthMode;
      this.snapshot = { ...this.snapshot, officialAuthMode: normalized.officialAuthMode };
      if (authModeChanged) {
        this.#closeWebSocketConnections(1012, "官方账号认证方式已更新");
      }
    }

    return {
      providerId: MODEL_ROUTER_PROVIDER_ID,
      baseUrl: `http://127.0.0.1:${this.port}/${this.token}/v1/`,
      token: this.token,
      tokenEnv: MODEL_ROUTER_TOKEN_ENV,
      tokenHeader: MODEL_ROUTER_TOKEN_HEADER,
      instanceId: this.instanceId,
      legacyProviderIds: [...normalized.legacyProviderIds],
      routedModels: [...normalized.targets.keys()],
    };
  }

  async disable() {
    this.snapshot = null;
    this.snapshotSignature = null;
    this.threadRoutes.clear();
    this.turnUsage.clear();
    this.pendingToolBatches.clear();
    this.toolCallBatchKeys.clear();
    this.#stopAllNetworkMonitors();
    this.#closeWebSocketConnections(1012, "模型路由配置已更新");
    const compatibilityProxy = this.chatCompatibilityProxy;
    this.chatCompatibilityProxy = null;
    if (compatibilityProxy) await compatibilityProxy.close();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const server = this.server;
    const webSocketServer = this.webSocketServer;
    const compatibilityProxy = this.chatCompatibilityProxy;
    const usageWriter = this.usageWriter;
    this.server = null;
    this.webSocketServer = null;
    this.chatCompatibilityProxy = null;
    this.usageWriter = null;
    this.snapshot = null;
    this.pendingToolBatches.clear();
    this.toolCallBatchKeys.clear();
    this.#stopAllNetworkMonitors({ notify: false });
    this.networkListeners.clear();
    this.#closeWebSocketConnections(1001, "模型路由器已关闭");
    server?.closeAllConnections?.();
    await Promise.all([
      server ? closeServer(server) : Promise.resolve(),
      webSocketServer ? closeWebSocketServer(webSocketServer) : Promise.resolve(),
      compatibilityProxy ? compatibilityProxy.close() : Promise.resolve(),
      usageWriter ? usageWriter.close() : Promise.resolve(),
    ]);
  }

  async #ensureServer() {
    if (this.server) return;
    const webSocketServer = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      maxPayload: MAX_REQUEST_BYTES,
    });
    const server = createServer((request, response) => {
      void this.#routeRequest(request, response);
    });
    server.on("upgrade", (request, socket, head) => {
      try {
        const route = authenticatedRoute(request, this.token);
        if (request.method !== "GET" || !isApiPath(route.pathname)) {
          throw httpError(404, "模型路由仅代理 OpenAI API WebSocket");
        }
        if (!this.snapshot) throw httpError(503, "模型路由配置尚未就绪");
        webSocketServer.handleUpgrade(request, socket, head, (client) => {
          webSocketServer.emit("connection", client, request, route);
        });
      } catch (error) {
        rejectUpgrade(socket, error.statusCode ?? 502, error.message);
      }
    });
    webSocketServer.on("connection", (client, request, route) => {
      this.webSocketConnections.add(client);
      client.once("close", () => this.webSocketConnections.delete(client));
      if (isResponsesPath(route.pathname)) {
        this.#routeWebSocket(client, request, route);
      } else {
        this.#proxyWebSocket(client, request, route);
      }
    });
    webSocketServer.on("error", (error) => {
      console.error(`[model-router] WebSocket 服务异常: ${error.message}`);
    });
    server.on("clientError", (_error, socket) => {
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    });
    try {
      await this.#listenOnPreferredPort(server);
    } catch (error) {
      if (this.preferredPort == null || error?.code !== "EADDRINUSE") throw error;
      console.warn(
        `[model-router] 无法接管原端口 ${this.preferredPort}，将使用新端口并要求 Codex 重载`,
      );
      this.preferredPort = null;
      this.token = randomBytes(32).toString("base64url");
      this.instanceId = randomUUID();
      await listen(server, 0);
    }
    const address = server.address();
    if (!address || typeof address === "string") {
      await closeServer(server);
      throw new Error("模型路由器未获取到本地监听端口");
    }
    this.server = server;
    this.webSocketServer = webSocketServer;
    this.port = address.port;
    console.log(`[model-router] 已监听 127.0.0.1:${this.port}`);
  }

  async #listenOnPreferredPort(server) {
    if (this.preferredPort == null) {
      await listen(server, 0);
      return;
    }
    const deadline = Date.now() + this.endpointReuseWaitMs;
    while (true) {
      try {
        await listen(server, this.preferredPort);
        return;
      } catch (error) {
        if (error?.code !== "EADDRINUSE" || Date.now() >= deadline) throw error;
        await delay(Math.min(ENDPOINT_REUSE_RETRY_MS, Math.max(1, deadline - Date.now())));
      }
    }
  }

  #reuseIdentity(value) {
    if (this.server || this.preferredPort != null || !value || typeof value !== "object") return;
    const port = Number(value.port);
    const token = typeof value.token === "string" ? value.token : "";
    const instanceId = typeof value.instanceId === "string" ? value.instanceId : "";
    if (!Number.isInteger(port) || port <= 0 || port > 65_535 ||
      !/^[A-Za-z0-9_-]{32,128}$/.test(token) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(instanceId)) return;
    this.preferredPort = port;
    this.token = token;
    this.instanceId = instanceId;
  }

  async #ensureUsageWriter(path) {
    const normalizedPath = String(path ?? "").trim() || null;
    if (normalizedPath === this.usageEventPath && this.usageWriter) return;
    const previousWriter = this.usageWriter;
    this.usageEventPath = normalizedPath;
    this.usageWriter = createUsageEventWriter(normalizedPath);
    if (previousWriter) await previousWriter.close();
  }

  async #routeRequest(request, response) {
    try {
      const route = authenticatedRoute(request, this.token);
      const snapshot = this.snapshot;
      if (!snapshot) throw httpError(503, "模型路由配置尚未就绪");
      if (!isApiPath(route.pathname)) {
        throw httpError(404, "模型路由仅代理 OpenAI API 请求");
      }
      if (request.method === "POST" && isResponsesPath(route.pathname)) {
        const payload = await readRequestBody(request);
        const body = await parseRequestJson(payload, request.headers, { required: true });
        const context = this.#createRequestContext(body, request.headers);
        // Official traffic keeps its exact wire representation. Decoding is
        // only for route selection and observation, never for forwarding.
        let prepared = payload;
        if (context.target.kind !== "official") {
          const preparedBody = prepareCustomRequest(body, context.target);
          context.requestShape = customRequestShape(preparedBody);
          prepared = Buffer.from(JSON.stringify(preparedBody));
        }
        this.onRequestShape?.({
          path: route.pathname,
          targetKind: context.target.kind,
          routeKey: context.target.routeKey,
          shape: structuredClone(context.requestShape ?? customRequestShape(body)),
        });
        const targetUrl = apiTargetUrl(
          context.target,
          route.pathname,
          route.incoming.search,
        );
        let routeClaim = null;
        try {
          routeClaim = this.#activateRequestContext(context);
          const accepted = await this.#forwardResponse(
            request,
            response,
            targetUrl,
            prepared,
            context.target,
            context,
          );
          this.#settleThreadRoute(routeClaim, accepted);
          routeClaim = null;
        } finally {
          this.#settleThreadRoute(routeClaim, false);
        }
        return;
      }
      await this.#forwardApiRequest(request, response, route, snapshot);
    } catch (error) {
      writeError(response, error.statusCode ?? 502, error.message);
    }
  }

  async #forwardApiRequest(request, response, route, snapshot) {
    const requestStartedAt = Date.now();
    const payload = await readRequestBody(request);
    const body = await parseRequestJson(payload, request.headers);
    const target = isModelsPath(route.pathname)
      ? officialTarget(snapshot, request.headers, this.officialBaseUrls)
      : this.#resolveAuxiliaryTarget(body, request.headers, snapshot);
    const observationContext = this.#createAuxiliaryObservationContext(
      body,
      request.headers,
      target,
      requestStartedAt,
    );
    const targetUrl = apiTargetUrl(target, route.pathname, route.incoming.search);
    this.onRequestShape?.({
      path: route.pathname,
      targetKind: target.kind,
      routeKey: target.routeKey,
      shape: structuredClone(customRequestShape(body)),
    });
    const headers = rawRequestHeaders(request.headers, target, payload.length);
    const transport = targetUrl.protocol === "https:" ? requestHttps : requestHttp;
    await new Promise((resolve) => {
      const upstream = transport(targetUrl, {
        method: request.method,
        headers,
      }, (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          responseHeaders(upstreamResponse.headers),
        );
        if ((upstreamResponse.statusCode ?? 502) >= 200 &&
          (upstreamResponse.statusCode ?? 502) < 300 && observationContext) {
          // Auxiliary and future endpoints remain byte-for-byte transparent.
          // When their response carries the standard usage structure, observe
          // it from a side stream instead of relying on Codex to persist it.
          observeResponse(upstreamResponse, {
            requestStartedAt: observationContext.requestStartedAt,
            onUsage: (usage, responseId) =>
              this.#recordUsage(observationContext, usage, responseId),
            onToolCall: () => {},
            onGeneration: () => {},
          });
        }
        upstreamResponse.once("error", (error) => {
          if (!response.destroyed) response.destroy(error);
          resolve();
        });
        upstreamResponse.once("end", resolve);
        upstreamResponse.once("close", resolve);
        upstreamResponse.pipe(response);
      });
      upstream.once("error", (error) => {
        writeError(response, 502, `模型上游请求失败：${error.message}`);
        resolve();
      });
      response.once("close", () => {
        if (!response.writableFinished) upstream.destroy();
      });
      upstream.end(payload);
    });
  }

  #resolveAuxiliaryTarget(body, headers, snapshot = this.snapshot) {
    if (!snapshot) throw httpError(503, "模型路由配置尚未就绪");
    const model = nonEmptyString(body?.model);
    if (model) {
      return snapshot.targets.get(model) ??
        officialTarget(snapshot, headers, this.officialBaseUrls);
    }
    const threadId = requestThreadId(body, headers);
    const remembered = threadId ? this.threadRoutes.get(threadId) : null;
    return remembered
      ? snapshot.targets.get(remembered.model) ??
        officialTarget(snapshot, headers, this.officialBaseUrls)
      : officialTarget(snapshot, headers, this.officialBaseUrls);
  }

  #createAuxiliaryObservationContext(body, headers, target, requestStartedAt) {
    if (!body || typeof body !== "object") return null;
    const metadata = body.client_metadata && typeof body.client_metadata === "object"
      ? body.client_metadata
      : null;
    const threadId = requestThreadId(body, headers);
    const turnId = nonEmptyString(metadata?.turn_id) ??
      turnIdFromMetadata(metadata) ??
      turnIdFromHeaders(headers);
    const remembered = threadId ? this.threadRoutes.get(threadId) : null;
    const model = nonEmptyString(body.model) ?? nonEmptyString(remembered?.model);
    if (!threadId || !turnId || !model) return null;
    return {
      target,
      threadId,
      turnId,
      model,
      // Auxiliary response usage is authoritative because older Codex builds
      // do not consistently persist it. A response-level rollout record, when
      // present, is reconciled against the same turn cumulative total.
      rolloutUsageFallback: false,
      requestStartedAt,
      requestId: randomUUID(),
    };
  }

  #proxyWebSocket(client, request, route) {
    let upstream;
    try {
      const target = this.#resolveAuxiliaryTarget(null, request.headers);
      const targetUrl = webSocketApiTargetUrl(
        target,
        route.pathname,
        route.incoming.search,
      );
      upstream = new WebSocket(targetUrl, webSocketProtocols(request.headers), {
        headers: upstreamWebSocketHeaders(request.headers, target),
        maxPayload: MAX_REQUEST_BYTES,
        perMessageDeflate: true,
        handshakeTimeout: 15_000,
      });
    } catch {
      client.close(1011, "模型路由失败");
      return;
    }

    const pending = [];
    let pendingBytes = 0;
    let upstreamOpen = false;
    let clientClosed = false;
    let upstreamClosed = false;

    const closeUpstream = (code, reason) => {
      if (upstreamClosed) return;
      upstreamClosed = true;
      if (upstream.readyState === WebSocket.CONNECTING) {
        upstream.terminate();
      } else if (upstream.readyState === WebSocket.OPEN) {
        upstream.close(validWebSocketCloseCode(code) ? code : 1000, reason);
      }
    };
    const closeClient = (code, reason) => {
      if (clientClosed) return;
      clientClosed = true;
      if (client.readyState === WebSocket.OPEN) {
        client.close(validWebSocketCloseCode(code) ? code : 1011, reason);
      }
    };

    client.on("message", (data, isBinary) => {
      if (upstreamOpen) {
        sendWebSocketData(upstream, data, isBinary);
        return;
      }
      pendingBytes += webSocketDataLength(data);
      if (pendingBytes > MAX_REQUEST_BYTES) {
        closeClient(1009, "WebSocket 待转发数据过大");
        closeUpstream(1009, "WebSocket 待转发数据过大");
        return;
      }
      pending.push({ data, isBinary });
    });
    client.once("close", (code, reason) => {
      clientClosed = true;
      closeUpstream(code, reason);
    });
    client.once("error", () => closeUpstream(1011, "本地 WebSocket 连接异常"));

    upstream.once("open", () => {
      upstreamOpen = true;
      for (const message of pending.splice(0)) {
        if (!sendWebSocketData(upstream, message.data, message.isBinary)) break;
      }
      pendingBytes = 0;
    });
    upstream.on("message", (data, isBinary) => {
      sendWebSocketData(client, data, isBinary);
    });
    upstream.once("close", (code, reason) => {
      upstreamClosed = true;
      closeClient(code, reason);
    });
    upstream.once("error", () => {
      closeClient(1011, "官方 WebSocket 连接失败");
    });
  }

  #routeWebSocket(client, request, route) {
    const observations = createWebSocketObservationQueue();
    const customRequests = new Map();
    const customHistory = new ResponsesHistory();
    const networkConnectionId = randomUUID();
    let officialSocket = null;
    let officialOpen = null;
    let messageTail = Promise.resolve();
    let closed = false;

    const closeUpstreams = () => {
      if (closed) return;
      closed = true;
      for (const bridge of customRequests.values()) bridge.cancel();
      customRequests.clear();
      if (officialSocket && officialSocket.readyState < WebSocket.CLOSING) {
        officialSocket.close(1000, "本地客户端已关闭");
      }
    };

    const ensureOfficialSocket = (target) => {
      if (officialOpen) return officialOpen;
      const targetUrl = webSocketTargetUrl(target, route.incoming.search);
      officialSocket = new WebSocket(targetUrl, webSocketProtocols(request.headers), {
        headers: upstreamWebSocketHeaders(request.headers, target),
        maxPayload: MAX_REQUEST_BYTES,
        perMessageDeflate: true,
        handshakeTimeout: 15_000,
      });
      officialOpen = new Promise((resolve, reject) => {
        const onOpen = () => {
          officialSocket.off("error", onInitialError);
          this.#startNetworkMonitor(officialSocket, networkConnectionId);
          resolve(officialSocket);
        };
        const onInitialError = (error) => {
          officialSocket.off("open", onOpen);
          this.#stopNetworkMonitor(networkConnectionId, { unexpected: true });
          reject(error);
        };
        officialSocket.once("open", onOpen);
        officialSocket.once("error", onInitialError);
      });
      officialSocket.on("message", (data, isBinary) => {
        if (!isBinary) observations.accept(parseWebSocketJson(data));
        sendWebSocketData(client, data, isBinary);
      });
      officialSocket.on("close", (code, reason) => {
        this.#stopNetworkMonitor(networkConnectionId, { unexpected: !closed });
        observations.abortAll();
        if (client.readyState === WebSocket.OPEN) {
          client.close(validWebSocketCloseCode(code) ? code : 1011, reason);
        }
      });
      officialSocket.on("error", () => {
        // The opening promise or close event reports the failure to Codex.
      });
      return officialOpen;
    };

    const routeMessage = async (data, isBinary) => {
      if (isBinary) throw httpError(400, "Responses WebSocket 仅接受 JSON 文本帧");
      const body = parseWebSocketJson(data);
      if (!body) throw httpError(400, "无法解析 Responses WebSocket JSON");
      if (body.type !== "response.create") {
        const lane = customRequests.get(webSocketLane(body.stream_id));
        if (body.type === "response.cancel" && lane) {
          lane.cancel();
          return;
        }
        const upstream = await ensureOfficialSocket(
          officialTarget(this.snapshot, request.headers, this.officialBaseUrls),
        );
        upstream.send(data, { binary: false });
        return;
      }

      const context = this.#createRequestContext(body, request.headers, Date.now(), {
        networkConnectionId,
      });
      const streamId = normalizedStreamId(body.stream_id);
      if (context.target.kind === "official") {
        this.onRequestShape?.({
          path: route.pathname,
          targetKind: context.target.kind,
          routeKey: context.target.routeKey,
          shape: structuredClone(customRequestShape(body)),
        });
        if (body.generate === false) {
          // Prewarm still has a terminal response on the same WebSocket lane.
          // Keep a queue entry so that response cannot consume the following
          // real request's observation, but deliberately emit no metrics.
          const entry = observations.add(streamId, ignoredResponseObservation());
          try {
            const upstream = await ensureOfficialSocket(context.target);
            upstream.send(data, { binary: false });
          } catch (error) {
            observations.remove(entry);
            throw error;
          }
          return;
        }
        const observation = createResponseObservation({
          requestStartedAt: context.requestStartedAt,
          requireCompleted: true,
          onUsage: (usage, responseId) => this.#recordUsage(context, usage, responseId),
          onToolCall: (call) => this.#recordPendingToolCall(context, call),
          onGeneration: (generation) => this.#recordGeneration(context, {
            ...generation,
            requestId: context.requestId,
          }),
        });
        let routeClaim = this.#activateRequestContext(context);
        const settleRoute = (accepted) => {
          this.#settleThreadRoute(routeClaim, accepted);
          routeClaim = null;
        };
        const entry = observations.add(streamId, observation, {
          onAccepted: () => settleRoute(true),
          onRejected: () => settleRoute(false),
        });
        try {
          const upstream = await ensureOfficialSocket(context.target);
          upstream.send(data, { binary: false });
        } catch (error) {
          observations.remove(entry);
          throw error;
        }
        return;
      }

      if (body.generate === false) {
        const expanded = customHistory.expand(body, context.target.routeKey);
        const completed = sendWebSocketPrewarm(client, body, streamId);
        customHistory.remember(expanded, completed, context.target.routeKey);
        return;
      }
      const laneKey = webSocketLane(streamId);
      if (customRequests.has(laneKey)) {
        throw httpError(409, "同一 WebSocket 通道已有自定义模型请求正在执行");
      }
      let bridge;
      let routeClaim = null;
      const settleRoute = (accepted) => {
        this.#settleThreadRoute(routeClaim, accepted);
        routeClaim = null;
      };
      const expanded = customHistory.expand(body, context.target.routeKey);
      try {
        bridge = startHttpWebSocketBridge({
          client,
          sourceHeaders: request.headers,
          search: route.incoming.search,
          body: expanded,
          target: context.target,
          context,
          streamId,
          onUsage: (usage, responseId) => this.#recordUsage(context, usage, responseId),
          onToolCall: (call) => this.#recordPendingToolCall(context, call),
          onGeneration: (generation) => this.#recordGeneration(context, {
            ...generation,
            requestId: context.requestId,
          }),
          onResponse: response => customHistory.remember(expanded, response, context.target.routeKey),
          onRequestShape: shape => this.onRequestShape?.({
            path: route.pathname,
            targetKind: context.target.kind,
            routeKey: context.target.routeKey,
            shape: structuredClone(shape),
          }),
          onPrepared: () => { routeClaim = this.#activateRequestContext(context); },
          onAccepted: () => settleRoute(true),
          onDone: () => {
            settleRoute(false);
            if (customRequests.get(laneKey) === bridge) customRequests.delete(laneKey);
          },
        });
      } catch (error) {
        settleRoute(false);
        throw error;
      }
      customRequests.set(laneKey, bridge);
    };

    client.on("message", (data, isBinary) => {
      messageTail = messageTail.then(() => routeMessage(data, isBinary)).catch((error) => {
        const failedBody = isBinary ? null : parseWebSocketJson(data);
        sendWebSocketFailure(
          client,
          failedBody,
          normalizedStreamId(failedBody?.stream_id),
          error.message,
        );
      });
    });
    client.once("close", closeUpstreams);
    client.once("error", closeUpstreams);
  }

  #closeWebSocketConnections(code, reason) {
    for (const client of this.webSocketConnections) {
      if (client.readyState >= WebSocket.CLOSING) continue;
      client.close(code, reason);
      const timer = setTimeout(() => {
        if (client.readyState !== WebSocket.CLOSED) client.terminate();
      }, 500);
      timer.unref?.();
    }
  }

  #startNetworkMonitor(socket, connectionId) {
    const normalizedConnectionId = nonEmptyString(connectionId);
    if (!normalizedConnectionId || socket.readyState !== WebSocket.OPEN) return;
    const rebuilt = this.networkRebuildPending;
    this.networkRebuildPending = false;
    const state = {
      connectionId: normalizedConnectionId,
      socket,
      samples: [],
      interval: null,
      pending: null,
      onPong: null,
      rebuilt,
      current: {
        status: rebuilt ? "reconnected" : "measuring",
        latencyMs: null,
        sampledAt: Date.now(),
        connectionId: normalizedConnectionId,
      },
    };
    state.onPong = (payload) => {
      const pending = state.pending;
      if (!pending || Buffer.from(payload).toString("utf8") !== pending.payload) return;
      clearTimeout(pending.timeout);
      state.pending = null;
      const sampledAt = Date.now();
      const latencyMs = Math.max(1, sampledAt - pending.startedAt);
      const previousLatencies = state.samples
        .map((sample) => Number(sample.latencyMs))
        .filter((value) => Number.isFinite(value) && value >= 0);
      const sample = {
        status: state.rebuilt
          ? "reconnected"
          : classifyNetworkLatency(previousLatencies, latencyMs),
        latencyMs,
        sampledAt,
        connectionId: normalizedConnectionId,
      };
      state.rebuilt = false;
      state.samples.push(sample);
      if (state.samples.length > MAX_NETWORK_SAMPLES) {
        state.samples.splice(0, state.samples.length - MAX_NETWORK_SAMPLES);
      }
      state.current = sample;
      this.#setNetworkState(sample);
    };
    socket.on("pong", state.onPong);
    this.networkConnections.set(normalizedConnectionId, state);
    this.#setNetworkState(state.current);
    this.#probeNetworkConnection(state);
    state.interval = setInterval(
      () => this.#probeNetworkConnection(state),
      this.networkProbeIntervalMs,
    );
    state.interval.unref?.();
  }

  #probeNetworkConnection(state) {
    if (!state || state.pending || state.socket.readyState !== WebSocket.OPEN) return;
    const payload = `cqi-rtt:${randomBytes(8).toString("hex")}`;
    const startedAt = Date.now();
    const timeout = setTimeout(() => {
      if (state.pending?.payload !== payload) return;
      state.pending = null;
      const sample = {
        status: "fluctuating",
        latencyMs: null,
        sampledAt: Date.now(),
        connectionId: state.connectionId,
      };
      state.samples.push(sample);
      if (state.samples.length > MAX_NETWORK_SAMPLES) {
        state.samples.splice(0, state.samples.length - MAX_NETWORK_SAMPLES);
      }
      state.current = sample;
      this.#setNetworkState(sample);
    }, this.networkProbeTimeoutMs);
    timeout.unref?.();
    state.pending = { payload, startedAt, timeout };
    try {
      state.socket.ping(payload);
    } catch {
      clearTimeout(timeout);
      state.pending = null;
      const sample = {
        status: "fluctuating",
        latencyMs: null,
        sampledAt: Date.now(),
        connectionId: state.connectionId,
      };
      state.samples.push(sample);
      if (state.samples.length > MAX_NETWORK_SAMPLES) {
        state.samples.splice(0, state.samples.length - MAX_NETWORK_SAMPLES);
      }
      state.current = sample;
      this.#setNetworkState(sample);
    }
  }

  #stopNetworkMonitor(connectionId, { unexpected = false } = {}) {
    const normalizedConnectionId = nonEmptyString(connectionId);
    const state = normalizedConnectionId
      ? this.networkConnections.get(normalizedConnectionId)
      : null;
    if (state) {
      clearInterval(state.interval);
      if (state.pending) clearTimeout(state.pending.timeout);
      state.socket.off("pong", state.onPong);
      this.networkConnections.delete(normalizedConnectionId);
    }
    if (this.networkConnections.size > 0) {
      const current = [...this.networkConnections.values()]
        .sort((left, right) => right.current.sampledAt - left.current.sampledAt)[0]?.current;
      if (current) this.#setNetworkState(current);
      return;
    }
    if (unexpected) {
      this.networkRebuildPending = true;
      this.#setNetworkState({
        status: "reconnecting",
        latencyMs: null,
        sampledAt: Date.now(),
        connectionId: normalizedConnectionId,
      });
      return;
    }
    this.#setNetworkState(unavailableNetworkState());
  }

  #stopAllNetworkMonitors({ notify = true } = {}) {
    for (const state of this.networkConnections.values()) {
      clearInterval(state.interval);
      if (state.pending) clearTimeout(state.pending.timeout);
      state.socket.off("pong", state.onPong);
    }
    this.networkConnections.clear();
    this.networkRebuildPending = false;
    if (notify) this.#setNetworkState(unavailableNetworkState());
    else this.networkState = unavailableNetworkState();
  }

  #setNetworkState(value) {
    const next = normalizeNetworkState(value);
    if (JSON.stringify(next) === JSON.stringify(this.networkState)) return;
    this.networkState = next;
    for (const listener of this.networkListeners) {
      try {
        listener({ ...next });
      } catch (error) {
        console.error(`[model-router] 网络状态监听器失败: ${error.message}`);
      }
    }
  }

  #nearestNetworkSample(connectionId, timestamp) {
    const state = this.networkConnections.get(nonEmptyString(connectionId));
    if (!state || state.samples.length === 0) return null;
    const targetAt = Number(timestamp) || Date.now();
    const sample = [...state.samples].sort((left, right) =>
      Math.abs(left.sampledAt - targetAt) - Math.abs(right.sampledAt - targetAt))[0];
    return sample ? { ...sample } : null;
  }

  #createRequestContext(
    body,
    headers,
    requestStartedAt = Date.now(),
    { networkConnectionId = null } = {},
  ) {
    const snapshot = this.snapshot;
    if (!snapshot) throw httpError(503, "模型路由配置尚未就绪");
    const model = nonEmptyString(body?.model);
    if (!model) throw httpError(400, "Responses 请求缺少模型 ID");
    const target = snapshot.targets.get(model) ??
      officialTarget(snapshot, headers, this.officialBaseUrls);
    const metadata = body?.client_metadata && typeof body.client_metadata === "object"
      ? body.client_metadata
      : null;
    const threadId = requestThreadId(body, headers);
    const turnId = nonEmptyString(metadata?.turn_id) ??
      turnIdFromMetadata(metadata) ??
      turnIdFromHeaders(headers);
    const rolloutUsageFallback = target.kind === "official";
    const effectiveRequestStartedAt = requestStartFromMetadata(metadata, requestStartedAt);
    const measuredConnectionId = target.kind === "official"
      ? nonEmptyString(networkConnectionId)
      : null;
    const networkLatency = measuredConnectionId
      ? this.#nearestNetworkSample(measuredConnectionId, effectiveRequestStartedAt)
      : null;
    const generates = body?.generate !== false;
    return {
      target,
      threadId,
      turnId,
      model,
      generates,
      input: body?.input,
      followsToolResult: containsCallReference(body?.input),
      rolloutUsageFallback,
      requestStartedAt: effectiveRequestStartedAt,
      requestId: randomUUID(),
      networkLatencySupported: Boolean(measuredConnectionId),
      networkConnectionId: measuredConnectionId,
      networkLatency,
    };
  }

  #activateRequestContext(context) {
    if (!context.generates) return null;
    const routeClaim = this.#reserveThreadRoute(context);
    try {
      this.#recordCompletedToolCalls(
        context.input,
        context.threadId,
        context.requestStartedAt,
      );
      const {
        threadId,
        turnId,
        model,
        rolloutUsageFallback,
        networkLatencySupported,
        networkConnectionId,
        networkLatency,
      } = context;
      if (turnId) {
        this.usageWriter?.write({
          type: "thread-active",
          threadId,
          model,
          modelSource: "turn-request",
          rolloutUsageFallback,
        });
        this.usageWriter?.write({
          type: "turn-started",
          threadId,
          turnId,
          model,
          modelSource: "turn-request",
          rolloutUsageFallback,
          generationMetricsVersion: GENERATION_METRICS_VERSION,
          networkLatencySupported,
          networkConnectionId,
          networkLatency,
        });
      }
      return routeClaim;
    } catch (error) {
      this.#settleThreadRoute(routeClaim, false);
      throw error;
    }
  }

  #reserveThreadRoute({ threadId, target, model, requestId }) {
    if (!threadId) return;
    const routeKey = target.routeKey;
    const previous = this.threadRoutes.get(threadId);
    if (previous && previous.routeKey !== routeKey) {
      throw httpError(
        409,
        `同一任务不能切换模型供应商（${previous.model} → ${model}）；请新建任务后再选择目标模型`,
      );
    }
    const claim = { threadId, routeKey, model, requestId };
    const route = previous ?? {
      routeKey,
      model,
      confirmed: false,
      pending: new Map(),
      updatedAt: Date.now(),
    };
    route.pending.set(requestId, { model, updatedAt: Date.now() });
    if (!route.confirmed) route.model = model;
    route.updatedAt = Date.now();
    this.threadRoutes.delete(threadId);
    this.threadRoutes.set(threadId, route);
    this.#pruneState();
    return claim;
  }

  #settleThreadRoute(claim, accepted) {
    if (!claim?.threadId) return;
    const route = this.threadRoutes.get(claim.threadId);
    if (!route || route.routeKey !== claim.routeKey ||
      !route.pending.has(claim.requestId)) return;
    route.pending.delete(claim.requestId);
    if (accepted) {
      route.confirmed = true;
      route.model = claim.model;
      route.updatedAt = Date.now();
      this.threadRoutes.delete(claim.threadId);
      this.threadRoutes.set(claim.threadId, route);
      this.#pruneState();
      return;
    }
    if (route.confirmed) return;
    if (route.pending.size === 0) {
      this.threadRoutes.delete(claim.threadId);
      return;
    }
    route.model = [...route.pending.values()].at(-1).model;
  }

  #pruneState() {
    const cutoff = Date.now() - THREAD_ROUTE_TTL_MS;
    for (const [threadId, route] of this.threadRoutes) {
      if (route.updatedAt >= cutoff && this.threadRoutes.size <= MAX_THREAD_ROUTES) break;
      this.threadRoutes.delete(threadId);
    }
    while (this.turnUsage.size > MAX_TURN_USAGE) {
      this.turnUsage.delete(this.turnUsage.keys().next().value);
    }
    for (const [key, batch] of this.pendingToolBatches) {
      if (batch.readyAt >= cutoff &&
        this.pendingToolBatches.size <= MAX_PENDING_TOOL_BATCHES) break;
      this.#deletePendingToolBatch(key, batch);
    }
  }

  async #forwardResponse(request, response, targetUrl, payload, target, context) {
    const headers = target.kind === "official"
      ? rawRequestHeaders(request.headers, target, payload.length)
      : requestHeaders(request.headers, target, payload.length);
    const transport = targetUrl.protocol === "https:" ? requestHttps : requestHttp;
    return new Promise((resolve) => {
      let accepted = false;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve(accepted);
      };
      const upstream = transport(targetUrl, {
        method: "POST",
        headers,
      }, (upstreamResponse) => {
        const statusCode = upstreamResponse.statusCode ?? 502;
        accepted = statusCode >= 200 && statusCode < 300;
        if (statusCode >= 400 && target.kind === "custom") {
          console.error(
            `[model-router] ${target.displayName} 上游返回 ${statusCode}；` +
            `脱敏请求结构=${JSON.stringify(context.requestShape ?? null)}`,
          );
        }
        response.writeHead(
          statusCode,
          responseHeaders(upstreamResponse.headers),
        );
        if (accepted) {
          observeResponse(upstreamResponse, {
            requestStartedAt: context.requestStartedAt,
            onUsage: (usage, responseId) => this.#recordUsage(context, usage, responseId),
            onToolCall: (call) => this.#recordPendingToolCall(context, call),
            onGeneration: (generation) => this.#recordGeneration(context, {
              ...generation,
              requestId: context.requestId,
            }),
            onFailure: target.kind === "custom" ? () => {
              console.error(
                `[model-router] ${target.displayName} 上游响应失败；` +
                `脱敏请求结构=${JSON.stringify(context.requestShape ?? null)}`,
              );
            } : undefined,
          });
        }
        upstreamResponse.once("error", (error) => {
          if (!response.destroyed) response.destroy(error);
          finish();
        });
        upstreamResponse.once("end", finish);
        upstreamResponse.once("close", finish);
        upstreamResponse.pipe(response);
      });
      upstream.once("error", (error) => {
        writeError(response, 502, `模型上游请求失败：${error.message}`);
        finish();
      });
      response.once("close", () => {
        if (!response.writableFinished) {
          upstream.destroy();
          finish();
        }
      });
      upstream.end(payload);
    });
  }

  #recordUsage(context, usage, responseId = null) {
    if (!context.threadId || !context.turnId) return;
    // Official Codex writes the same response usage to rollout. Keep that
    // response-level ledger authoritative; TokenUsageManager pairs and ignores
    // the legacy token_count summary that follows it.
    if (context.rolloutUsageFallback) return;
    const key = `${context.threadId}\u0000${context.turnId}`;
    const total = this.turnUsage.get(key) ?? emptyUsage();
    addUsage(total, usage);
    this.turnUsage.delete(key);
    this.turnUsage.set(key, total);
    const usageResponseId = nonEmptyString(responseId) ??
      `router-request:${context.requestId}`;
    this.usageWriter?.write({
      type: "usage",
      threadId: context.threadId,
      turnId: context.turnId,
      model: context.model,
      modelSource: "usage",
      rolloutUsageFallback: context.rolloutUsageFallback,
      responseId: usageResponseId,
      tokenUsage: { last: usage, total },
    });
    this.#pruneState();
  }

  #recordGeneration(context, generation) {
    if (!context.threadId || !context.turnId) return;
    const networkLatency = context.networkLatencySupported
      ? this.#nearestNetworkSample(context.networkConnectionId, context.requestStartedAt) ??
        context.networkLatency
      : null;
    this.usageWriter?.write({
      type: "generation",
      threadId: context.threadId,
      turnId: context.turnId,
      model: context.model,
      modelSource: "generation",
      generationMetricsVersion: GENERATION_METRICS_VERSION,
      generation: {
        ...generation,
        responseId: nonEmptyString(generation?.responseId) ??
          `router-request:${context.requestId}`,
        followsToolResult: context.followsToolResult,
        networkLatency,
      },
    });
  }

  #recordPendingToolCall(context, call) {
    if (!context.threadId || !context.turnId || !call?.referenceId) return;
    const batchKey = pendingToolBatchKey(context.threadId, context.requestId);
    const batch = this.pendingToolBatches.get(batchKey) ?? {
      threadId: context.threadId,
      turnId: context.turnId,
      requestId: context.requestId,
      requestStartedAt: context.requestStartedAt,
      toolNames: new Set(),
      calls: new Map(),
      preparationStartedAt: Number(call.preparationStartedAt) || null,
      readyAt: Number(call.readyAt) || Date.now(),
      allReadyAt: Number(call.readyAt) || Date.now(),
    };
    const readyAt = Number(call.readyAt) || Date.now();
    const preparationStartedAt = Number(call.preparationStartedAt) || null;
    if (preparationStartedAt) {
      batch.preparationStartedAt = batch.preparationStartedAt
        ? Math.min(batch.preparationStartedAt, preparationStartedAt)
        : preparationStartedAt;
    }
    batch.readyAt = Math.min(batch.readyAt, readyAt);
    batch.allReadyAt = Math.max(batch.allReadyAt, readyAt);
    const toolName = nonEmptyString(call.toolName);
    if (toolName) batch.toolNames.add(toolName);
    batch.calls.set(call.referenceId, {
      referenceId: call.referenceId,
      toolName,
      preparationStartedAt,
      readyAt,
      completedAt: null,
    });
    this.pendingToolBatches.delete(batchKey);
    this.pendingToolBatches.set(batchKey, batch);
    this.toolCallBatchKeys.set(
      pendingToolCallKey(context.threadId, call.referenceId),
      batchKey,
    );
    this.#pruneState();
  }

  #recordCompletedToolCalls(input, threadId, completedAt) {
    if (!threadId) return;
    const completedBatchKeys = new Set();
    for (const referenceId of collectCallReferenceIds(input)) {
      const referenceKey = pendingToolCallKey(threadId, referenceId);
      const batchKey = this.toolCallBatchKeys.get(referenceKey);
      const batch = batchKey ? this.pendingToolBatches.get(batchKey) : null;
      if (!batch) continue;
      const call = batch.calls.get(referenceId);
      if (call) call.completedAt = completedAt;
      this.toolCallBatchKeys.delete(referenceKey);
      if ([...batch.calls.values()].every((value) => value.completedAt != null)) {
        completedBatchKeys.add(batchKey);
      }
    }
    for (const batchKey of completedBatchKeys) {
      const batch = this.pendingToolBatches.get(batchKey);
      if (!batch) continue;
      const calls = [...batch.calls.values()];
      const batchCompletedAt = Math.max(...calls.map((call) => call.completedAt), completedAt);
      this.usageWriter?.write({
        type: "generation-tool-timing",
        threadId: batch.threadId,
        turnId: batch.turnId,
        modelSource: "generation",
        generationMetricsVersion: GENERATION_METRICS_VERSION,
        requestId: batch.requestId,
        toolTiming: {
          toolNames: [...batch.toolNames],
          toolCount: calls.length,
          readyLatencyMs: Math.max(0, batch.allReadyAt - batch.requestStartedAt),
          preparationStartLatencyMs: batch.preparationStartedAt
            ? Math.max(0, batch.preparationStartedAt - batch.requestStartedAt)
            : null,
          preparationDurationMs: batch.preparationStartedAt
            ? Math.max(0, batch.allReadyAt - batch.preparationStartedAt)
            : null,
          durationMs: Math.max(0, batchCompletedAt - batch.readyAt),
          calls: calls.map((call) => ({
            toolName: call.toolName,
            preparationDurationMs: call.preparationStartedAt
              ? Math.max(0, call.readyAt - call.preparationStartedAt)
              : null,
            durationMs: Math.max(0, call.completedAt - call.readyAt),
          })),
        },
      });
      this.#deletePendingToolBatch(batchKey, batch);
    }
  }

  #deletePendingToolBatch(batchKey, batch) {
    this.pendingToolBatches.delete(batchKey);
    for (const referenceId of batch.calls.keys()) {
      this.toolCallBatchKeys.delete(pendingToolCallKey(batch.threadId, referenceId));
    }
  }
}

function normalizeRoutingConfiguration({
  deepSeek,
  extraModels,
  officialAuthMode,
  deepSeekBaseUrl = DEEPSEEK_API_BASE_URL,
}) {
  const targets = new Map();
  const legacyProviderIds = new Set();
  const platforms = new Map();
  if (deepSeek?.enabled && deepSeek?.configured && deepSeek.apiKey) {
    targets.set(DEEPSEEK_MODEL, {
      kind: "custom",
      routeKey: DEEPSEEK_PROVIDER,
      baseUrl: deepSeekBaseUrl,
      apiKey: String(deepSeek.apiKey),
      displayName: deepSeek.model?.displayName ?? DEEPSEEK_MODEL,
      supportsImage: false,
      reasoningEfforts: Array.isArray(deepSeek.model?.reasoningEfforts)
        ? deepSeek.model.reasoningEfforts
        : ["low", "high", "max"],
      defaultReasoningEffort: "high",
    });
    legacyProviderIds.add(DEEPSEEK_PROVIDER);
  }
  for (const value of Array.isArray(extraModels?.platforms) ? extraModels.platforms : []) {
    const id = nonEmptyString(value?.id);
    const baseUrl = nonEmptyString(value?.baseUrl);
    const apiKey = nonEmptyString(value?.apiKey);
    const models = Array.isArray(value?.models) ? value.models : [];
    if (!id || !baseUrl || !apiKey || !value.enabled || models.length === 0) continue;
    const providerId = customProviderId(id);
    const platform = {
      id,
      providerId,
      name: nonEmptyString(value.name) ?? providerId,
      baseUrl,
      apiKey,
      enabled: true,
      models: models.map(normalizeModel).filter((model) => model.id),
    };
    if (platform.models.length === 0) continue;
    platforms.set(id, platform);
    legacyProviderIds.add(providerId);
  }
  for (const platform of platforms.values()) {
    for (const model of platform.models) {
      targets.set(model.id, {
        kind: "custom",
        routeKey: platform.providerId,
        baseUrl: platform.baseUrl,
        apiKey: platform.apiKey,
        displayName: model.displayName,
        supportsImage: model.supportsImage,
        reasoningEfforts: model.reasoningEfforts,
        defaultReasoningEffort: model.defaultReasoningEffort,
        platform,
      });
    }
  }
  return {
    targets,
    legacyProviderIds,
    platforms,
    officialAuthMode: ["oauth", "apiKey"].includes(officialAuthMode)
      ? officialAuthMode
      : null,
    signature: JSON.stringify({
      deepSeek: deepSeek?.enabled && deepSeek?.configured && deepSeek?.apiKey
        ? {
            enabled: true,
            apiKey: deepSeek.apiKey,
            model: deepSeek.model ?? null,
          }
        : null,
      platforms: [...platforms.values()],
    }),
  };
}

function buildRoutingSnapshot(normalized, compatibilityProxy) {
  const targets = new Map();
  for (const [model, target] of normalized.targets) {
    const baseUrl = target.platform && compatibilityProxy
      ? compatibilityProxy.baseUrlFor(target.platform)
      : target.baseUrl;
    targets.set(model, { ...target, baseUrl });
  }
  return {
    targets,
    officialAuthMode: normalized.officialAuthMode,
  };
}

function normalizeModel(value) {
  return {
    id: nonEmptyString(value?.id),
    displayName: nonEmptyString(value?.displayName ?? value?.id) ?? "自定义模型",
    supportsImage: Boolean(value?.supportsImage),
    chatCompatibility: Boolean(value?.chatCompatibility),
    reasoningEfforts: Array.isArray(value?.reasoningEfforts)
      ? [...new Set(value.reasoningEfforts.map(nonEmptyString).filter(Boolean))]
      : [],
    defaultReasoningEffort: nonEmptyString(value?.defaultReasoningEffort),
  };
}

function officialTarget(snapshot, headers, baseUrls = {
  apiKey: OPENAI_API_BASE_URL,
  oauth: CHATGPT_CODEX_BASE_URL,
}) {
  const authMode = snapshot.officialAuthMode ?? inferOfficialAuthMode(headers);
  return {
    kind: "official",
    routeKey: "openai",
    baseUrl: authMode === "apiKey" ? baseUrls.apiKey : baseUrls.oauth,
  };
}

function inferOfficialAuthMode(headers) {
  if (nonEmptyString(headers["chatgpt-account-id"])) return "oauth";
  const authorization = nonEmptyString(headers.authorization) ?? "";
  return /^Bearer\s+sk-/i.test(authorization) ? "apiKey" : "oauth";
}

function prepareCustomRequest(body, target) {
  if (containsImageInput(body.input) && !target.supportsImage) {
    throw httpError(400, `${target.displayName} 未配置图片输入能力`);
  }
  const next = structuredClone(body);
  stripCodexInternalInputMetadata(next.input);
  if (target.routeKey === DEEPSEEK_PROVIDER) stripUnsupportedDeepSeekReasoningFields(next.input);
  next.store = false;
  delete next.service_tier;
  if (next.reasoning && typeof next.reasoning === "object") {
    delete next.reasoning.summary;
    const effort = nonEmptyString(next.reasoning.effort);
    if (target.reasoningEfforts.length === 0) {
      delete next.reasoning.effort;
    } else if (effort && !target.reasoningEfforts.includes(effort)) {
      throw httpError(
        400,
        `${target.displayName} 的推理深度仅支持 ${target.reasoningEfforts.join("、")}`,
      );
    } else if (!effort) {
      next.reasoning.effort = target.defaultReasoningEffort ?? target.reasoningEfforts[0];
    }
    if (Object.keys(next.reasoning).length === 0) delete next.reasoning;
  }
  return next;
}

function stripCodexInternalInputMetadata(input) {
  if (!Array.isArray(input)) return;
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    delete item.internal_chat_message_metadata_passthrough;
  }
}

function stripUnsupportedDeepSeekReasoningFields(input) {
  if (!Array.isArray(input)) return;
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item) || item.type !== "reasoning") continue;
    delete item.summary;
    delete item.encrypted_content;
  }
}

function customRequestShape(body) {
  const input = Array.isArray(body?.input) ? body.input : null;
  return {
    model: nonEmptyString(body?.model),
    topLevelKeys: body && typeof body === "object" ? Object.keys(body).sort() : [],
    input: input?.map((item, index) => ({
      index,
      type: item && typeof item === "object" ? nonEmptyString(item.type) : null,
      role: item && typeof item === "object" ? nonEmptyString(item.role) : null,
      keys: item && typeof item === "object" && !Array.isArray(item)
        ? Object.keys(item).sort()
        : [],
      content: Array.isArray(item?.content)
        ? item.content.map((part) => ({
            type: part && typeof part === "object" ? nonEmptyString(part.type) : typeof part,
            keys: part && typeof part === "object" && !Array.isArray(part)
              ? Object.keys(part).sort()
              : [],
          }))
        : typeof item?.content,
    })) ?? typeof body?.input,
  };
}

function prepareCustomWebSocketRequest(body, target) {
  const next = prepareCustomRequest(body, target);
  delete next.type;
  delete next.generate;
  delete next.stream_id;
  delete next.client_metadata;
  next.stream = true;
  return next;
}

function requestHeaders(source, target, contentLength) {
  const headers = upstreamHeaders(source, target);
  // The rewritten body is plain JSON, not the caller's compressed bytes.
  delete headers["content-encoding"];
  headers["content-type"] = "application/json";
  headers["content-length"] = String(contentLength);
  return headers;
}

function rawRequestHeaders(source, target, contentLength) {
  const headers = upstreamHeaders(source, target);
  if (contentLength > 0 || source?.["content-length"] != null) {
    headers["content-length"] = String(contentLength);
  }
  return headers;
}

function upstreamHeaders(source, target) {
  const headers = normalizedHeaders(source);
  delete headers[MODEL_ROUTER_TOKEN_HEADER];
  if (target.kind === "custom") {
    for (const name of Object.keys(headers)) {
      const normalized = name.toLowerCase();
      if (
        normalized === "authorization" ||
        normalized === "chatgpt-account-id" ||
        normalized === "originator" ||
        normalized === "session-id" ||
        normalized === "thread-id" ||
        normalized.startsWith("x-codex-") ||
        normalized.startsWith("x-oai-") ||
        normalized.startsWith("x-openai-")
      ) {
        delete headers[name];
      }
    }
    headers.authorization = `Bearer ${target.apiKey}`;
  }
  return headers;
}

function upstreamWebSocketHeaders(source, target) {
  const headers = upstreamHeaders(source, target);
  delete headers.origin;
  delete headers["content-type"];
  return headers;
}

function responseHeaders(source) {
  return normalizedHeaders(source);
}

function normalizedHeaders(source) {
  const result = {};
  for (const [name, value] of Object.entries(source ?? {})) {
    const normalized = name.toLowerCase();
    if (value == null || HOP_BY_HOP_HEADERS.has(normalized)) continue;
    if (normalized === "content-length" || normalized.startsWith("sec-websocket-")) continue;
    result[normalized] = value;
  }
  return result;
}

function authenticatedRoute(request, token) {
  const incoming = new URL(request.url ?? "/", "http://127.0.0.1");
  const tokenPrefix = `/${token}`;
  const pathAuthenticated = incoming.pathname === tokenPrefix ||
    incoming.pathname.startsWith(`${tokenPrefix}/`);
  const headerAuthenticated = safeTokenEqual(request.headers[MODEL_ROUTER_TOKEN_HEADER], token);
  if (!pathAuthenticated && !headerAuthenticated) {
    throw httpError(403, "本机模型路由认证失败");
  }
  return {
    incoming,
    pathname: pathAuthenticated
      ? incoming.pathname.slice(tokenPrefix.length) || "/"
      : incoming.pathname,
  };
}

function isApiPath(pathname) {
  return pathname === "/v1" || pathname === "/v1/" || pathname.startsWith("/v1/");
}

function isResponsesPath(pathname) {
  return pathname === "/v1/responses" || pathname === "/v1/responses/";
}

function isModelsPath(pathname) {
  return pathname === "/v1/models" || pathname === "/v1/models/";
}

function apiTargetUrl(target, pathname, search = "") {
  if (!isApiPath(pathname)) throw httpError(404, "模型路由仅代理 OpenAI API 请求");
  const targetUrl = new URL(target.baseUrl);
  const basePath = targetUrl.pathname.endsWith("/")
    ? targetUrl.pathname
    : `${targetUrl.pathname}/`;
  const relativePath = pathname.startsWith("/v1/") ? pathname.slice(4) : "";
  targetUrl.pathname = `${basePath}${relativePath}`;
  targetUrl.search = search;
  targetUrl.hash = "";
  return targetUrl;
}

async function readRequestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw httpError(413, "API 请求体过大");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function parseRequestJson(payload, headers, { required = false } = {}) {
  if (!required && payload.length === 0) return null;
  const contentType = String(headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  const encodings = String(headers["content-encoding"] ?? "")
    .toLowerCase().split(",").map((value) => value.trim()).filter(Boolean);
  // Future binary endpoints must remain opaque. JSON auxiliary requests still
  // need decoding so an explicit custom model cannot fall through to OpenAI.
  if (!required && encodings.length && contentType &&
      contentType !== "application/json" && !contentType.endsWith("+json")) return null;
  let decoded = payload;
  for (const encoding of encodings.reverse()) {
    if (encoding === "identity") continue;
    const decode = REQUEST_DECODERS.get(encoding);
    if (!decode) throw httpError(415, `不支持的请求 Content-Encoding：${encoding}`);
    try {
      decoded = await decode(decoded, { maxOutputLength: MAX_REQUEST_BYTES });
    } catch (error) {
      if (error?.code === "ERR_BUFFER_TOO_LARGE") {
        throw httpError(413, "API 请求体解压后过大");
      }
      throw httpError(400, `无法解压 ${encoding} 请求体`);
    }
  }
  try {
    return JSON.parse(decoded.toString("utf8"));
  } catch {
    if (required) throw httpError(400, "无法解析 Responses JSON 请求");
    return null;
  }
}

function containsImageInput(value) {
  if (Array.isArray(value)) return value.some(containsImageInput);
  if (!value || typeof value !== "object") return false;
  if (["image", "localImage", "input_image", "image_url"].includes(value.type)) return true;
  return Object.values(value).some(containsImageInput);
}

function requestThreadId(body, headers) {
  const metadata = body?.client_metadata && typeof body.client_metadata === "object"
    ? body.client_metadata
    : null;
  return nonEmptyString(metadata?.thread_id) ??
    nonEmptyString(headers?.["thread-id"]) ??
    nonEmptyString(headers?.["session-id"]);
}

function turnIdFromHeaders(headers) {
  const direct = nonEmptyString(headers["turn-id"]);
  if (direct) return direct;
  const raw = nonEmptyString(headers["x-codex-turn-metadata"]);
  if (!raw) return null;
  for (const candidate of metadataCandidates(raw)) {
    const found = findTurnId(candidate);
    if (found) return found;
  }
  return null;
}

function metadataCandidates(raw) {
  const values = [raw];
  try { values.push(decodeURIComponent(raw)); } catch {}
  for (const encoding of ["base64url", "base64"]) {
    try { values.push(Buffer.from(raw, encoding).toString("utf8")); } catch {}
  }
  return values.map((value) => {
    try { return JSON.parse(value); } catch { return null; }
  }).filter(Boolean);
}

function findTurnId(value) {
  if (!value || typeof value !== "object") return null;
  for (const key of ["turnId", "turn_id"]) {
    const turnId = nonEmptyString(value[key]);
    if (turnId) return turnId;
  }
  for (const child of Object.values(value)) {
    const turnId = findTurnId(child);
    if (turnId) return turnId;
  }
  return null;
}

function turnIdFromMetadata(metadata) {
  const raw = nonEmptyString(metadata?.["x-codex-turn-metadata"]);
  if (!raw) return null;
  for (const candidate of metadataCandidates(raw)) {
    const found = findTurnId(candidate);
    if (found) return found;
  }
  return null;
}

function requestStartFromMetadata(metadata, fallback) {
  const timestamp = Number(metadata?.["x-codex-ws-stream-request-start-ms"]);
  const now = Date.now();
  if (Number.isFinite(timestamp) && timestamp > 0 &&
    Math.abs(now - timestamp) <= MAX_REQUEST_START_SKEW_MS) {
    return timestamp;
  }
  return fallback;
}

function observeResponse(stream, { requestStartedAt, onUsage, onToolCall, onGeneration, onFailure }) {
  const contentType = String(stream.headers["content-type"] ?? "").toLowerCase();
  const observedStream = decodeObservedStream(stream);
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let jsonBody = "";
  const observation = createResponseObservation({
    requestStartedAt,
    responseStartedAt: Date.now(),
    requireCompleted: contentType.includes("text/event-stream"),
    onUsage,
    onToolCall,
    onGeneration,
    onFailure,
  });
  observedStream.on("data", (chunk) => {
    const text = decoder.write(chunk);
    if (contentType.includes("text/event-stream")) {
      pending += text;
      const blocks = pending.split(/\r?\n\r?\n/);
      pending = blocks.pop() ?? "";
      for (const block of blocks) inspectSseBlock(block, observation);
    } else if (jsonBody.length < MAX_REQUEST_BYTES) {
      jsonBody += text;
    }
  });
  observedStream.once("end", () => {
    const tail = decoder.end();
    if (contentType.includes("text/event-stream")) {
      pending += tail;
      if (pending.trim()) inspectSseBlock(pending, observation);
      observation.finish();
      return;
    }
    jsonBody += tail;
    try {
      observation.recordPayload(JSON.parse(jsonBody));
    } catch {}
    observation.finish();
  });
  observedStream.once("error", () => observation.abort());
}

export function createResponseObservation({
  requestStartedAt,
  responseStartedAt = 0,
  requireCompleted,
  onUsage,
  onToolCall = () => {},
  onGeneration,
  onFailure = () => {},
  clock = Date.now,
}) {
  let firstResponseAt = Number(responseStartedAt) || 0;
  let firstReasoningAt = 0;
  let lastReasoningAt = 0;
  let hasNonTextOutput = false;
  let hasUnmeasuredOutput = false;
  let responseId = null;
  let latestUsage = null;
  const messageItems = new Map();
  const messageItemStates = new Set();
  const toolItems = new Map();
  const toolItemStates = new Set();
  const completedOutputItems = new Set();
  let activeMessage = null;
  let responseFinished = false;
  let responseFailureObserved = false;
  let finished = false;
  const markResponseStarted = () => {
    if (!firstResponseAt) firstResponseAt = clock();
  };
  const markReasoning = (timestamp) => {
    if (!firstReasoningAt) firstReasoningAt = timestamp;
    lastReasoningAt = timestamp;
  };
  const ensureMessageItem = (itemId, phase = null) => {
    const normalizedId = nonEmptyString(itemId);
    let state = normalizedId ? messageItems.get(normalizedId) : null;
    if (!state && activeMessage &&
      (!normalizedId || !activeMessage.itemId || activeMessage.itemId === normalizedId)) {
      state = activeMessage;
      if (normalizedId && !state.itemId) {
        state.itemId = normalizedId;
        messageItems.set(normalizedId, state);
      }
    }
    if (!state) {
      state = {
        itemId: normalizedId,
        phase: null,
        firstAt: 0,
        lastDeltaAt: 0,
        deltaCount: 0,
        visibleTextChars: 0,
      };
      messageItemStates.add(state);
      if (normalizedId) messageItems.set(normalizedId, state);
    }
    const normalizedPhase = messagePhase(phase);
    if (normalizedPhase) state.phase = normalizedPhase;
    activeMessage = state;
    return state;
  };
  const recordText = (state, text, timestamp, { streamed = false } = {}) => {
    if (!state) return;
    if (typeof text === "string" && text.length > 0) {
      if (!state.firstAt) state.firstAt = timestamp;
      state.visibleTextChars += [...text].length;
      if (streamed) {
        state.lastDeltaAt = timestamp;
        state.deltaCount += 1;
      }
    }
  };
  const rememberToolItem = (item, timestamp, completed) => {
    const references = outputItemReferences(item);
    let state = references.map((reference) => toolItems.get(reference)).find(Boolean);
    if (!state) {
      state = { preparationStartedAt: completed ? 0 : timestamp, firstInputAt: 0, lastInputAt: 0, deltaCount: 0 };
      toolItemStates.add(state);
    }
    if (!completed && !state.preparationStartedAt) state.preparationStartedAt = timestamp;
    for (const reference of references) toolItems.set(reference, state);
    if (!completed) return;
    const referenceId = outputItemReference(item);
    if (!referenceId || completedOutputItems.has(referenceId)) return;
    completedOutputItems.add(referenceId);
    onToolCall({
      referenceId,
      toolName: outputItemLabel(item),
      preparationStartedAt: state.preparationStartedAt || null,
      readyAt: timestamp,
    });
  };
  const recordOutputItem = (item, timestamp, { completed = false, countText = false } = {}) => {
    if (!item || typeof item !== "object") return;
    const type = nonEmptyString(item.type);
    if (!type) return;
    if (type === "reasoning") return;
    if (type === "message") {
      const state = ensureMessageItem(item.id, item.phase);
      for (const content of Array.isArray(item.content) ? item.content : []) {
        if (content?.type !== "output_text") {
          if (nonEmptyString(content?.type)) {
            hasNonTextOutput = true;
            hasUnmeasuredOutput = true;
          }
          continue;
        }
        if (!countText || state.visibleTextChars > 0) continue;
        recordText(state, content.text, timestamp);
      }
      if (completed) {
        if (activeMessage === state) activeMessage = null;
      }
      return;
    }
    hasNonTextOutput = true;
    rememberToolItem(item, timestamp, completed);
  };
  return {
    markResponseStarted,
    recordPayload(payload) {
      markResponseStarted();
      const now = clock();
      if (!responseFailureObserved && (payload?.type === "response.failed" ||
        payload?.status === "failed" || payload?.response?.status === "failed")) {
        responseFailureObserved = true;
        onFailure();
      }
      responseId = nonEmptyString(payload?.response?.id) ??
        nonEmptyString(payload?.id) ??
        responseId;
      if (payload?.type === "response.output_text.delta" &&
        typeof payload.delta === "string" && payload.delta.length > 0) {
        recordText(
          ensureMessageItem(payload.item_id, payload.phase),
          payload.delta,
          now,
          { streamed: true },
        );
      }
      if (payload?.type === "response.output_text.done") {
        const state = ensureMessageItem(payload.item_id, payload.phase);
        if (state.visibleTextChars === 0) recordText(state, payload.text, now);
      }
      if (isReasoningPayload(payload)) markReasoning(now);
      if (["response.content_part.added", "response.content_part.done"].includes(payload?.type) &&
        nonEmptyString(payload?.part?.type) && payload.part.type !== "output_text") {
        hasNonTextOutput = true;
        hasUnmeasuredOutput = true;
      }
      if (["response.output_item.added", "response.output_item.done"].includes(payload?.type) &&
        payload.item) {
        recordOutputItem(payload.item, now, {
          completed: payload.type === "response.output_item.done",
        });
      }
      if (isToolInputDeltaPayload(payload)) {
        hasNonTextOutput = true;
        const references = [payload.item_id, payload.call_id]
          .map(nonEmptyString)
          .filter(Boolean);
        let state = references.map((reference) => toolItems.get(reference)).find(Boolean);
        if (!state) {
          state = { preparationStartedAt: now, firstInputAt: 0, lastInputAt: 0, deltaCount: 0 };
          toolItemStates.add(state);
        }
        for (const reference of references) toolItems.set(reference, state);
        if (!state.preparationStartedAt) state.preparationStartedAt = now;
        if (typeof payload.delta === "string" && payload.delta.length > 0) {
          if (!state.firstInputAt) state.firstInputAt = now;
          state.lastInputAt = now;
          state.deltaCount += 1;
        }
      }
      if (payload?.type === "response") {
        for (const item of Array.isArray(payload.output) ? payload.output : []) {
          if (item?.type === "reasoning") markReasoning(now);
          recordOutputItem(item, now, { completed: true, countText: true });
        }
      } else if (Array.isArray(payload?.output)) {
        for (const item of payload.output) {
          if (item?.type === "reasoning") markReasoning(now);
          recordOutputItem(item, now, { completed: true, countText: true });
        }
      } else if (payload?.response && typeof payload.response === "object") {
        for (const item of Array.isArray(payload.response.output) ? payload.response.output : []) {
          recordOutputItem(item, now, { completed: true, countText: true });
        }
      }
      if (["response.completed", "response.incomplete"].includes(payload?.type)) {
        responseFinished = true;
      }
      const usage = normalizeUsage(payload?.response?.usage ?? payload?.usage);
      if (usage) latestUsage = usage;
    },
    finish() {
      if (finished) return;
      finished = true;
      if (latestUsage) onUsage(latestUsage, responseId);
      if (!responseFinished && requireCompleted) return;
      const visibleMessages = [...messageItemStates]
        .filter((state) => state.firstAt > 0 && state.visibleTextChars > 0)
        .sort((left, right) => left.firstAt - right.firstAt);
      const textPhases = visibleMessages.map((state) => ({
          phase: state.phase ?? "unknown",
          startLatencyMs: Math.max(0, state.firstAt - requestStartedAt),
          durationMs: state.deltaCount > 1 && state.lastDeltaAt > state.firstAt
            ? state.lastDeltaAt - state.firstAt
            : null,
        }));
      const outputPhases = [
        ...textPhases.map((phase, textPhaseIndex) => ({
          kind: "text", textPhaseIndex,
          startLatencyMs: phase.startLatencyMs, durationMs: phase.durationMs,
        })),
        ...[...toolItemStates].map((state) => ({
          kind: "tool",
          startLatencyMs: state.firstInputAt > 0 ? Math.max(0, state.firstInputAt - requestStartedAt) : null,
          durationMs: state.deltaCount > 1 && state.lastInputAt > state.firstInputAt
            ? state.lastInputAt - state.firstInputAt : null,
        })),
      ].sort((left, right) => (left.startLatencyMs ?? Infinity) - (right.startLatencyMs ?? Infinity));
      const firstOutputAt = textPhases.length > 0
        ? requestStartedAt + textPhases[0].startLatencyMs
        : 0;
      const generationDurationMs = textPhases.reduce(
        (total, phase) => total + (Number(phase.durationMs) || 0),
        0,
      );
      onGeneration({
        responseId,
        hasVisibleText: textPhases.length > 0,
        responseLatencyMs: firstResponseAt > 0
          ? Math.max(0, firstResponseAt - requestStartedAt)
          : null,
        reasoningDurationMs: firstReasoningAt > 0 && lastReasoningAt > firstReasoningAt
          ? lastReasoningAt - firstReasoningAt
          : null,
        firstTokenLatencyMs: firstOutputAt > 0
          ? Math.max(0, firstOutputAt - requestStartedAt)
          : null,
        generationDurationMs: generationDurationMs > 0 ? generationDurationMs : null,
        textPhases,
        outputPhases,
        outputPhasesComplete: !hasUnmeasuredOutput && outputPhases.length > 0 &&
          outputPhases.every((phase) => phase.durationMs > 0),
        hasNonTextOutput,
        // Names become public only after a matching call result confirms that
        // the non-text output really was an executable tool invocation.
        toolNames: [],
      });
    },
    abort() {
      finished = true;
    },
  };
}

function inspectSseBlock(block, observation) {
  const payload = parseSseBlock(block);
  if (payload) observation.recordPayload(payload);
}

function parseSseBlock(block) {
  const data = block.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  if (!data || data === "[DONE]") return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function createWebSocketObservationQueue() {
  const lanes = new Map();
  return {
    add(streamId, observation, { onAccepted = () => {}, onRejected = () => {} } = {}) {
      const key = webSocketLane(streamId);
      const entry = { key, observation, onAccepted, onRejected, routeSettled: false };
      const queue = lanes.get(key) ?? [];
      queue.push(entry);
      lanes.set(key, queue);
      return entry;
    },
    accept(payload) {
      if (!payload || typeof payload !== "object") return;
      const key = webSocketLane(payload.stream_id);
      const queue = lanes.get(key);
      const entry = queue?.[0];
      if (!entry) return;
      if (!entry.routeSettled && isAcceptedResponseEvent(payload.type)) {
        entry.routeSettled = true;
        entry.onAccepted();
      }
      entry.observation.recordPayload(payload);
      if (!isTerminalResponseEvent(payload.type)) return;
      if (!entry.routeSettled) {
        entry.routeSettled = true;
        entry.onRejected();
      }
      if (["response.completed", "response.incomplete"].includes(payload.type)) {
        entry.observation.finish();
      } else {
        entry.observation.abort();
      }
      queue.shift();
      if (queue.length === 0) lanes.delete(key);
    },
    remove(entry) {
      const queue = lanes.get(entry.key);
      if (!queue) return;
      const index = queue.indexOf(entry);
      if (index >= 0) queue.splice(index, 1);
      if (!entry.routeSettled) {
        entry.routeSettled = true;
        entry.onRejected();
      }
      entry.observation.abort();
      if (queue.length === 0) lanes.delete(entry.key);
    },
    abortAll() {
      for (const queue of lanes.values()) {
        for (const entry of queue) {
          if (!entry.routeSettled) {
            entry.routeSettled = true;
            entry.onRejected();
          }
          entry.observation.abort();
        }
      }
      lanes.clear();
    },
  };
}

function ignoredResponseObservation() {
  return {
    markResponseStarted() {},
    recordPayload() {},
    finish() {},
    abort() {},
  };
}

function isAcceptedResponseEvent(type) {
  return typeof type === "string" && type.startsWith("response.") &&
    type !== "response.failed";
}

function startHttpWebSocketBridge({
  client,
  sourceHeaders,
  search,
  body,
  target,
  context,
  streamId,
  onUsage,
  onToolCall,
  onGeneration,
  onResponse,
  onRequestShape,
  onPrepared,
  onAccepted,
  onDone,
}) {
  const prepared = prepareCustomWebSocketRequest(body, target);
  const requestShape = customRequestShape(prepared);
  onRequestShape?.(requestShape);
  onPrepared?.();
  const payload = Buffer.from(JSON.stringify(prepared));
  const targetUrl = new URL(`responses${search}`, target.baseUrl);
  const headers = requestHeaders(sourceHeaders, target, payload.length);
  const transport = targetUrl.protocol === "https:" ? requestHttps : requestHttp;
  const observation = createResponseObservation({
    requestStartedAt: context.requestStartedAt,
    requireCompleted: true,
    onUsage,
    onToolCall,
    onGeneration,
  });
  let upstreamResponse = null;
  let finished = false;
  let sequenceNumber = 0;
  const finish = () => {
    if (finished) return;
    finished = true;
    onDone();
  };
  const fail = (message) => {
    observation.abort();
    sendWebSocketFailure(client, body, streamId, message, sequenceNumber++);
  };
  const upstream = transport(targetUrl, { method: "POST", headers }, (response) => {
    upstreamResponse = response;
    observation.markResponseStarted();
    const statusCode = response.statusCode ?? 502;
    if (statusCode < 200 || statusCode >= 300) {
      console.error(
        `[model-router] ${target.displayName} 上游返回 ${statusCode}；` +
        `脱敏请求结构=${JSON.stringify(requestShape)}`,
      );
      void readLimitedResponseText(response).then((text) => {
        fail(upstreamErrorMessage(statusCode, text));
      }).catch((error) => {
        fail(`自定义模型响应读取失败：${error.message}`);
      }).finally(finish);
      return;
    }
    onAccepted?.();
    let terminalSeen = false;
    consumeResponsePayloads(response, {
      onPayload(value) {
        const event = responseEvent(value);
        if (!event) return;
        if (isTerminalResponseEvent(event.type)) terminalSeen = true;
        if (event.type === "response.failed") {
          console.error(
            `[model-router] ${target.displayName} 上游响应失败；` +
            `脱敏请求结构=${JSON.stringify(requestShape)}`,
          );
        }
        if (["response.completed", "response.incomplete"].includes(event.type)) onResponse?.(event.response);
        observation.recordPayload(event);
        sendWebSocketJson(
          client,
          withWebSocketTransport(event, streamId, sequenceNumber++),
        );
      },
      onEnd() {
        if (!terminalSeen) {
          fail("自定义模型响应在完成事件前中断");
        } else {
          observation.finish();
        }
        finish();
      },
      onError(error) {
        fail(`自定义模型响应流中断：${error.message}`);
        finish();
      },
    });
  });
  upstream.once("error", (error) => {
    if (finished) return;
    fail(`自定义模型请求失败：${error.message}`);
    finish();
  });
  upstream.end(payload);
  return {
    cancel() {
      if (finished) return;
      observation.abort();
      upstreamResponse?.destroy();
      upstream.destroy();
      finish();
    },
  };
}

function consumeResponsePayloads(stream, { onPayload, onEnd, onError }) {
  const contentType = String(stream.headers["content-type"] ?? "").toLowerCase();
  const eventStream = contentType.includes("text/event-stream");
  const observedStream = decodeObservedStream(stream);
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let jsonBody = "";
  let settled = false;
  const fail = (error) => {
    if (settled) return;
    settled = true;
    onError(error);
  };
  observedStream.on("data", (chunk) => {
    if (settled) return;
    const text = decoder.write(chunk);
    if (eventStream) {
      pending += text;
      if (pending.length > MAX_REQUEST_BYTES) {
        observedStream.destroy(httpError(502, "自定义模型响应帧过大"));
        return;
      }
      const blocks = pending.split(/\r?\n\r?\n/);
      pending = blocks.pop() ?? "";
      for (const block of blocks) {
        const payload = parseSseBlock(block);
        if (payload) onPayload(payload);
      }
      return;
    }
    jsonBody += text;
    if (jsonBody.length > MAX_REQUEST_BYTES) {
      observedStream.destroy(httpError(502, "自定义模型响应体过大"));
    }
  });
  observedStream.once("end", () => {
    if (settled) return;
    const tail = decoder.end();
    if (eventStream) {
      pending += tail;
      if (pending.trim()) {
        const payload = parseSseBlock(pending);
        if (payload) onPayload(payload);
      }
    } else {
      jsonBody += tail;
      try {
        onPayload(JSON.parse(jsonBody));
      } catch {
        fail(httpError(502, "自定义模型返回了无法解析的 JSON"));
        return;
      }
    }
    settled = true;
    onEnd();
  });
  observedStream.once("error", fail);
}

function responseEvent(value) {
  if (!value || typeof value !== "object") return null;
  if (nonEmptyString(value.type)) return value;
  if (nonEmptyString(value.id) || Array.isArray(value.output)) {
    const type = value.status === "failed"
      ? "response.failed"
      : value.status === "incomplete"
        ? "response.incomplete"
        : "response.completed";
    return { type, response: value };
  }
  return null;
}

function sendWebSocketPrewarm(client, body, streamId) {
  const id = `resp_${randomUUID().replace(/-/g, "")}`;
  const base = webSocketResponse(body, id, "in_progress", null);
  sendWebSocketJson(
    client,
    withWebSocketTransport({ type: "response.created", response: base }, streamId, 0),
  );
  sendWebSocketJson(
    client,
    withWebSocketTransport({ type: "response.in_progress", response: base }, streamId, 1),
  );
  const completed = webSocketResponse(body, id, "completed", emptyResponseUsage());
  sendWebSocketJson(
    client,
    withWebSocketTransport({ type: "response.completed", response: completed }, streamId, 2),
  );
  return completed;
}

function sendWebSocketFailure(client, body, streamId, message, sequenceNumber = 0) {
  if (client.readyState !== WebSocket.OPEN) return;
  const id = `resp_${randomUUID().replace(/-/g, "")}`;
  const response = webSocketResponse(body, id, "failed", null);
  response.error = {
    code: "model_router_error",
    message: nonEmptyString(message) ?? "模型路由失败",
    type: "model_router_error",
  };
  sendWebSocketJson(
    client,
    withWebSocketTransport({ type: "response.failed", response }, streamId, sequenceNumber),
  );
}

function webSocketResponse(body, id, status, usage) {
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1_000),
    status,
    error: null,
    incomplete_details: null,
    model: nonEmptyString(body?.model) ?? "",
    output: [],
    parallel_tool_calls: body?.parallel_tool_calls !== false,
    tool_choice: body?.tool_choice ?? "auto",
    tools: Array.isArray(body?.tools) ? body.tools : [],
    usage,
  };
}

function emptyResponseUsage() {
  return {
    input_tokens: 0,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 0,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 0,
  };
}

function withWebSocketTransport(payload, streamId, sequenceNumber) {
  return {
    ...payload,
    sequence_number: Number.isInteger(payload.sequence_number)
      ? payload.sequence_number
      : sequenceNumber,
    ...(streamId ? { stream_id: streamId } : {}),
  };
}

function sendWebSocketJson(client, payload) {
  return sendWebSocketData(client, JSON.stringify(payload), false);
}

function sendWebSocketData(client, data, binary) {
  if (client.readyState !== WebSocket.OPEN) return false;
  try {
    client.send(data, { binary });
    return true;
  } catch {
    return false;
  }
}

function webSocketDataLength(data) {
  if (typeof data === "string") return Buffer.byteLength(data);
  return Number(data?.byteLength ?? data?.length) || 0;
}

function webSocketProtocols(headers) {
  const value = headers?.["sec-websocket-protocol"];
  const text = Array.isArray(value) ? value.join(",") : String(value ?? "");
  return [...new Set(text.split(",").map((item) => item.trim()).filter(Boolean))];
}

function parseWebSocketJson(data) {
  try {
    return JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
  } catch {
    return null;
  }
}

function normalizedStreamId(value) {
  return nonEmptyString(value);
}

function webSocketLane(streamId) {
  return streamId ? `stream:${streamId}` : "default";
}

function isTerminalResponseEvent(type) {
  return ["response.completed", "response.failed", "response.incomplete"].includes(type);
}

function webSocketTargetUrl(target, search) {
  return webSocketApiTargetUrl(target, "/v1/responses", search);
}

function webSocketApiTargetUrl(target, pathname, search) {
  const url = apiTargetUrl(target, pathname, search);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  else throw httpError(502, `不支持的模型上游协议：${url.protocol}`);
  return url;
}

function validWebSocketCloseCode(code) {
  return Number.isInteger(code) && code >= 1000 && code <= 4999 &&
    ![1004, 1005, 1006, 1015].includes(code);
}

async function readLimitedResponseText(stream) {
  const observedStream = decodeObservedStream(stream);
  const chunks = [];
  let size = 0;
  for await (const chunk of observedStream) {
    size += chunk.length;
    if (size > MAX_ERROR_BODY_BYTES) break;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function upstreamErrorMessage(statusCode, body) {
  try {
    const payload = JSON.parse(body);
    const message = nonEmptyString(payload?.error?.message ?? payload?.message);
    if (message) return `自定义模型返回 ${statusCode}：${message}`;
  } catch {}
  return `自定义模型返回 HTTP ${statusCode}`;
}

function decodeObservedStream(stream) {
  const encoding = String(stream.headers["content-encoding"] ?? "")
    .toLowerCase()
    .split(",")[0]
    .trim();
  let decoder = null;
  if (encoding === "gzip" || encoding === "x-gzip") decoder = createGunzip();
  else if (encoding === "deflate") decoder = createInflate();
  else if (encoding === "br") decoder = createBrotliDecompress();
  if (!decoder) return stream;
  stream.pipe(decoder);
  return decoder;
}

function normalizeUsage(value) {
  if (!value || typeof value !== "object") return null;
  const inputTokens = number(value.input_tokens ?? value.inputTokens);
  const cachedInputTokens = number(
    value.input_tokens_details?.cached_tokens ?? value.cachedInputTokens,
  );
  const cacheWriteInputTokens = number(
    value.input_tokens_details?.cache_write_tokens ?? value.cacheWriteInputTokens,
  );
  const outputTokens = number(value.output_tokens ?? value.outputTokens);
  const reasoningOutputTokens = number(
    value.output_tokens_details?.reasoning_tokens ?? value.reasoningOutputTokens,
  );
  const totalTokens = number(value.total_tokens ?? value.totalTokens) || inputTokens + outputTokens;
  if (totalTokens <= 0) return null;
  return {
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
  };
}

function emptyUsage() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
}

function addUsage(total, usage) {
  for (const key of Object.keys(total)) total[key] += number(usage[key]);
}

function createUsageEventWriter(path) {
  const sessionId = randomUUID();
  let sequence = 0;
  let buffer = [];
  let flushTimer = null;
  let closed = false;
  let tail = Promise.resolve();
  const directoryReady = path
    ? mkdir(dirname(path), { recursive: true, mode: 0o700 })
    : Promise.resolve();
  const flush = () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    if (!path || buffer.length === 0) return tail;
    const batch = buffer;
    buffer = [];
    const content = `${batch.map((payload) => JSON.stringify(payload)).join("\n")}\n`;
    tail = tail.then(async () => {
      await directoryReady;
      await appendFile(path, content, { encoding: "utf8", mode: 0o600 });
    }).catch((error) => {
      console.error(`[model-router] 记录 Token 用量事件失败: ${error.message}`);
    });
    return tail;
  };
  return {
    write(event) {
      if (closed || !path || !event?.type || !event.threadId) return;
      buffer.push({
        ...event,
        eventId: `${sessionId}:${++sequence}`,
        recordedAt: Date.now(),
      });
      if (buffer.length >= 32) void flush();
      else if (!flushTimer) flushTimer = setTimeout(() => void flush(), 25);
    },
    async close() {
      closed = true;
      await flush();
      await tail;
    },
  };
}

function customProviderId(id) {
  return `${CUSTOM_PROVIDER_PREFIX}${String(id).replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}`;
}

function safeTokenEqual(value, expected) {
  const left = Buffer.from(nonEmptyString(Array.isArray(value) ? value[0] : value) ?? "");
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function writeError(response, statusCode, message) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: { message, type: "model_router_error" } }));
}

function rejectUpgrade(socket, statusCode, message) {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const body = JSON.stringify({
    error: {
      message: nonEmptyString(message) ?? "模型路由失败",
      type: "model_router_error",
    },
  });
  socket.end([
    `HTTP/1.1 ${statusCode} Model Router Error`,
    "Connection: close",
    "Content-Type: application/json; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "",
    body,
  ].join("\r\n"));
}

function nonEmptyString(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function containsCallReference(value) {
  if (!value || typeof value !== "object") return false;
  if (nonEmptyString(value.call_id)) return true;
  return Object.values(value).some(containsCallReference);
}

function collectCallReferenceIds(value, result = new Set()) {
  if (!value || typeof value !== "object") return result;
  const callId = nonEmptyString(value.call_id);
  const itemId = nonEmptyString(value.id);
  if (callId) result.add(callId);
  if (itemId) result.add(itemId);
  for (const child of Object.values(value)) collectCallReferenceIds(child, result);
  return result;
}

function outputItemReference(item) {
  return nonEmptyString(item?.call_id) ?? nonEmptyString(item?.id);
}

function outputItemReferences(item) {
  return [...new Set([
    nonEmptyString(item?.call_id),
    nonEmptyString(item?.id),
  ].filter(Boolean))];
}

function pendingToolCallKey(threadId, referenceId) {
  return `${threadId}\u0000${referenceId}`;
}

function pendingToolBatchKey(threadId, requestId) {
  return `${threadId}\u0000${requestId}`;
}

function outputItemLabel(item) {
  const explicit = nonEmptyString(item?.name) ?? nonEmptyString(item?.server_label);
  if (explicit) return explicit;
  const type = nonEmptyString(item?.type);
  return type?.replaceAll("_", " ") ?? null;
}

function isReasoningPayload(payload) {
  const type = nonEmptyString(payload?.type) ?? "";
  return type.startsWith("response.reasoning") ||
    (["response.output_item.added", "response.output_item.done"].includes(type) &&
      payload?.item?.type === "reasoning");
}

function isToolInputDeltaPayload(payload) {
  const type = nonEmptyString(payload?.type) ?? "";
  if (!type.startsWith("response.") || !type.endsWith(".delta")) return false;
  if (!nonEmptyString(payload?.item_id) && !nonEmptyString(payload?.call_id)) return false;
  return type.includes("arguments") || type.includes("tool_call_input");
}

function messagePhase(value) {
  const phase = nonEmptyString(value);
  return ["commentary", "final_answer"].includes(phase) ? phase : null;
}

export function classifyNetworkLatency(previousSamples, latencyMs) {
  const current = Number(latencyMs);
  if (!Number.isFinite(current) || current < 0) return "fluctuating";
  const samples = (Array.isArray(previousSamples) ? previousSamples : [])
    .map(Number)
    .filter((value) => Number.isFinite(value) && value >= 0)
    .slice(-9)
    .sort((left, right) => left - right);
  if (samples.length < 3) return "stable";
  const middle = Math.floor(samples.length / 2);
  const baseline = samples.length % 2 === 1
    ? samples[middle]
    : (samples[middle - 1] + samples[middle]) / 2;
  const threshold = Math.max(baseline * 3, baseline + 100);
  return current >= threshold ? "fluctuating" : "stable";
}

function unavailableNetworkState() {
  return {
    status: "unavailable",
    latencyMs: null,
    sampledAt: null,
    connectionId: null,
  };
}

function normalizeNetworkState(value) {
  const status = [
    "unavailable",
    "measuring",
    "stable",
    "fluctuating",
    "reconnecting",
    "reconnected",
  ].includes(value?.status)
    ? value.status
    : "unavailable";
  const latency = value?.latencyMs == null ? Number.NaN : Number(value.latencyMs);
  const sampledAt = value?.sampledAt == null ? Number.NaN : Number(value.sampledAt);
  return {
    status,
    latencyMs: Number.isFinite(latency) && latency >= 0 ? Math.round(latency) : null,
    sampledAt: Number.isFinite(sampledAt) && sampledAt > 0 ? sampledAt : null,
    connectionId: nonEmptyString(value?.connectionId),
  };
}

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) && result > 0 ? result : 0;
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function closeWebSocketServer(server) {
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}
