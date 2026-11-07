import assert from "node:assert/strict";
import test from "node:test";
import { createFormatting } from "../src/widget/formatting.mjs";

test("订阅到期时间显示本地时分秒", () => {
  const { formatExpiry } = createFormatting();
  const iso = "2030-05-06T07:08:09Z";
  const date = new Date(iso);
  const expected = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);

  assert.ok(formatExpiry(iso).endsWith(`（${expected}）`));
  assert.ok(formatExpiry(Math.floor(date.getTime() / 1000)).endsWith(`（${expected}）`));
});
