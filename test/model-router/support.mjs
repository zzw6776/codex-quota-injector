import { readFile } from "node:fs/promises";
import WebSocket from "ws";

const PLATFORM_ID = "123e4567-e89b-42d3-a456-426614174000";

function routerSettings(origin, overrides = {}) {
  return {
    extraModels: {
      platforms: [{
        id: PLATFORM_ID,
        name: "Test Platform",
        baseUrl: `${origin}/v1/`,
        apiKey: "custom-secret",
        enabled: true,
        models: [{
          id: "custom-model",
          displayName: "Custom Model",
          supportsImage: false,
          reasoningEfforts: ["low", "high"],
          defaultReasoningEffort: "low",
          ...overrides,
        }],
      }],
    },
    officialAuthMode: "apiKey",
  };
}

async function readEvents(path) {
  const content = await readFile(path, "utf8");
  return content.trim().split("\n").map((line) => JSON.parse(line));
}

async function readRequestBuffer(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function openWebSocket(url, options = {}) {
  const socket = new WebSocket(url, options);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function collectWebSocket(socket, terminalCount) {
  const events = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("等待 WebSocket 响应超时")), 2_000);
    socket.on("message", (data) => {
      const value = JSON.parse(data.toString("utf8"));
      events.push(value);
      const count = events.filter((event) =>
        ["response.completed", "response.incomplete", "response.failed"].includes(event.type)
      ).length;
      if (count >= terminalCount) {
        clearTimeout(timer);
        resolve(events);
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export { routerSettings, readRequestBuffer, openWebSocket, readEvents, collectWebSocket };
