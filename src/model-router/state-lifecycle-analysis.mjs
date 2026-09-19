import { turnStateSummaries, uniqueTurnStateSummaries } from "./turn-state.mjs";

const TERMINAL_EVENTS = new Set(["response.completed", "response.incomplete", "response.failed", "error"]);
const CODE_FIELDS = new Set(["status", "status_code", "http_status", "httpStatusCode", "code"]);

function protocolCodes(payload) {
  const found = [];
  for (const [prefix, value] of [["", payload], ["metadata.", payload?.metadata],
    ["client_metadata.", payload?.client_metadata], ["response.", payload?.response],
    ["response.metadata.", payload?.response?.metadata], ["error.", payload?.error],
    ["response.error.", payload?.response?.error]]) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const [field, code] of Object.entries(value)) {
      if (!CODE_FIELDS.has(field)) continue;
      const number = typeof code === "string" && /^\d{3}$/.test(code) ? Number(code) : code;
      if (Number.isInteger(number) && number >= 100 && number <= 599) found.push({ field: `${prefix}${field}`, value: number });
    }
  }
  return found;
}

function requestSummary(event) {
  return {
    line: event.line ?? null,
    sourceFile: event.sourceFile ?? null,
    recordedAt: event.recordedAt ?? null,
    requestId: event.requestId,
    connectionId: event.connectionId ?? null,
    threadId: event.threadId ?? null,
    turnId: event.turnId || event.body?.client_metadata?.turn_id || null,
    model: event.model ?? event.body?.model ?? null,
    transport: event.transport,
    method: event.method,
    endpoint: event.endpoint,
    streamId: event.streamId ?? event.body?.stream_id ?? null,
    generate: event.body?.generate ?? null,
    requestStates: uniqueTurnStateSummaries([
      ...turnStateSummaries(event.headers, "headers"),
      ...turnStateSummaries(event.body, "body"),
    ]),
    responseStates: [],
    httpStatusCode: null,
    responseStatus: null,
    outcome: null,
    protocolCodes: [],
  };
}

