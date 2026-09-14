#!/usr/bin/env node

import process from "node:process";

import {
  inspectThreadHistoryStore,
  resetThreadHistoryProjection,
} from "../src/lifecycle-history-store.mjs";

const encoded = process.argv.find((argument) => argument.startsWith("--request="))?.slice(10);
if (!encoded) throw new Error("缺少 --request=<base64url-json>");
const request = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
let result;
if (request.operation === "inspect") result = await inspectThreadHistoryStore(request);
else if (request.operation === "reset") result = await resetThreadHistoryProjection(request);
else throw new Error(`未知历史存储操作：${request.operation}`);
process.stdout.write(`${JSON.stringify(result)}\n`);
