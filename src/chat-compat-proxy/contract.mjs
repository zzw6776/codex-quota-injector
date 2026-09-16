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

const MAX_CACHED_RESPONSES = 512;

function text(value) {
  return typeof value === "string" ? value : "";
}

export { text, MAX_CACHED_RESPONSES, HOP_BY_HOP_HEADERS };