function analyzeStateLifecycle(records, { threadId = null, model = null } = {}) {
  const requests = new Map();
  const pendingByConnection = new Map();
  const connectionStates = new Map();
  const parseErrors = [];
  let recordCount = 0;

  const pending = connectionId => {
    if (!connectionId) return [];
    if (!pendingByConnection.has(connectionId)) pendingByConnection.set(connectionId, []);
    return pendingByConnection.get(connectionId);
  };
  const connection = connectionId => {
    if (!connectionId) return null;
    if (!connectionStates.has(connectionId)) connectionStates.set(connectionId, {
      connectionId, requestStates: [], responseStates: [], httpStatusCode: null, openedAt: null, closedAt: null,
    });
    return connectionStates.get(connectionId);
  };
  const addStates = (target, field, summaries) => {
    if (!target || summaries.length === 0) return;
    target[field] = uniqueTurnStateSummaries([...(target[field] ?? []), ...summaries]);
  };
  const targetForMessage = (event, payload) => {
    const queue = pending(event.connectionId);
    if (payload?.stream_id) {
      const exact = queue.map(id => requests.get(id)).find(item => item?.streamId === payload.stream_id);
      if (exact) return exact;
    }
    return requests.get(queue[0]) ?? null;
  };

  for (const event of records) {
    recordCount++;
    if (event.phase === "request") {
      const item = requestSummary(event);
      requests.set(event.requestId, item);
      if (event.transport === "websocket" && event.method === "response.create") pending(event.connectionId).push(event.requestId);
      connection(event.connectionId);
      continue;
    }
    const item = requests.get(event.requestId);
    const conn = connection(event.connectionId);
    if (event.phase === "request-headers") {
      const states = turnStateSummaries(event.headers, "headers");
      addStates(item, "requestStates", states);
      addStates(conn, "requestStates", states);
      continue;
    }
    if (event.phase === "response-headers") {
      const states = turnStateSummaries(event.headers, "headers");
      if (item) item.httpStatusCode = event.httpStatusCode ?? null;
      if (conn && event.transport?.includes("websocket")) {
        conn.httpStatusCode = event.httpStatusCode ?? null;
        conn.openedAt = event.recordedAt ?? conn.openedAt;
      }
      addStates(item, "responseStates", states);
      addStates(conn, "responseStates", states);
      continue;
    }
    if (event.phase === "body-chunk" && event.direction === "response" &&
        event.connectionId && event.transport?.includes("websocket")) {
      let payload;
      try {
        payload = JSON.parse(Buffer.from(event.dataBase64, "base64").toString("utf8"));
      } catch (error) {
        parseErrors.push({ sourceFile: event.sourceFile ?? null, line: event.line ?? null,
          requestId: event.requestId, message: error.message });
        continue;
      }
      const target = targetForMessage(event, payload) ?? item;
      const states = turnStateSummaries(payload, "message");
      addStates(target, "responseStates", states);
      addStates(conn, "responseStates", states);
      const codes = protocolCodes(payload);
      if (target) target.protocolCodes = [...target.protocolCodes, ...codes];
      if (TERMINAL_EVENTS.has(payload.type)) {
        if (target) target.responseStatus = payload.response?.status ?? payload.status ?? null;
        const queue = pending(event.connectionId);
        const index = target ? queue.indexOf(target.requestId) : -1;
        if (index >= 0) queue.splice(index, 1);
      }
      continue;
    }
    if (event.phase === "response-envelope" && item) {
      item.responseStatus = event.responseStatus ?? item.responseStatus;
      item.protocolCodes = [...item.protocolCodes, ...(event.envelopeCodes ?? [])];
      continue;
    }
    if (event.phase === "finished") {
      if (item) {
        item.httpStatusCode = event.httpStatusCode ?? item.httpStatusCode;
        item.responseStatus = event.responseStatus ?? item.responseStatus;
        item.outcome = event.outcome ?? null;
      }
      if (conn && event.transport?.includes("websocket")) conn.closedAt = event.recordedAt ?? conn.closedAt;
    }
  }

  const allRequests = [...requests.values()];
  const selected = allRequests.filter(item => item.transport !== "websocket-handshake" &&
    (!threadId || item.threadId === threadId) && (!model || item.model === model));
  const selectedConnections = new Set(selected.map(item => item.connectionId).filter(Boolean));
  const connections = [...connectionStates.values()].filter(item => selectedConnections.has(item.connectionId));
  const httpStatuses = {};
  const protocol292Or312 = [];
  const states = [];
  for (const item of selected) {
    if (item.httpStatusCode != null) httpStatuses[item.httpStatusCode] = (httpStatuses[item.httpStatusCode] ?? 0) + 1;
    for (const code of item.protocolCodes) if (code.value === 292 || code.value === 312) {
      protocol292Or312.push({ requestId: item.requestId, turnId: item.turnId, ...code });
    }
    states.push(...item.responseStates.map(state => ({ ...state, requestId: item.requestId, turnId: item.turnId,
      model: item.model, connectionId: item.connectionId, recordedAt: item.recordedAt })));
  }
  for (const item of connections) {
    if (item.httpStatusCode != null) httpStatuses[item.httpStatusCode] = (httpStatuses[item.httpStatusCode] ?? 0) + 1;
  }
  const stateHashes = [...new Set(states.map(state => state.sha256))];
  const turns = new Map();
  for (const item of selected) {
    const key = item.turnId ?? "(missing)";
    if (!turns.has(key)) turns.set(key, { turnId: item.turnId, models: new Set(), requestCount: 0,
      requestStateHashes: new Set(), responseStateHashes: new Set(), connectionIds: new Set() });
    const turn = turns.get(key);
    if (item.model) turn.models.add(item.model);
    if (item.connectionId) turn.connectionIds.add(item.connectionId);
    turn.requestCount++;
    item.requestStates.forEach(state => turn.requestStateHashes.add(state.sha256));
    item.responseStates.forEach(state => turn.responseStateHashes.add(state.sha256));
  }
  const serializedTurns = [...turns.values()].map(turn => ({
    turnId: turn.turnId, models: [...turn.models], requestCount: turn.requestCount,
    requestStateHashes: [...turn.requestStateHashes], responseStateHashes: [...turn.responseStateHashes],
    connectionIds: [...turn.connectionIds],
    replayObserved: [...turn.requestStateHashes].some(hash => turn.responseStateHashes.has(hash)),
  }));
  const responseStateCount = selected.reduce((sum, item) => sum + item.responseStates.length, 0);
  const requestStateCount = selected.reduce((sum, item) => sum + item.requestStates.length, 0);
  return {
    schemaVersion: 1,
    containsRawStateValues: false,
    filter: { threadId, model },
    recordCount,
    requestCount: selected.length,
    httpStatuses,
    http292Count: httpStatuses[292] ?? 0,
    http312Count: httpStatuses[312] ?? 0,
    protocol292Or312,
    responseStateCount,
    requestStateCount,
    distinctResponseStateHashes: stateHashes,
    turns: serializedTurns,
    connections,
    requests: selected,
    parseErrors,
  };
}

export { analyzeStateLifecycle };
