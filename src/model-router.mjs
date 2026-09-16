import { createServer, request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { randomBytes, randomUUID } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { startModelCompatibilityProxy } from "./chat-compat-proxy.mjs";
import { ResponsesHistory } from "./responses-history.mjs";
import { MODEL_ROUTER_PROVIDER_ID, MODEL_ROUTER_TOKEN_ENV, MODEL_ROUTER_TOKEN_HEADER, OPENAI_API_BASE_URL, CHATGPT_CODEX_BASE_URL, MAX_REQUEST_BYTES, DEFAULT_ENDPOINT_REUSE_WAIT_MS, ENDPOINT_REUSE_RETRY_MS, DEFAULT_NETWORK_PROBE_INTERVAL_MS, DEFAULT_NETWORK_PROBE_TIMEOUT_MS, httpError, nonEmptyString } from "./model-router/contract.mjs";
import { normalizeRoutingConfiguration, buildRoutingSnapshot, officialTarget } from "./model-router/configuration.mjs";
import { prepareCustomRequest, customRequestShape, requestToolInventory } from "./model-router/request-policy.mjs";
import { rawRequestHeaders, upstreamWebSocketHeaders, responseHeaders, authenticatedRoute, isApiPath, isResponsesPath, isModelsPath, apiTargetUrl, readRequestBody, parseRequestJson, writeError, rejectUpgrade, listen, delay, closeServer, closeWebSocketServer, forwardModelResponse } from "./model-router/http-transport.mjs";
import { requestThreadId, turnIdFromHeaders, turnIdFromMetadata, requestStartFromMetadata, containsCallReference } from "./model-router/request-metadata.mjs";
import { observeResponse, createResponseObservation } from "./model-router/response-observation.mjs";
import { createWebSocketObservationQueue, ignoredResponseObservation } from "./model-router/websocket-observation.mjs";
import { startHttpWebSocketBridge } from "./model-router/websocket-bridge.mjs";
import { sendWebSocketPrewarm, sendWebSocketFailure, sendWebSocketData, webSocketProtocols, parseWebSocketJson, normalizedStreamId, webSocketLane, webSocketTargetUrl, validWebSocketCloseCode, proxyAuxiliaryWebSocket } from "./model-router/websocket-transport.mjs";
import { RouterRequestLedger } from "./model-router/request-ledger.mjs";
import { RouterNetworkMonitor } from "./model-router/network-monitor.mjs";

export class ModelRouterManager {
  constructor({
    officialApiBaseUrl = OPENAI_API_BASE_URL,
    officialCodexBaseUrl = CHATGPT_CODEX_BASE_URL,
    endpointReuseWaitMs = DEFAULT_ENDPOINT_REUSE_WAIT_MS,
    networkProbeIntervalMs = DEFAULT_NETWORK_PROBE_INTERVAL_MS,
    networkProbeTimeoutMs = DEFAULT_NETWORK_PROBE_TIMEOUT_MS,
    onRequestShape = null,
    log = console.log,
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
    this.networkMonitor = new RouterNetworkMonitor({ networkProbeIntervalMs, networkProbeTimeoutMs });
    this.requestLedger = new RouterRequestLedger(this.networkMonitor);

    this.closed = false;
    this.officialBaseUrls = {
      apiKey: officialApiBaseUrl,
      oauth: officialCodexBaseUrl,
    };
    this.onRequestShape = typeof onRequestShape === "function"
      ? onRequestShape
      : null;
    this.log = typeof log === "function" ? log : () => {};
  }

  onNetworkChange(listener) {
    return this.networkMonitor.onChange(listener);
  }

  getNetworkViewModel() {
    return this.networkMonitor.getViewModel();
  }

  async configure({
    extraModels,
    officialAuthMode = null,
    observeOfficial = false,
    usageEventPath = null,
    reusableIdentity = null,
  }) {
    if (this.closed) throw new Error("模型路由器已关闭");
    const normalized = normalizeRoutingConfiguration({
      extraModels,
      officialAuthMode,
    });
    if (normalized.targets.size === 0 && !observeOfficial) {
      await this.disable();
      return null;
    }

    this.#reuseIdentity(reusableIdentity);
    await this.#ensureServer();
    await this.requestLedger.ensureUsageWriter(usageEventPath);
    const snapshotSignature = `${normalized.signature}:observe-official=${Boolean(observeOfficial)}`;
    if (snapshotSignature !== this.snapshotSignature) {
      const replacingSnapshot = this.snapshotSignature !== null;
      const nextCompatibilityProxy = await startModelCompatibilityProxy(normalized.platforms);
      const previousCompatibilityProxy = this.chatCompatibilityProxy;
      this.chatCompatibilityProxy = nextCompatibilityProxy;
      this.snapshot = buildRoutingSnapshot(normalized, nextCompatibilityProxy);
      this.snapshotSignature = snapshotSignature;
      this.requestLedger.clearRoutes();
      if (replacingSnapshot) {
        this.#closeWebSocketConnections(1012, "模型路由配置已更新");
      }
      if (previousCompatibilityProxy) {
        void previousCompatibilityProxy.close().catch((error) => {
          console.error(`[model-router] 旧模型兼容代理关闭失败: ${error.message}`);
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
    this.requestLedger.reset();
    this.networkMonitor.stopAllNetworkMonitors();
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
    this.server = null;
    this.webSocketServer = null;
    this.chatCompatibilityProxy = null;
    this.snapshot = null;
    const ledgerClose = this.requestLedger.close();
    this.networkMonitor.stopAllNetworkMonitors({ notify: false });
    this.networkMonitor.close();
    this.#closeWebSocketConnections(1001, "模型路由器已关闭");
    server?.closeAllConnections?.();
    await Promise.all([
      server ? closeServer(server) : Promise.resolve(),
      webSocketServer ? closeWebSocketServer(webSocketServer) : Promise.resolve(),
      compatibilityProxy ? compatibilityProxy.close() : Promise.resolve(),
      ledgerClose,
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
    this.log(`[model-router] 已监听 127.0.0.1:${this.port}`);
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
          routeClaim = this.requestLedger.activateRequestContext(context);
          const accepted = await this.#forwardResponse(
            request,
            response,
            targetUrl,
            prepared,
            context.target,
            context,
          );
          this.requestLedger.settleThreadRoute(routeClaim, accepted);
          routeClaim = null;
        } finally {
          this.requestLedger.settleThreadRoute(routeClaim, false);
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
              this.requestLedger.recordUsage(observationContext, usage, responseId),
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
    const remembered = threadId ? this.requestLedger.rememberedRoute(threadId) : null;
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
    const remembered = threadId ? this.requestLedger.rememberedRoute(threadId) : null;
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
    return proxyAuxiliaryWebSocket(client, request, route,
      (body, headers) => this.#resolveAuxiliaryTarget(body, headers));
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
          this.networkMonitor.startNetworkMonitor(officialSocket, networkConnectionId);
          resolve(officialSocket);
        };
        const onInitialError = (error) => {
          officialSocket.off("open", onOpen);
          this.networkMonitor.stopNetworkMonitor(networkConnectionId, { unexpected: true });
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
        this.networkMonitor.stopNetworkMonitor(networkConnectionId, { unexpected: !closed });
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
          onUsage: (usage, responseId) => this.requestLedger.recordUsage(context, usage, responseId),
          onToolCall: (call) => this.requestLedger.recordPendingToolCall(context, call),
          onGeneration: (generation) => this.requestLedger.recordGeneration(context, {
            ...generation,
            requestId: context.requestId,
          }),
        });
        let routeClaim = this.requestLedger.activateRequestContext(context);
        const settleRoute = (accepted) => {
          this.requestLedger.settleThreadRoute(routeClaim, accepted);
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
        this.requestLedger.settleThreadRoute(routeClaim, accepted);
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
          onUsage: (usage, responseId) => this.requestLedger.recordUsage(context, usage, responseId),
          onToolCall: (call) => this.requestLedger.recordPendingToolCall(context, call),
          onGeneration: (generation) => this.requestLedger.recordGeneration(context, {
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
          onPrepared: () => { routeClaim = this.requestLedger.activateRequestContext(context); },
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
      ? this.networkMonitor.nearestNetworkSample(measuredConnectionId, effectiveRequestStartedAt)
      : null;
    const generates = body?.generate !== false;
    return {
      target,
      threadId,
      turnId,
      model,
      generates,
      input: body?.input,
      toolInventory: requestToolInventory(body?.tools),
      followsToolResult: containsCallReference(body?.input),
      rolloutUsageFallback,
      requestStartedAt: effectiveRequestStartedAt,
      requestId: randomUUID(),
      networkLatencySupported: Boolean(measuredConnectionId),
      networkConnectionId: measuredConnectionId,
      networkLatency,
    };
  }

  async #forwardResponse(request, response, targetUrl, payload, target, context) {
    return forwardModelResponse(request, response, targetUrl, payload, target, context, {
      onUsage: (usage, responseId) => this.requestLedger.recordUsage(context, usage, responseId),
      onToolCall: call => this.requestLedger.recordPendingToolCall(context, call),
      onGeneration: generation => this.requestLedger.recordGeneration(context, { ...generation, requestId: context.requestId }),
    });
  }

}

export { MODEL_ROUTER_PROVIDER_ID, MODEL_ROUTER_TOKEN_ENV, MODEL_ROUTER_TOKEN_HEADER } from "./model-router/contract.mjs";

export { createResponseObservation } from "./model-router/response-observation.mjs";

export { classifyNetworkLatency } from "./model-router/network-monitor.mjs";
