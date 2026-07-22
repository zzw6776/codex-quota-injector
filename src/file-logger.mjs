import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { defaultLogDir } from "./platform.mjs";

export function installFileLogger() {
  const logDir = defaultLogDir();
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, "injector.log");

  const write = (level, values) => {
    const message = values.map(formatValue).join(" ");
    appendFileSync(logPath, `${new Date().toISOString()} [${level}] ${message}\n`, "utf8");
  };
  console.log = (...values) => write("info", values);
  console.warn = (...values) => write("warn", values);
  console.error = (...values) => write("error", values);
  process.on("uncaughtException", (error) => write("fatal", [error?.stack ?? error]));
  process.on("unhandledRejection", (error) => write("fatal", [error?.stack ?? error]));
  return logPath;
}

function formatValue(value) {
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
